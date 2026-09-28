// Groups a day of "Хозчасть и Ремонт" messages into manager-reviewed drafts.
//
// This replaced the original per-message drafting, which quoted one line and dropped the
// rest of the thread: a real issue is usually several messages by several people ("когда
// будет сделана дверка?" + "Синий 36 дверь так и не сделана"), often with photos arriving
// as their own separate messages (Telegram sends every photo of an album as its own
// message, and only one of them carries the caption). So instead of reacting to single
// messages, this reads everything the webhook captured, asks Claude to CLUSTER it into
// distinct real issues, and writes ONE draft per issue — carrying every message's text
// and every photo attached to any message in that cluster.
//
// Nothing is ever created directly as an SOS/maintenance record: drafts land in
// telegram_drafts for the owner to approve or reject in the app, same as before.
//
// Runs two ways:
//   - a frequent Vercel cron, which only pays for an AI call when there are actually new
//     messages that have gone quiet (SETTLE_MINUTES) — it returns before the model call
//     when the group is idle, so a quiet day costs nothing, and
//   - the "Проверить Telegram" button in the app (force=1, skipping the settle wait); that
//     path is unauthenticated, so it is throttled server-side (THROTTLE_MINUTES) to stop
//     anyone burning AI credits by hammering the URL.
//
// Required Vercel environment variables: TELEGRAM_BOT_TOKEN, ANTHROPIC_API_KEY, CRON_SECRET.

const {
  fsString, fsStringArray, readDoc, updateDoc, registerFiles, acquireLease, releaseLease,
} = require('../_lib/firestore');
const { DRAFTS_LEASE_DOC, signalAfterCheck, nudgeGate } = require('../_lib/drafts-signal');

const FIRESTORE_QUERY_URL = 'https://firestore.googleapis.com/v1/projects/sad-budushego/databases/(default)/documents:runQuery';
const STORAGE_BUCKET = 'sad-budushego.firebasestorage.app';
const TELEGRAM_CHAT_ID = -1004438968318;

const DRAFT_TOPIC_IDS = [57]; // Хозчасть и Ремонт
const LOOKBACK_HOURS = 24;
const THROTTLE_MINUTES = 10;
// A worker reporting something usually sends a burst — the sentence, then a photo, then
// the missing detail — so messages are left alone until they have been quiet this long.
// Reacting to the first line instead would have the bot asking for information the worker
// was already typing. The frequent cron therefore lags reality by a few minutes on
// purpose; the app's own button passes force=1 to skip the wait.
const SETTLE_MINUTES = 8;

// Only one run at a time. Every message in the group nudges this endpoint, and a run takes
// tens of seconds (the AI call, the photos) — so before this, a burst of messages started
// several overlapping runs that each drafted the same messages and each asked the worker the
// same question. The lease outlives the function's 60s maxDuration, so a live run can't lose
// it, and it expires on its own so a run that dies can't block the next one for long.
const LEASE_DOC = DRAFTS_LEASE_DOC; // shared with the webhook, which writes the pending signal
const LEASE_TTL_MS = 90000;
// At most this many messages per run. A single answer has to fit in the model's output and
// in the function's 60s — an unbounded day could produce an answer that is truncated every
// time, fail every time, and never let anything through. The rest go to the next run (the
// drafts already made are passed back as context, so a thread split across runs is joined).
const MAX_BATCH = 40;

