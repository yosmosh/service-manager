// Telegram pushes every new message in the group here in real time (a "webhook" —
// the opposite of the reminder crons, which pull app data on a schedule). Each message
// gets written as its OWN document in a separate top-level Firestore collection,
// telegram_messages — deliberately NOT inside appdata/state, which already carries the
// entire app's data and has a hard 1MiB Firestore document-size limit. A 32-person
// active group could produce hundreds of messages a day; appending them to that shared
// document risks breaking saving for the whole app, not just this feature.
//
// api/cron/telegram-digest.js reads this collection once a day to build the digest.
//
// Turning those messages into manager-reviewed SOS/maintenance drafts is NOT done here —
// see api/telegram/build-drafts.js, which groups a whole day of messages into one draft
// per real issue. This file only captures (including each photo's Telegram file_id, so
// build-drafts can fetch every picture belonging to an issue) and handles the one thing
// that has to be live: a "готово" + photo reply attaching proof to a tracked issue.
//
// One-time setup after this is deployed (done once, not on every request):
//   curl "https://api.telegram.org/bot<TOKEN>/setWebhook" \
//     -d "url=https://sad-budushego.ru/api/telegram/webhook" \
//     -d "secret_token=<TELEGRAM_WEBHOOK_SECRET>"
//
// Required Vercel environment variables: TELEGRAM_WEBHOOK_SECRET (Telegram echoes it
// back on every call so this can reject anyone else), TELEGRAM_BOT_TOKEN,
// ANTHROPIC_API_KEY (shared with api/cron/telegram-digest.js — Phase 2b features are
// silently skipped if it's not set).

const FIRESTORE_MESSAGES_URL = 'https://firestore.googleapis.com/v1/projects/sad-budushego/databases/(default)/documents/telegram_messages';
const FIRESTORE_STATE_URL = 'https://firestore.googleapis.com/v1/projects/sad-budushego/databases/(default)/documents/appdata/state';
const FIRESTORE_FILES_REGISTRY_URL = 'https://firestore.googleapis.com/v1/projects/sad-budushego/databases/(default)/documents/appdata/files_registry';
const STORAGE_BUCKET = 'sad-budushego.firebasestorage.app';
const TELEGRAM_CHAT_ID = -1004438968318; // Сад Будущего | Рабочая группа — ignore anything from elsewhere

// Known topic names — extend this as more topics are identified (same technique used
// to find the first two: send "@sad_budushego_bot test" in the topic, read getUpdates).
const TOPIC_NAMES = {
  57: 'Хозчасть и Ремонт',
  34: 'Покупки',
};

// Scoped to this one topic for now — extend to widen it, no other change needed.
const DRAFT_TOPIC_IDS = [57];
const COMPLETION_RE = /готов|сделан|исправ|решен|решён|устранен|устранён|закры|выполнен/i;

function fsString(v) { return { stringValue: v == null ? '' : String(v) }; }
function fsInt(v) { return { integerValue: String(Math.round(v)) }; }
function fsTimestamp(iso) { return { timestampValue: iso }; }
function fsStringArray(arr) { return { arrayValue: { values: (arr || []).map(fsString) } }; }

async function sendTelegramDM(chatId, text) {
  await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

// ---------- Photo pipeline (Phase 2b) ----------
// Downloads a Telegram-hosted photo and re-hosts it in the same Firebase Storage bucket
// the client already uses for every other file upload (dbSave, service-manager.html),
// registering it in appdata/files_registry so the normal file-preview/gallery code in
// the app can show it with no special-casing for "came from Telegram".

async function downloadTelegramFile(fileId) {
  const infoRes = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`);
  const info = await infoRes.json();
  if (!info.ok) return null;
  const filePath = info.result.file_path;
  const fileRes = await fetch(`https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${filePath}`);
  if (!fileRes.ok) return null;
  const buf = Buffer.from(await fileRes.arrayBuffer());
  const ext = (filePath.split('.').pop() || 'jpg').toLowerCase();
  return { buf, ext };
}

async function uploadPhotoToStorage(buf, ext) {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2);
  const name = `files/${id}.${ext}`;
  const mime = ext === 'png' ? 'image/png' : 'image/jpeg';
  const uploadRes = await fetch(`https://firebasestorage.googleapis.com/v0/b/${STORAGE_BUCKET}/o?uploadType=media&name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'Content-Type': mime },
    body: buf,
  });
  const meta = await uploadRes.json();
  if (!meta.downloadTokens) return null;
  const url = `https://firebasestorage.googleapis.com/v0/b/${STORAGE_BUCKET}/o/${encodeURIComponent(name)}?alt=media&token=${meta.downloadTokens}`;
  return { id, name: `telegram-photo.${ext}`, type: mime, size: Number(meta.size) || buf.length, url };
}

