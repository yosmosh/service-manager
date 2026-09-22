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

const FIRESTORE_STATE_URL = 'https://firestore.googleapis.com/v1/projects/sad-budushego/databases/(default)/documents/appdata/state';
const FIRESTORE_FILES_REGISTRY_URL = 'https://firestore.googleapis.com/v1/projects/sad-budushego/databases/(default)/documents/appdata/files_registry';
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
const PROCESSED_CAP = 800; // ids remembered so the same messages never produce a second draft

function fsString(v) { return { stringValue: v == null ? '' : String(v) }; }
function fsInt(v) { return { integerValue: String(Math.round(v)) }; }
function fsStringArray(arr) { return { arrayValue: { values: (arr || []).map(fsString) } }; }

async function fsGetState(fields) {
  const mask = fields.map(f => `mask.fieldPaths=${f}`).join('&');
  const r = await fetch(`${FIRESTORE_STATE_URL}?${mask}`);
  return r.json();
}
async function fsPatchState(fieldValues) {
  const mask = Object.keys(fieldValues).map(f => `updateMask.fieldPaths=${f}`).join('&');
  const r = await fetch(`${FIRESTORE_STATE_URL}?${mask}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ fields: fieldValues }),
  });
  return r.json();
}

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
  return (Array.isArray(rows) ? rows : []).filter(r => r.document).map(r => {
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

// One read-modify-write for the whole batch — registering photos one at a time would race
// with itself when an issue carries several pictures.
async function registerFiles(metas) {
  if (!metas.length) return;
  const res = await fetch(`${FIRESTORE_FILES_REGISTRY_URL}?mask.fieldPaths=files`);
  const doc = await res.json();
  const merged = Object.assign({}, (doc.fields && doc.fields.files && doc.fields.files.mapValue.fields) || {});
  metas.forEach(m => {
    merged[m.id] = { mapValue: { fields: {
      id: fsString(m.id), name: fsString(m.name), type: fsString(m.type), size: fsInt(m.size), url: fsString(m.url),
    } } };
  });
  await fetch(`${FIRESTORE_FILES_REGISTRY_URL}?updateMask.fieldPaths=files`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ fields: { files: { mapValue: { fields: merged } } } }),
  });
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

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'claude-sonnet-5', max_tokens: 2048, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!resp.ok) throw new Error(`Anthropic ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  const data = await resp.json();
  // Sonnet 5 can put an extended-thinking block before the text block, so pick by type.
  const textBlock = (data.content || []).find(b => b.type === 'text');
  const raw = ((textBlock && textBlock.text) || '').trim();
  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try { return JSON.parse(match[0]); } catch (e) { return []; }
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

module.exports = async (req, res) => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) { res.status(500).json({ error: 'TELEGRAM_BOT_TOKEN not configured' }); return; }
  if (!process.env.ANTHROPIC_API_KEY) { res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' }); return; }

  const isCron = !!process.env.CRON_SECRET && (req.headers['authorization'] || '') === `Bearer ${process.env.CRON_SECRET}`;
  const dryRun = req.query && (req.query.dryRun === '1' || req.query.dryRun === 'true');
  const force = req.query && (req.query.force === '1' || req.query.force === 'true');

  try {
    const doc = await fsGetState(['telegram_config', 'telegram_drafts', 'telegram_processed_ids', 'telegram_drafts_run_at']);
    const cfgFields = (doc.fields && doc.fields.telegram_config && doc.fields.telegram_config.mapValue.fields) || {};
    const draftsCfg = (cfgFields.drafts && cfgFields.drafts.mapValue && cfgFields.drafts.mapValue.fields) || {};
    if (!draftsCfg.enabled || !draftsCfg.enabled.booleanValue) {
      res.status(200).json({ ok: true, skipped: 'drafts disabled in telegram_config' });
      return;
    }

    // Only the manual (app button) path is throttled; the daily cron always runs.
    const lastRunIso = (doc.fields && doc.fields.telegram_drafts_run_at && doc.fields.telegram_drafts_run_at.stringValue) || '';
    if (!isCron && !dryRun && lastRunIso) {
      const minsSince = (Date.now() - new Date(lastRunIso).getTime()) / 60000;
      if (minsSince < THROTTLE_MINUTES) {
        res.status(200).json({ ok: true, skipped: 'throttled', minutesUntilNextRun: Math.ceil(THROTTLE_MINUTES - minsSince) });
        return;
      }
    }

    const processedRaw = (doc.fields && doc.fields.telegram_processed_ids && doc.fields.telegram_processed_ids.arrayValue.values) || [];
    const processed = new Set(processedRaw.map(v => v.stringValue));

    const sinceIso = new Date(Date.now() - LOOKBACK_HOURS * 3600000).toISOString();
    const all = await fetchRecentMessages(sinceIso);
    const settleBefore = Date.now() - SETTLE_MINUTES * 60000;
    const fresh = all.filter(m => DRAFT_TOPIC_IDS.includes(m.topicId) && m.messageId && !processed.has(m.messageId)
      && (force || !m.date || new Date(m.date).getTime() <= settleBefore));
    if (!fresh.length) {
      res.status(200).json({ ok: true, created: 0, note: 'no new messages in the watched topic' });
      return;
    }

    // The drafts still waiting for the owner, passed to the model as context so a reply
    // that arrives after its issue was already drafted updates that draft instead of
    // becoming a stray new one.
    const draftsRaw = (doc.fields && doc.fields.telegram_drafts && doc.fields.telegram_drafts.arrayValue.values) || [];
    const openDrafts = draftsRaw.map(r => {
      const f = r.mapValue.fields;
      return {
        id: (f.id && f.id.stringValue) || '',
        title: (f.title && f.title.stringValue) || '',
        sourceText: (f.sourceText && f.sourceText.stringValue) || '',
        askedQuestion: (f.askedQuestion && f.askedQuestion.stringValue) || '',
      };
    }).filter(d => d.id);

    const issues = await clusterIssues(fresh, openDrafts);
    const byId = {};
    fresh.forEach(m => { byId[m.messageId] = m; });

    const newDrafts = [], summary = [];
    for (const issue of issues) {
      const ids = (issue.messageIds || []).map(String).filter(id => byId[id]);
      if (!ids.length) continue;
      const msgs = ids.map(id => byId[id]);

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

      const sourceText = msgs.map(m => `${m.fromName}: ${m.text || '(фото)'}`).join('\n');
      const authors = [...new Set(msgs.map(m => m.fromName).filter(Boolean))].join(', ');

      // An update to an existing draft: fold the new messages, summary and photos into
      // the draft already on screen rather than creating a second one for the same issue.
      const updIdx = issue.updatesDraftId
        ? draftsRaw.findIndex(r => (r.mapValue.fields.id || {}).stringValue === issue.updatesDraftId)
        : -1;
      if (updIdx !== -1) {
        const f = draftsRaw[updIdx].mapValue.fields;
        const prevIds = ((f.sourceMessageIds && f.sourceMessageIds.arrayValue.values) || []).map(v => v.stringValue);
        f.sourceMessageIds = fsStringArray([...new Set(prevIds.concat(ids))]);
        f.sourceText = fsString(((f.sourceText && f.sourceText.stringValue) || '') + '\n' + sourceText);
        if (issue.description) f.description = fsString(issue.description);
        if (issue.title) f.title = fsString((issue.title || '').slice(0, 120));
        if (['high', 'medium', 'low'].includes(issue.priority)) f.priority = fsString(issue.priority);
        if (metas.length) {
          const prevFiles = ((f.fileIds && f.fileIds.arrayValue.values) || []).map(v => v.stringValue);
          const prevNames = ((f.fileNames && f.fileNames.arrayValue.values) || []).map(v => v.stringValue);
          const prevTypes = ((f.fileTypes && f.fileTypes.arrayValue.values) || []).map(v => v.stringValue);
          f.fileIds = fsStringArray(prevFiles.concat(metas.map(m => m.id)));
          f.fileNames = fsStringArray(prevNames.concat(metas.map(m => m.name)));
          f.fileTypes = fsStringArray(prevTypes.concat(metas.map(m => m.type)));
        }
        // Only ever ask once per draft — a worker who has already been asked and simply
        // hasn't answered yet should not be pinged again on every run.
        const alreadyAsked = !!(f.askedQuestion && f.askedQuestion.stringValue);
        if (issue.sufficient === false && issue.clarifyingQuestion && !alreadyAsked && !dryRun) {
          try {
            await sendTelegramReply(msgs[0].topicId, ids[0], issue.clarifyingQuestion);
            f.askedQuestion = fsString(issue.clarifyingQuestion);
          } catch (e) {}
        }
        summary.push({ updated: issue.updatesDraftId, title: issue.title, messageIds: ids, photos: metas.length });
        continue;
      }

      // Asked once, as a reply to the issue's first message, with the whole thread already
      // taken into account — better than asking per message as it arrives. The draft is
      // still created either way, so nothing is lost while waiting for an answer, and the
      // question is recorded on it so later runs neither repeat it nor lose the thread.
      let askedQuestion = '';
      if (issue.sufficient === false && issue.clarifyingQuestion && !dryRun) {
        try {
          await sendTelegramReply(msgs[0].topicId, ids[0], issue.clarifyingQuestion);
          askedQuestion = issue.clarifyingQuestion;
        } catch (e) {}
      }

      newDrafts.push({
        id: String(Date.now()) + Math.random().toString(36).slice(2, 6),
        type: issue.type === 'sos' ? 'sos' : 'maintenance',
        title: (issue.title || '').slice(0, 120),
        description: issue.description || '',
        priority: ['high', 'medium', 'low'].includes(issue.priority) ? issue.priority : 'medium',
        category: issue.category || 'other',
        sourceText, sourceFrom: authors, sourceTopic: msgs[0].topicName, sourceDate: msgs[0].date,
        sourceMessageIds: ids,
        createdAt: new Date().toISOString(),
        askedQuestion,
        fileIds: metas.map(m => m.id),
        fileNames: metas.map(m => m.name),
        fileTypes: metas.map(m => m.type),
      });
      summary.push({ title: issue.title, type: issue.type, messageIds: ids, photos: metas.length, asked: !!askedQuestion });
    }

    if (!dryRun) {
      const mergedDrafts = draftsRaw.concat(newDrafts.map(fsDraftEntry));
      // Every message seen this run is marked processed — including ones Claude decided
      // were not a real issue — so they are never re-analysed or re-asked about.
      const mergedProcessed = [...processed, ...fresh.map(m => m.messageId)].slice(-PROCESSED_CAP);
      await fsPatchState({
        telegram_drafts: { arrayValue: { values: mergedDrafts } },
        telegram_processed_ids: fsStringArray(mergedProcessed),
        telegram_drafts_run_at: fsString(new Date().toISOString()),
      });
    }

    res.status(200).json({ ok: true, dryRun: !!dryRun, analysed: fresh.length, created: newDrafts.length, issues: summary });
  } catch (e) {
    res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
};