// Reads the last LOOKBACK_HOURS of captured messages. Filtering by topic is done here in
// JS rather than in the query: combining a topicId filter with an orderBy on date needs a
// composite Firestore index, and there is no reason to require one for this volume.
async function fetchRecentMessages(sinceIso) {
  const body = {
    structuredQuery: {
      from: [{ collectionId: 'telegram_messages' }],
      where: { fieldFilter: { field: { fieldPath: 'date' }, op: 'GREATER_THAN_OR_EQUAL', value: { timestampValue: sinceIso } } },
      orderBy: [{ field: { fieldPath: 'date' }, direction: 'ASCENDING' }],
    },
  };
  const res = await fetch(FIRESTORE_QUERY_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(body),
  });
  const rows = await res.json();
  // A failed query must not look like an empty window: the processed-id list is pruned to
  // the messages found here, so "no messages" would wrongly forget everything processed.
  if (!res.ok || !Array.isArray(rows)) throw new Error('telegram_messages query failed: ' + JSON.stringify(rows).slice(0, 200));
  return rows.filter(r => r.document).map(r => {
    const f = r.document.fields || {};
    return {
      messageId: f.messageId ? String(f.messageId.integerValue) : '',
      topicId: f.topicId ? Number(f.topicId.integerValue) : 0,
      topicName: (f.topicName && f.topicName.stringValue) || '',
      fromName: (f.fromName && f.fromName.stringValue) || '',
      text: (f.text && f.text.stringValue) || '',
      date: (f.date && f.date.timestampValue) || '',
      photoFileId: (f.photoFileId && f.photoFileId.stringValue) || '',
      replyToMessageId: (f.replyToMessageId && f.replyToMessageId.stringValue) || '',
    };
  });
}

// ---------- Photo pipeline (same storage + registry the app's own uploads use) ----------

async function downloadTelegramFile(fileId) {
  const infoRes = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`);
  const info = await infoRes.json();
  if (!info.ok) return null;
  const filePath = info.result.file_path;
  const fileRes = await fetch(`https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${filePath}`);
  if (!fileRes.ok) return null;
  return { buf: Buffer.from(await fileRes.arrayBuffer()), ext: (filePath.split('.').pop() || 'jpg').toLowerCase() };
}

async function uploadPhotoToStorage(buf, ext) {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2);
  const name = `files/${id}.${ext}`;
  const mime = ext === 'png' ? 'image/png' : 'image/jpeg';
  const uploadRes = await fetch(`https://firebasestorage.googleapis.com/v0/b/${STORAGE_BUCKET}/o?uploadType=media&name=${encodeURIComponent(name)}`, {
    method: 'POST', headers: { 'Content-Type': mime }, body: buf,
  });
  const meta = await uploadRes.json();
  if (!meta.downloadTokens) return null;
  const url = `https://firebasestorage.googleapis.com/v0/b/${STORAGE_BUCKET}/o/${encodeURIComponent(name)}?alt=media&token=${meta.downloadTokens}`;
  return { id, name: `telegram-photo.${ext}`, type: mime, size: Number(meta.size) || buf.length, url };
}

// ---------- Clustering ----------