async function registerFile(fileMeta) {
  const res = await fetch(`${FIRESTORE_FILES_REGISTRY_URL}?mask.fieldPaths=files`);
  const doc = await res.json();
  const existingFields = (doc.fields && doc.fields.files && doc.fields.files.mapValue.fields) || {};
  const merged = Object.assign({}, existingFields, {
    [fileMeta.id]: { mapValue: { fields: {
      id: fsString(fileMeta.id), name: fsString(fileMeta.name), type: fsString(fileMeta.type),
      size: fsInt(fileMeta.size), url: fsString(fileMeta.url),
    } } },
  });
  await fetch(`${FIRESTORE_FILES_REGISTRY_URL}?updateMask.fieldPaths=files`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ fields: { files: { mapValue: { fields: merged } } } }),
  });
}

async function capturePhotoFromMessage(msg) {
  if (!msg.photo || !msg.photo.length) return null;
  const largest = msg.photo[msg.photo.length - 1];
  const dl = await downloadTelegramFile(largest.file_id);
  if (!dl) return null;
  const meta = await uploadPhotoToStorage(dl.buf, dl.ext);
  if (!meta) return null;
  await registerFile(meta);
  return meta;
}

// ---------- Live handling: attach a completion photo to an issue already tracked ----------
// Grouping a day's messages into drafts happens in api/telegram/build-drafts.js, not here.
// The one thing that must be handled the moment it arrives is someone replying to a
// reported issue with "готово" plus a photo: that photo is the proof the work was done,
// and it gets appended to whatever that issue currently is — a pending draft, or the
// SOS/maintenance record it has since become. It only ever ADDS a photo; changing the
// status stays a human decision. No AI is involved — a keyword test on the reply is enough.
async function attachCompletionPhoto(msg, text) {
  const replyToId = String(msg.reply_to_message.message_id);

  const stateRes = await fetch(`${FIRESTORE_STATE_URL}?mask.fieldPaths=telegram_config&mask.fieldPaths=telegram_drafts&mask.fieldPaths=sos_items&mask.fieldPaths=maint_works`);
  const stateDoc = await stateRes.json();
  const cfgFields = (stateDoc.fields && stateDoc.fields.telegram_config && stateDoc.fields.telegram_config.mapValue.fields) || {};
  const draftsCfg = (cfgFields.drafts && cfgFields.drafts.mapValue && cfgFields.drafts.mapValue.fields) || {};
  if (!draftsCfg.enabled || !draftsCfg.enabled.booleanValue) return { skip: 'drafts disabled' };

  const draftsRaw = (stateDoc.fields && stateDoc.fields.telegram_drafts && stateDoc.fields.telegram_drafts.arrayValue.values) || [];
  const sosRaw = (stateDoc.fields && stateDoc.fields.sos_items && stateDoc.fields.sos_items.arrayValue.values) || [];
  const maintRaw = (stateDoc.fields && stateDoc.fields.maint_works && stateDoc.fields.maint_works.arrayValue.values) || [];

  // A draft (and the record it becomes) carries EVERY message id its issue was built
  // from, so a reply to any message in that thread — not just the first — still matches.
  const idsOf = (f, singleKey, arrayKey) => {
    const out = [];
    if (f[singleKey] && f[singleKey].stringValue) out.push(f[singleKey].stringValue);
    const arr = f[arrayKey] && f[arrayKey].arrayValue && f[arrayKey].arrayValue.values;
    (arr || []).forEach(v => { if (v.stringValue) out.push(v.stringValue); });
    return out;
  };
  const draftIdx = draftsRaw.findIndex(r => idsOf(r.mapValue.fields, 'sourceMessageId', 'sourceMessageIds').includes(replyToId));
  const sosIdx = sosRaw.findIndex(r => idsOf(r.mapValue.fields, 'telegramSourceMessageId', 'telegramSourceMessageIds').includes(replyToId));
  const maintIdx = maintRaw.findIndex(r => idsOf(r.mapValue.fields, 'telegramSourceMessageId', 'telegramSourceMessageIds').includes(replyToId));
  if (draftIdx === -1 && sosIdx === -1 && maintIdx === -1) return { skip: 'reply does not match a tracked issue' };

  const photoMeta = await capturePhotoFromMessage(msg).catch(() => null);
  if (!photoMeta) return { skip: 'photo capture failed' };

  const appendTo = (f) => {
    const ids = ((f.fileIds && f.fileIds.arrayValue.values) || []).map(v => v.stringValue).concat([photoMeta.id]);
    const names = ((f.fileNames && f.fileNames.arrayValue.values) || []).map(v => v.stringValue).concat(['После: ' + photoMeta.name]);
    const types = ((f.fileTypes && f.fileTypes.arrayValue.values) || []).map(v => v.stringValue).concat([photoMeta.type]);
    f.fileIds = fsStringArray(ids);
    f.fileNames = fsStringArray(names);
    f.fileTypes = fsStringArray(types);
  };

  if (draftIdx !== -1) {
    appendTo(draftsRaw[draftIdx].mapValue.fields);
    await fetch(`${FIRESTORE_STATE_URL}?updateMask.fieldPaths=telegram_drafts`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ fields: { telegram_drafts: { arrayValue: { values: draftsRaw } } } }),
    });
    return { action: 'after-photo attached to pending draft' };
  }
  const isSos = sosIdx !== -1;
  const targetRaw = isSos ? sosRaw : maintRaw;
  const fieldName = isSos ? 'sos_items' : 'maint_works';
  appendTo(targetRaw[isSos ? sosIdx : maintIdx].mapValue.fields);
  await fetch(`${FIRESTORE_STATE_URL}?updateMask.fieldPaths=${fieldName}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ fields: { [fieldName]: { arrayValue: { values: targetRaw } } } }),
  });
  return { action: 'after-photo attached to ' + fieldName };
}

// ---------- Digest subscription (Phase 1) ----------

function fsSubscriber(s) {
  return { mapValue: { fields: { chatId: fsString(s.chatId), name: fsString(s.name), subscribedAt: fsString(s.subscribedAt) } } };
}

// Self-service subscribe: anyone who should get the daily digest DMs the bot /start
// with the secret code from Настройки доступа (or taps the owner's t.me/…?start=CODE
// link, which sends the same thing) — this adds their chat_id to
// telegram_config.digest.subscribers. Without the correct code nothing is added, so a
// stranger who finds the bot by its public username can't subscribe themselves to
// internal group summaries.
async function handleStartDM(msg) {
  const chatId = String(msg.chat.id);
  const parts = (msg.text || '').trim().split(/\s+/);
  const payload = parts.length > 1 ? parts.slice(1).join(' ') : '';
  const name = [msg.from && msg.from.first_name, msg.from && msg.from.last_name].filter(Boolean).join(' ')
    || (msg.from && msg.from.username) || chatId;

  const stateRes = await fetch(`${FIRESTORE_STATE_URL}?mask.fieldPaths=telegram_config`);
  const stateDoc = await stateRes.json();
  const raw = stateDoc.fields && stateDoc.fields.telegram_config;
  const topFields = (raw && raw.mapValue && raw.mapValue.fields) || {};
  const digestFields = (topFields.digest && topFields.digest.mapValue && topFields.digest.mapValue.fields) || {};
  const configuredCode = (digestFields.code && digestFields.code.stringValue) || '';

  if (!configuredCode || payload !== configuredCode) {
    await sendTelegramDM(chatId, '⛔ Неверный или отсутствующий код доступа. Эта подписка только по персональной ссылке от руководителя.');
    return;
  }

  const subsRaw = (digestFields.subscribers && digestFields.subscribers.arrayValue && digestFields.subscribers.arrayValue.values) || [];
  const existing = subsRaw.map(v => {
    const f = v.mapValue.fields;
    return { chatId: f.chatId.stringValue, name: f.name.stringValue, subscribedAt: f.subscribedAt.stringValue };
  });
  const alreadyIn = existing.some(s => s.chatId === chatId);
  const newSubs = alreadyIn ? existing : existing.concat([{ chatId, name, subscribedAt: new Date().toISOString() }]);

  if (!alreadyIn) {
    const mergedDigest = Object.assign({}, digestFields, { subscribers: { arrayValue: { values: newSubs.map(fsSubscriber) } } });
    const mergedTop = Object.assign({}, topFields, { digest: { mapValue: { fields: mergedDigest } } });
    await fetch(`${FIRESTORE_STATE_URL}?updateMask.fieldPaths=telegram_config`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ fields: { telegram_config: { mapValue: { fields: mergedTop } } } }),
    });
  }

  await sendTelegramDM(chatId, alreadyIn
    ? '✅ Вы уже подписаны на дайджест — сводка приходит вам ежедневно.'
    : '✅ Готово! Теперь вы будете получать ежедневный дайджест сюда, в личные сообщения.');
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(200).json({ ok: true }); // Telegram only ever POSTs; respond harmlessly to anything else
    return;
  }
  if (process.env.TELEGRAM_WEBHOOK_SECRET) {
    const secret = req.headers['x-telegram-bot-api-secret-token'];
    if (secret !== process.env.TELEGRAM_WEBHOOK_SECRET) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
  }

  try {
    const update = req.body || {};
    const msg = update.message;
    // Always 200 back to Telegram even when we skip a message — a non-200 makes
    // Telegram retry the same update repeatedly, which we don't want for "nothing to do".
    // A photo-only/photo+caption message has no msg.text (Telegram puts that under
    // msg.photo/msg.caption instead) — accept either.
    if (!msg || !msg.chat || (!msg.text && !msg.photo)) {
      res.status(200).json({ ok: true, skipped: true });
      return;
    }

    if (msg.chat.type === 'private' && (msg.text || '').trim().toLowerCase().startsWith('/start')) {
      await handleStartDM(msg);
      res.status(200).json({ ok: true, start: true });
      return;
    }

    if (msg.chat.id !== TELEGRAM_CHAT_ID) {
      res.status(200).json({ ok: true, skipped: true });
      return;
    }

    const topicId = msg.message_thread_id || 0;
    const topicName = TOPIC_NAMES[topicId] || `Тема #${topicId}`;
    // An anonymous "post as the group" message carries the real sender's name in
    // author_signature instead of a normal `from` user.
    const fromName = msg.author_signature || (msg.from && (msg.from.first_name || msg.from.username)) || 'Неизвестно';
    const dateIso = new Date((msg.date || 0) * 1000).toISOString();
    const text = (msg.text || msg.caption || '').trim();

    // The largest photo's file_id is stored (not the photo itself) so that
    // api/telegram/build-drafts.js can fetch every picture belonging to an issue when it
    // later groups a day's messages into drafts. Telegram sends each photo of an album as
    // its OWN message sharing a media_group_id, and only one of them carries the caption —
    // keeping both fields is what lets the whole album end up on the right draft.
    const photo = (msg.photo && msg.photo.length) ? msg.photo[msg.photo.length - 1] : null;
    const body = {
      fields: {
        topicId: fsInt(topicId),
        topicName: fsString(topicName),
        fromName: fsString(fromName),
        text: fsString(text),
        date: fsTimestamp(dateIso),
        messageId: fsInt(msg.message_id),
        photoFileId: fsString(photo ? photo.file_id : ''),
        mediaGroupId: fsString(msg.media_group_id || ''),
      },
    };
    await fetch(FIRESTORE_MESSAGES_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
    });

    // Drafting itself is NOT done here any more — one message rarely tells the whole
    // story, and doing it per-message produced thin, fragmented drafts that each quoted a
    // single line and dropped the rest of the thread (and the album's other photos).
    // api/telegram/build-drafts.js now groups a whole day of messages into one draft per
    // real issue. The only thing still handled live is a "готово" + photo reply on an
    // issue already being tracked, which just attaches the proof photo (no AI involved).
    let draftDebug = null;
    if (!(msg.from && msg.from.is_bot) && DRAFT_TOPIC_IDS.includes(topicId) && msg.reply_to_message && msg.reply_to_message.message_id && msg.photo && COMPLETION_RE.test(text)) {
      try { draftDebug = await attachCompletionPhoto(msg, text); }
      catch (e) { draftDebug = { error: String(e && e.stack || e) }; }
    }

    res.status(200).json({ ok: true, draftDebug });
  } catch (e) {
    // Still 200 — an error here shouldn't make Telegram hammer us with retries.
    res.status(200).json({ ok: false, error: String(e && e.message || e) });
  }
};
