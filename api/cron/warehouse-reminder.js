// The warehouse's morning reminder: tools not returned by their due date, and materials at or
// below the minimum the owner set. Sent only when it is switched on in the app (Склад →
// Настройки → Напоминания в Telegram), either to the "Хозчасть и Ремонт" topic of the group or
// privately to the digest subscribers. Nothing to report, nothing sent.
//
// Works from the same documents the app does and computes holdings the same way
// (service-manager.html, _whHoldings / _whLowStock): every quantity comes from the receipt /
// issue / return / write-off documents, a return closing that person's OLDEST open issue of
// that item first. Keep the two in step.
//
// Required Vercel environment variables: TELEGRAM_BOT_TOKEN, CRON_SECRET.

const { readDoc, appendLog, fsString, fsInt } = require('../_lib/firestore');

const TELEGRAM_CHAT_ID = -1004438968318;
const TOPIC_ID = 57; // Хозчасть и Ремонт
const LOG_CAP = 50;

// Firestore REST value → plain JS.
function plain(v) {
  if (!v || typeof v !== 'object') return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('booleanValue' in v) return !!v.booleanValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('nullValue' in v) return null;
  if ('arrayValue' in v) return ((v.arrayValue && v.arrayValue.values) || []).map(plain);
  if ('mapValue' in v) { const o = {}; const f = (v.mapValue && v.mapValue.fields) || {}; Object.keys(f).forEach(k => { o[k] = plain(f[k]); }); return o; }
  return null;
}

const q3 = v => Math.round((Number(v) || 0) * 1000) / 1000;
const moscowToday = () => new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 10);
const ru = d => { const [y, m, dd] = String(d || '').split('-'); return dd && m ? `${dd}.${m}.${y}` : ''; };
const fmtQ = v => q3(v).toLocaleString('ru-RU', { maximumFractionDigits: 3 });

function stockMap(docs) {
  const m = {};
  docs.forEach(d => {
    const sign = (d.type === 'receipt' || d.type === 'return') ? 1 : (d.type === 'issue' || d.type === 'writeoff') ? -1 : 0;
    (d.lines || []).forEach(l => { m[l.itemId] = q3((m[l.itemId] || 0) + sign * (Number(l.qty) || 0)); });
  });
  return m;
}

function holdings(items, docs) {
  const asset = id => { const it = items.find(i => i.id === id); return !!it && it.kind !== 'consumable'; };
  const moves = docs.filter(d => (d.type === 'issue' || d.type === 'return') && d.employeeId)
    .slice().sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')) || String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
  const open = {};
  moves.forEach(d => (d.lines || []).forEach(l => {
    if (!asset(l.itemId)) return;
    const k = d.employeeId + '|' + l.itemId;
    const q = q3(l.qty);
    if (d.type === 'issue') { (open[k] = open[k] || []).push({ no: d.no, date: d.date, dueDate: d.dueDate || '', qty: q }); return; }
    let left = q; const arr = open[k] || [];
    while (left > 0 && arr.length) {
      const take = Math.min(left, arr[0].qty);
      arr[0].qty = q3(arr[0].qty - take); left = q3(left - take);
      if (arr[0].qty <= 0) arr.shift();
    }
  }));
  const out = [];
  Object.keys(open).forEach(k => {
    const [employeeId, itemId] = k.split('|');
    open[k].forEach(p => { if (p.qty > 0) out.push(Object.assign({ employeeId, itemId }, p)); });
  });
  return out;
}

// What the reminder would say, or '' when there is nothing to say. Pure — tested directly.
function buildReminder(items, employees, docs, today) {
  const overdue = holdings(items, docs).filter(h => h.dueDate && h.dueDate < today);
  const stock = stockMap(docs);
  const low = items.filter(i => i.kind === 'consumable' && Number(i.minQty) > 0 && (stock[i.id] || 0) <= Number(i.minQty));
  if (!overdue.length && !low.length) return '';
  const item = id => items.find(i => i.id === id) || {};
  const person = id => (employees.find(e => e.id === id) || {}).name || '?';
  let text = `🧰 Склад — напоминание на ${ru(today)}`;
  if (overdue.length) {
    text += '\n\n⏰ Не возвращено в срок:\n' + overdue
      .sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)))
      .map(h => { const it = item(h.itemId); return `• ${person(h.employeeId)} — ${it.name || '?'} (${it.invNo || ''}) × ${fmtQ(h.qty)}, срок был до ${ru(h.dueDate)}`; }).join('\n');
  }
  if (low.length) {
    text += '\n\n⚠️ Заканчивается:\n' + low
      .map(i => `• ${i.name} (${i.invNo || ''}): осталось ${fmtQ(stock[i.id] || 0)} ${i.unit || ''}, минимум ${fmtQ(i.minQty)}`).join('\n');
  }
  return text;
}

async function send(chatId, text, threadId) {
  const body = { chat_id: chatId, text };
  if (threadId) body.message_thread_id = threadId;
  const r = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(body),
  });
  return r.json().catch(() => ({}));
}

module.exports = async (req, res) => {
  if (process.env.CRON_SECRET) {
    if ((req.headers['authorization'] || '') !== `Bearer ${process.env.CRON_SECRET}`) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
  }
  if (!process.env.TELEGRAM_BOT_TOKEN) { res.status(500).json({ error: 'TELEGRAM_BOT_TOKEN not configured' }); return; }
  const dryRun = req.query && (req.query.dryRun === '1' || req.query.dryRun === 'true');

  try {
    const wh = await readDoc('appdata/warehouse', ['wh_items', 'wh_employees', 'wh_settings']);
    const settings = plain(wh.fields.wh_settings) || {};
    if (!settings.tgReminders) { res.status(200).json({ ok: true, skipped: 'reminders are off in the warehouse settings' }); return; }
    const items = plain(wh.fields.wh_items) || [];
    const employees = plain(wh.fields.wh_employees) || [];
    const docs = plain((await readDoc('appdata/warehouse_docs', ['wh_docs'])).fields.wh_docs) || [];

    const text = buildReminder(items, employees, docs, moscowToday());
    if (!text) { res.status(200).json({ ok: true, skipped: 'nothing overdue or running low' }); return; }

    let targets;
    if (settings.tgTarget === 'subscribers') {
      const st = await readDoc('appdata/state', ['telegram_config']);
      const cfg = plain(st.fields.telegram_config) || {};
      targets = (((cfg.digest || {}).subscribers) || []).map(s => ({ chatId: s.chatId })).filter(t => t.chatId);
      if (!targets.length) { res.status(200).json({ ok: true, skipped: 'no digest subscribers to send to', text }); return; }
    } else {
      targets = [{ chatId: TELEGRAM_CHAT_ID, threadId: TOPIC_ID }];
    }
    if (dryRun) { res.status(200).json({ ok: true, dryRun: true, targets: targets.length, text }); return; }

    for (const t of targets) await send(t.chatId, text, t.threadId);
    await appendLog([{ mapValue: { fields: {
      id: fsString(`warehouse-${Date.now()}`), type: fsString('warehouse'),
      title: fsString(text.slice(0, 200)), level: fsInt(0), sentAt: fsString(new Date().toISOString()),
    } } }], LOG_CAP);
    res.status(200).json({ ok: true, sent: targets.length, text });
  } catch (e) {
    res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
};

// Exposed for tests only.
module.exports.buildReminder = buildReminder;
module.exports.holdings = holdings;
module.exports.stockMap = stockMap;