async function clusterIssues(messages, openDrafts) {
  const transcript = messages.map(m => {
    const label = m.text ? m.text : '(фото без текста)';
    const replyTo = m.replyToMessageId ? ` (ответ на сообщение ${m.replyToMessageId})` : '';
    return `[${m.messageId}] ${m.fromName}${replyTo}: ${label}${m.photoFileId && m.text ? ' (+ фото)' : ''}`;
  }).join('\n');

  // Already-open drafts travel with the request so a late reply lands on the issue it
  // belongs to. Without this the bot asks a question, the worker answers the next day,
  // and that answer arrives here with its original messages already marked processed —
  // i.e. as one context-free line that reads like a brand-new, nonsensical issue.
  const draftsContext = openDrafts.length
    ? '\n\nУЖЕ ОТКРЫТЫЕ ЧЕРНОВИКИ (созданы ранее из предыдущих сообщений, ещё не обработаны руководителем):\n'
      + openDrafts.map(d => `{draftId:"${d.id}"} ${d.title}\n  Обсуждение: ${(d.sourceText || '').replace(/\n/g, ' | ')}`
        + (d.askedQuestion ? `\n  Бот уже спросил: "${d.askedQuestion}"` : '')).join('\n')
    : '';

  const prompt = 'Ниже сообщения за последние сутки из рабочей Telegram-группы учреждения, тема "Хозчасть и Ремонт". У каждого сообщения свой номер в квадратных скобках.\n\n'
    + transcript
    + draftsContext
    + '\n\nСгруппируй НОВЫЕ сообщения по РЕАЛЬНЫМ рабочим вопросам (поломка, неисправность, потребность в ремонте или обслуживании). Правила группировки:\n'
    + '- Одна проблема = одна группа, даже если про неё писали несколько сообщений подряд, несколько раз или разные люди (например вопрос и напоминание об одном и том же — это ОДНА группа).\n'
    + '- Ответы, уточнения, ссылки на товар для этой же проблемы и фотографии этой же проблемы входят в ТУ ЖЕ группу.\n'
    + '- Сообщение "(фото без текста)" отнеси к той группе, к которой оно относится по контексту соседних сообщений и времени.\n'
    + '- ВАЖНО: если новое сообщение продолжает или отвечает на один из УЖЕ ОТКРЫТЫХ ЧЕРНОВИКОВ выше (например это ответ на вопрос бота, уточнение места, или присланное позже фото той же проблемы) — НЕ создавай новую группу, а укажи "updatesDraftId" с его draftId.\n'
    + '- Сообщения, не относящиеся ни к какой конкретной рабочей проблеме (приветствия, благодарности, общая болтовня, обсуждение бота), НЕ включай ни в одну группу.\n'
    + '- Если реальных рабочих вопросов нет вообще — верни пустой массив [].\n\n'
    + 'Верни ТОЛЬКО JSON-массив без комментариев, в этом формате:\n'
    + '[{"messageIds":["1385","1386"],"updatesDraftId":"","type":"maintenance","title":"...","description":"...","priority":"medium","category":"repair","sufficient":true,"clarifyingQuestion":""}]\n\n'
    + 'Поля:\n'
    + '- updatesDraftId: draftId уже открытого черновика, если эти сообщения дополняют его. Иначе пустая строка (новая проблема).\n'
    + '- type: "sos" если срочно/опасно/блокирует работу прямо сейчас, иначе "maintenance".\n'
    + '- title: короткий заголовок (до 60 символов).\n'
    + '- description: СВОДКА всего обсуждения по этому вопросу — что случилось, где, что уже сделано или сказано, что требуется. Не копируй одно сообщение, а объедини смысл всех сообщений группы. Если это обновление черновика — включи в сводку и старую информацию, и новую.\n'
    + '- priority: high/medium/low. category: landscaping/cleaning/repair/electrical/plumbing/security/other.\n'
    + '- sufficient: false если для заведения заявки не хватает важной информации (что именно, где, какой объект).\n'
    + '- clarifyingQuestion: если sufficient=false — короткий вопрос по-русски, который стоит задать сотруднику. Иначе пустая строка.';

  // Sonnet 5 runs adaptive thinking by default, and thinking tokens count against
  // max_tokens — the old cap of 2048 could be mostly spent thinking before the JSON was
  // written, truncating it. 16000 is the documented default for a non-streaming request.
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 16000, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!resp.ok) throw new Error(`Anthropic ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  const data = await resp.json();
  // Anything but a clean finish is a failure, never "no issues found". The caller marks
  // every analysed message as processed, so returning [] for a truncated or refused answer
  // (as this used to) permanently discarded those workers' reports with no error anywhere.
  // Throwing leaves them unprocessed for the next run. No tools or stop sequences are sent,
  // so a successful answer can only end with end_turn.
  if (data.stop_reason !== 'end_turn') throw new Error(`clustering did not finish: stop_reason=${data.stop_reason}`);
  // Sonnet 5 can put a thinking block before the text block, so pick by type.
  const textBlock = (data.content || []).find(b => b.type === 'text');
  const raw = ((textBlock && textBlock.text) || '').trim();
  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) throw new Error('clustering returned no JSON array: ' + raw.slice(0, 200));
  let parsed;
  try { parsed = JSON.parse(match[0]); } catch (e) { throw new Error('clustering JSON unparseable: ' + e.message); }
  if (!Array.isArray(parsed)) throw new Error('clustering result is not an array');
  return parsed; // a genuinely empty array is the only real "no issues"
}

async function sendTelegramReply(topicId, replyToMessageId, text) {
  await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, message_thread_id: topicId, reply_to_message_id: Number(replyToMessageId), text }),
  });
}

function fsDraftEntry(d) {
  return { mapValue: { fields: {
    id: fsString(d.id), type: fsString(d.type), title: fsString(d.title), description: fsString(d.description),
    priority: fsString(d.priority), category: fsString(d.category),
    sourceText: fsString(d.sourceText), sourceFrom: fsString(d.sourceFrom), sourceTopic: fsString(d.sourceTopic),
    sourceDate: fsString(d.sourceDate),
    sourceMessageId: fsString(d.sourceMessageIds[0] || ''),
    sourceMessageIds: fsStringArray(d.sourceMessageIds),
    status: fsString('pending'), createdAt: fsString(d.createdAt), askedQuestion: fsString(d.askedQuestion),
    fileIds: fsStringArray(d.fileIds), fileNames: fsStringArray(d.fileNames), fileTypes: fsStringArray(d.fileTypes),
  } } };
}


// What telegram_drafts and telegram_processed_ids should be after this run, computed from
// the document's fields as they are AT WRITE TIME. Pure — updateDoc may call it more than
// once (after losing a race), so nothing here sends or uploads; the questions to post are
// returned instead of sent.
//
// The old code instead wrote back the drafts list it had read at the very start, before the
// AI call and the photo downloads (tens of seconds). A draft the manager approved or rejected
// in the meantime was therefore restored — and could be approved a second time, creating a
// duplicate SOS/maintenance record.
function applyDraftPlan(fields, plan) {
  const current = (fields.telegram_drafts && fields.telegram_drafts.arrayValue
    && fields.telegram_drafts.arrayValue.values) || [];
  const byId = new Map();
  const withoutId = [];
  current.forEach(v => {
    const f = v && v.mapValue && v.mapValue.fields;
    const id = f && f.id && f.id.stringValue;
    if (id) byId.set(id, v); else withoutId.push(v);
  });
  const strs = (f, k) => ((f[k] && f[k].arrayValue && f[k].arrayValue.values) || []).map(x => x.stringValue);
  const toAsk = [];

  plan.updates.forEach(u => {
    const v = byId.get(u.draftId);
    if (!v) return; // approved or rejected since — never bring it back
    const f = JSON.parse(JSON.stringify(v.mapValue.fields));
    f.sourceMessageIds = fsStringArray([...new Set(strs(f, 'sourceMessageIds').concat(u.messageIds))]);
    f.sourceText = fsString(((f.sourceText && f.sourceText.stringValue) || '') + '\n' + u.sourceText);
    if (u.description) f.description = fsString(u.description);
    if (u.title) f.title = fsString(u.title);
    if (u.priority) f.priority = fsString(u.priority);
    if (u.files.ids.length) {
      f.fileIds = fsStringArray(strs(f, 'fileIds').concat(u.files.ids));
      f.fileNames = fsStringArray(strs(f, 'fileNames').concat(u.files.names));
      f.fileTypes = fsStringArray(strs(f, 'fileTypes').concat(u.files.types));
    }
    // At most one question per draft, judged against the draft as it is now.
    if (u.question && !(f.askedQuestion && f.askedQuestion.stringValue)) {
      f.askedQuestion = fsString(u.question);
      toAsk.push({ topicId: u.topicId, replyTo: u.replyTo, text: u.question });
    }
    byId.set(u.draftId, { mapValue: { fields: f } });
  });

  plan.newDrafts.forEach(d => {
    if (byId.has(d.id)) return;
    byId.set(d.id, fsDraftEntry(Object.assign({}, d, { askedQuestion: d.question || '' })));
    if (d.question) toAsk.push({ topicId: d.topicId, replyTo: d.sourceMessageIds[0], text: d.question });
  });

  // Processed ids are kept exactly as long as their message is still inside the look-back
  // window — the only time it could be picked up again — rather than by a fixed count, which
  // on a busy day evicted ids still inside the window and got those messages drafted twice.
  const already = ((fields.telegram_processed_ids && fields.telegram_processed_ids.arrayValue
    && fields.telegram_processed_ids.arrayValue.values) || []).map(v => v.stringValue);
  const processed = [...new Set(already.concat(plan.processedAdd))].filter(id => plan.windowIds.has(id));

  return {
    out: {
      telegram_drafts: { arrayValue: { values: [...byId.values()].concat(withoutId) } },
      telegram_processed_ids: fsStringArray(processed),
    },
    toAsk,
  };
}

module.exports = async (req, res) => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) { res.status(500).json({ error: 'TELEGRAM_BOT_TOKEN not configured' }); return; }
  if (!process.env.ANTHROPIC_API_KEY) { res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' }); return; }

  const isCron = !!process.env.CRON_SECRET && (req.headers['authorization'] || '') === `Bearer ${process.env.CRON_SECRET}`;
  const dryRun = req.query && (req.query.dryRun === '1' || req.query.dryRun === 'true');
  const force = req.query && (req.query.force === '1' || req.query.force === 'true');
  const holder = 'run-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  let leaseHeld = false;

  try {
    // Everything here is ordered cheapest-first, because this runs on every message in the
    // group. The lease document answers the common case — nothing to do — in one read.
    const lease = await readDoc(LEASE_DOC, ['leaseUntil', 'lastRunAt', 'pendingSince', 'lastWatchedAt']);
    const leaseUntil = lease.fields.leaseUntil ? Date.parse(lease.fields.leaseUntil.stringValue) : 0;
    if (!dryRun && leaseUntil > Date.now()) {
      res.status(200).json({ ok: true, skipped: 'another run is in progress' });
      return;
    }
    // A plain nudge only goes on if a watched-topic message is waiting and has settled. The
    // daily cron and the app's button always do the full check (they also re-sync the signal).
    if (!isCron && !force && !dryRun) {
      const gate = nudgeGate(lease.fields, Date.now(), SETTLE_MINUTES * 60000);
      if (!gate.go) {
        res.status(200).json({ ok: true, skipped: gate.reason });
        return;
      }
    }
    // Throttle for the manual/nudge path only — the daily cron always runs.
    const lastRunIso = (lease.fields.lastRunAt && lease.fields.lastRunAt.stringValue) || '';
    if (!isCron && !dryRun && lastRunIso) {
      const minsSince = (Date.now() - Date.parse(lastRunIso)) / 60000;
      if (minsSince < THROTTLE_MINUTES) {
        res.status(200).json({ ok: true, skipped: 'throttled', minutesUntilNextRun: Math.ceil(THROTTLE_MINUTES - minsSince) });
        return;
      }
    }

    const cfg = await readDoc('appdata/state', ['telegram_config']);
    const cfgFields = (cfg.fields.telegram_config && cfg.fields.telegram_config.mapValue.fields) || {};
    const draftsCfg = (cfgFields.drafts && cfgFields.drafts.mapValue && cfgFields.drafts.mapValue.fields) || {};
    if (!draftsCfg.enabled || !draftsCfg.enabled.booleanValue) {
      res.status(200).json({ ok: true, skipped: 'drafts disabled in telegram_config' });
      return;
    }

    // Taken before the query starts: a message captured while it runs must count as
    // "after the fetch", or the signal could be cleared without that message being seen.
    const fetchMs = Date.now();
    const all = await fetchRecentMessages(new Date(fetchMs - LOOKBACK_HOURS * 3600000).toISOString());
    const windowIds = new Set(all.map(m => m.messageId).filter(Boolean));
    const settleBefore = Date.now() - SETTLE_MINUTES * 60000;
    const readWork = async () => {
      const d = await readDoc('appdata/state', ['telegram_drafts', 'telegram_processed_ids']);
      const done = new Set(((d.fields.telegram_processed_ids && d.fields.telegram_processed_ids.arrayValue
        && d.fields.telegram_processed_ids.arrayValue.values) || []).map(v => v.stringValue));
      const fresh = all.filter(m => DRAFT_TOPIC_IDS.includes(m.topicId) && m.messageId && !done.has(m.messageId)
        && (force || !m.date || new Date(m.date).getTime() <= settleBefore));
      return { fields: d.fields, fresh, done };
    };
    // Re-point the pending signal at whatever this check leaves unprocessed (still settling,
    // or beyond this run's batch). Best-effort: a stale signal only costs one extra check,
    // after which it corrects itself.
    const updateSignal = async doneSet => {
      if (dryRun) return;
      let oldest = null;
      all.forEach(m => {
        if (!DRAFT_TOPIC_IDS.includes(m.topicId) || !m.messageId || doneSet.has(m.messageId)) return;
        const t = m.date ? Date.parse(m.date) : NaN;
        if (!isNaN(t) && (oldest == null || t < oldest)) oldest = t;
      });
      try { await updateDoc(LEASE_DOC, ['lastWatchedAt', 'pendingSince'], f => signalAfterCheck(f, oldest, fetchMs)); }
      catch (e) { /* see above */ }
    };

    let work = await readWork();
    if (!work.fresh.length) {
      await updateSignal(work.done);
      res.status(200).json({ ok: true, created: 0, note: 'no new messages in the watched topic' });
      return;
    }
    if (!dryRun) {
      leaseHeld = await acquireLease(LEASE_DOC, holder, LEASE_TTL_MS);
      if (!leaseHeld) {
        res.status(200).json({ ok: true, skipped: 'another run is in progress' });
        return;
      }
      // Re-read under the lease: a run that finished between the check above and now may
      // already have processed exactly these messages.
      work = await readWork();
      if (!work.fresh.length) {
        await updateSignal(work.done);
        res.status(200).json({ ok: true, created: 0, note: 'no new messages in the watched topic' });
        return;
      }
    }
    const fresh = work.fresh.slice(0, MAX_BATCH); // oldest first — the query is date-ascending

    // The drafts still waiting for the owner, passed to the model as context so a reply that
    // arrives after its issue was already drafted updates that draft instead of becoming a
    // stray new one.
    const draftsRaw = (work.fields.telegram_drafts && work.fields.telegram_drafts.arrayValue
      && work.fields.telegram_drafts.arrayValue.values) || [];
    const openDrafts = draftsRaw.map(r => {
      const f = (r.mapValue && r.mapValue.fields) || {};
      return {
        id: (f.id && f.id.stringValue) || '',
        title: (f.title && f.title.stringValue) || '',
        sourceText: (f.sourceText && f.sourceText.stringValue) || '',
        askedQuestion: (f.askedQuestion && f.askedQuestion.stringValue) || '',
      };
    }).filter(d => d.id);
    const openIds = new Set(openDrafts.map(d => d.id));

    const issues = await clusterIssues(fresh, openDrafts);
    const byMsg = {};
    fresh.forEach(m => { byMsg[m.messageId] = m; });

    // Every message seen this run is marked processed — including ones Claude decided were
    // not a real issue — so they are never re-analysed or re-asked about.
    const plan = { newDrafts: [], updates: [], processedAdd: fresh.map(m => m.messageId), windowIds };
    const summary = [];
    for (const issue of issues) {
      const ids = (issue.messageIds || []).map(String).filter(id => byMsg[id]);
      if (!ids.length) continue;
      const msgs = ids.map(id => byMsg[id]);

      // Every photo attached to ANY message of this issue, in message order.
      const metas = [];
      if (!dryRun) {
        for (const m of msgs) {
          if (!m.photoFileId) continue;
          try {
            const dl = await downloadTelegramFile(m.photoFileId);
            if (!dl) continue;
            const meta = await uploadPhotoToStorage(dl.buf, dl.ext);
            if (meta) metas.push(meta);
          } catch (e) { /* one unavailable photo shouldn't lose the whole issue */ }
        }
        await registerFiles(metas);
      }
      const files = { ids: metas.map(m => m.id), names: metas.map(m => m.name), types: metas.map(m => m.type) };
      const sourceText = msgs.map(m => `${m.fromName}: ${m.text || '(фото)'}`).join('\n');
      const question = (issue.sufficient === false && issue.clarifyingQuestion) ? String(issue.clarifyingQuestion) : '';

      if (issue.updatesDraftId && openIds.has(issue.updatesDraftId)) {
        plan.updates.push({
          draftId: issue.updatesDraftId, messageIds: ids, sourceText,
          description: issue.description || '', title: (issue.title || '').slice(0, 120),
          priority: ['high', 'medium', 'low'].includes(issue.priority) ? issue.priority : '',
          files, question, topicId: msgs[0].topicId, replyTo: ids[0],
        });
        summary.push({ updated: issue.updatesDraftId, title: issue.title, messageIds: ids, photos: metas.length });
        continue;
      }
      plan.newDrafts.push({
        id: String(Date.now()) + Math.random().toString(36).slice(2, 6),
        type: issue.type === 'sos' ? 'sos' : 'maintenance',
        title: (issue.title || '').slice(0, 120),
        description: issue.description || '',
        priority: ['high', 'medium', 'low'].includes(issue.priority) ? issue.priority : 'medium',
        category: issue.category || 'other',
        sourceText,
        sourceFrom: [...new Set(msgs.map(m => m.fromName).filter(Boolean))].join(', '),
        sourceTopic: msgs[0].topicName, sourceDate: msgs[0].date,
        sourceMessageIds: ids,
        createdAt: new Date().toISOString(),
        fileIds: files.ids, fileNames: files.names, fileTypes: files.types,
        question, topicId: msgs[0].topicId,
      });
      summary.push({ title: issue.title, type: issue.type, messageIds: ids, photos: metas.length, asked: !!question });
    }

    if (!dryRun) {
      let toAsk = [];
      await updateDoc('appdata/state', ['telegram_drafts', 'telegram_processed_ids'], fields => {
        const r = applyDraftPlan(fields, plan);
        toAsk = r.toAsk;
        return r.out;
      });
      // Questions go out only once the drafts are safely written, so a run that dies before
      // that point leaves no question behind for the next run to ask a second time.
      for (const q of toAsk) {
        try { await sendTelegramReply(q.topicId, q.replyTo, q.text); } catch (e) { /* draft already records it */ }
      }
      // Anything still unprocessed — messages still settling, or beyond this batch — keeps
      // the signal pointing at it so the next nudge picks it up.
      await updateSignal(new Set([...work.done, ...plan.processedAdd]));
      await releaseLease(LEASE_DOC, holder, { lastRunAt: fsString(new Date().toISOString()) });
      leaseHeld = false;
    }

    res.status(200).json({ ok: true, dryRun: !!dryRun, analysed: fresh.length, created: plan.newDrafts.length, issues: summary });
  } catch (e) {
    res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  } finally {
    // Any exit that didn't complete the run hands the lease straight back rather than making
    // the next run wait out the timeout — without recording a completed run.
    if (leaseHeld) { try { await releaseLease(LEASE_DOC, holder); } catch (e) { /* expires anyway */ } }
  }
};

// Exposed for tests only.
module.exports.applyDraftPlan = applyDraftPlan;
module.exports.clusterIssues = clusterIssues;
