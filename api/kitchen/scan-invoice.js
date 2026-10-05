// Server-side Claude Vision call for kitchen invoice OCR. Previously the browser called
// Anthropic directly using a key typed into Настройки доступа, whose own label claimed
// "хранится только на этом устройстве" — but setLS() in this app syncs everything to
// Firestore appdata/state (which has no read auth), and the key also ran exposed in every
// browser's Network tab regardless of where it was stored. The key now lives only in this
// function's server environment and is never sent to the client.
//
// Required Vercel environment variable: ANTHROPIC_API_KEY (shared with api/cron/telegram-digest.js)
//
// The warehouse uses it too (purpose: 'warehouse'): an invoice already in the budget is read
// into a receipt for the shelf. It sends where the invoice's files are rather than the files,
// they are fetched here, and PDFs are read as well as photos. One endpoint, so one daily cap
// covers both.

const { updateDoc, fsString, fsInt, OWN_FILE_PREFIXES } = require('../_lib/firestore');

// This URL is public (the app has no server-side login), and every call is a paid vision
// request on the same Anthropic key the Telegram drafts and the digest use — anyone who found
// it could spend that credit without limit, and once it ran out those would stop as well.
// A daily cap bounds what that can cost; the kitchen's real volume is a few invoices a day.
const DAILY_SCAN_LIMIT = 60;
const QUOTA_DOC = 'appdata/_scan_quota';

const moscowDay = () => new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 10);
const usedToday = (f, day) => (f.day && f.day.stringValue === day) ? (Number(f.count && f.count.integerValue) || 0) : 0;

// Takes one slot out of today's allowance BEFORE the model is called, in a single
// read-modify-write guarded by the document's version — so requests arriving together can't
// each read the same count and all decide there is room. (Reading the count first and adding
// to it afterwards, as this did briefly, left seconds between the two: a burst of a hundred
// requests all passed the check and the cap bounded nothing at all.)
//
// Returns false only when the day really is used up. When the quota can't be read or written
// the scan is let through: the cap is there to bound what a stranger can spend, not to stop
// the kitchen entering invoices, so a Firestore blip must not refuse real work.
async function reserveScan() {
  const day = moscowDay();
  try {
    let room = false;
    await updateDoc(QUOTA_DOC, ['day', 'count'], f => {
      const used = usedToday(f, day);
      room = used < DAILY_SCAN_LIMIT;
      return room ? { day: fsString(day), count: fsInt(used + 1) } : null;
    });
    return room;
  } catch (e) { return true; }
}

// Gives the slot back when nothing usable came of it. A request the model refused or cut off
// costs nothing, and without this a spell of Anthropic being overloaded would eat the day's
// allowance and lock the kitchen out. Best-effort: a refund that fails to write only leaves
// today's cap a little tighter.
async function releaseScan() {
  const day = moscowDay();
  try {
    await updateDoc(QUOTA_DOC, ['day', 'count'], f => {
      const used = usedToday(f, day);
      return used > 0 ? { day: fsString(day), count: fsInt(used - 1) } : null;
    });
  } catch (e) { /* see above */ }
}

const PROMPT = 'Это фото счёта/накладной от поставщика. Внимательно прочитай КАЖДУЮ строку документа, включая мелкий текст и колонки с цифрами — не пропускай ни одной позиции, даже если текст неразборчив (в этом случае дай наиболее вероятное значение, не выдумывай). Особое внимание удели точности цифр (количество, цена, сумма) — перепроверь каждую цифру перед тем, как записать её в ответ, особенно похожие друг на друга (0/6/8, 1/7, 3/8, 5/6). Перед выводом мысленно проверь: сумма (количество × цена) по всем позициям должна примерно совпадать с итоговой суммой счёта; если не совпадает — перепроверь распознанные цифры ещё раз.\n\nВерни ТОЛЬКО JSON без комментариев, в точности в этом формате:\n{"supplier_name":"...","date":"YYYY-MM-DD","invoice_num":"...","total":0,"items":[{"name":"...","qty":0,"unit":"кг","price":0}]}\n\nПравила:\n- Название товара — точно как написано в документе, без сокращений и без "улучшений" от себя.\n- Если поле в принципе не найдено в документе — оставь пустым ("") или 0, но саму позицию всё равно включи.\n- Включи ВСЕ строки товаров из документа, ничего не пропускай.\n- Единицы измерения: кг/г/л/мл/шт/уп/кор/бут/пак — выбери наиболее подходящую по контексту.\n- Валюта — ₽ (рубли).';

// Category ids are the app's WH_CATS (service-manager.html) — keep the two lists in step.
const WAREHOUSE_PROMPT = 'Это счёт / накладная / чек поставщика — если страниц или фото несколько, это один документ. Товары пойдут на склад хозяйственной службы: инструмент, оборудование, электроника, освещение, сантехника, химия, стройматериалы, крепёж, спецодежда. Внимательно прочитай КАЖДУЮ строку товаров, не пропускай ни одной. Особое внимание удели точности цифр (количество, цена, сумма) — перепроверь похожие цифры (0/6/8, 1/7, 3/8, 5/6). Сумма (количество × цена) по всем позициям должна примерно совпадать с итогом счёта; если не совпадает — перепроверь распознанное.\n\nВерни ТОЛЬКО JSON без комментариев, в точности в этом формате:\n{"supplier_name":"...","date":"YYYY-MM-DD","invoice_num":"...","total":0,"items":[{"name":"...","qty":0,"unit":"шт","price":0,"kind":"asset","category":"tools"}]}\n\nПравила:\n- Название — точно как в документе, без сокращений и без "улучшений" от себя.\n- price — цена за единицу С НДС, то есть как к оплате. Если цены в документе без НДС, а НДС выделен отдельно — прибавь его к цене.\n- unit — одно из: шт, компл, пар, м, м², кг, л, уп, рул, мешок.\n- kind: "asset" — то, что выдают сотруднику и он возвращает (инструмент, техника, оборудование, электроника, лестницы, инвентарь); "consumable" — то, что расходуется (химия, лампы, крепёж, стройматериалы, перчатки, мешки, расходники).\n- category — одно из: tools (ручной инструмент), power (электроинструмент), garden (садовая техника и инвентарь), equipment (оборудование), electronics (электроника), lighting (освещение и электрика), plumbing (сантехника), chemicals (химия), building (стройматериалы), fasteners (крепёж и расходники), safety (спецодежда и СИЗ), other (прочее).\n- Доставку, услуги, работы, сборку и другие строки, которые не являются товаром, в items НЕ включай.\n- Если поле не найдено — оставь "" или 0, но саму позицию всё равно включи.\n- Валюта — ₽ (рубли).';

// Only this app's own uploads are fetched. The URL comes from the browser, and the function is
// public: fetching whatever address it was handed would let anyone use it to read other
// places on the server's behalf.
const MAX_FILES = 5;
const MAX_IMAGE_BYTES = 3.75 * 1024 * 1024; // 5 MB once base64-encoded — the API's limit for one image
const MAX_PDF_BYTES = 20 * 1024 * 1024;
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

// A problem the person can act on — answered with its own message, not a server error.
const userError = msg => Object.assign(new Error(msg), { userFacing: true });

async function fetchOwnFile(url) {
  if (typeof url !== 'string' || !OWN_FILE_PREFIXES.some(p => url.startsWith(p))) throw userError('Файл не из хранилища приложения');
  const r = await fetch(url, { redirect: 'error' });
  if (!r.ok) throw userError('Не удалось открыть файл счёта (' + r.status + ')');
  const type = String(r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const buf = Buffer.from(await r.arrayBuffer());
  if (type === 'application/pdf') {
    if (buf.length > MAX_PDF_BYTES) throw userError('PDF счёта слишком большой для распознавания (больше 20 МБ)');
    return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buf.toString('base64') } };
  }
  if (IMAGE_TYPES.includes(type)) {
    if (buf.length > MAX_IMAGE_BYTES) throw userError('Фото счёта слишком большое для распознавания');
    return { type: 'image', source: { type: 'base64', media_type: type, data: buf.toString('base64') } };
  }
  throw userError('Этот файл не читается автоматически — нужен PDF или фото');
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'method not allowed' }); return; }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' }); return; }

  try {
    const body = req.body || {};
    let content;
    if (body.purpose === 'warehouse') {
      const urls = Array.isArray(body.fileUrls) ? body.fileUrls : [];
      if (!urls.length) { res.status(400).json({ error: 'fileUrls required' }); return; }
      if (urls.length > MAX_FILES) { res.status(400).json({ error: `Не больше ${MAX_FILES} файлов за раз` }); return; }
      // Fetched before a slot is taken: a file that can't be read costs nothing.
      const files = [];
      for (const u of urls) files.push(await fetchOwnFile(u));
      content = files.concat([{ type: 'text', text: WAREHOUSE_PROMPT }]);
    } else {
      const { imageBase64, mediaType } = body;
      if (!imageBase64) { res.status(400).json({ error: 'imageBase64 required' }); return; }
      content = [
        { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: imageBase64 } },
        { type: 'text', text: PROMPT },
      ];
    }
    if (!(await reserveScan())) {
      res.status(429).json({ error: `Дневной лимит распознавания счетов исчерпан (${DAILY_SCAN_LIMIT}) — заполните позиции вручную или попробуйте завтра` });
      return;
    }
    // The slot is taken from here on, and goes back unless this produces a usable answer.
    let usable = false;
    try {
      // Sonnet 5 thinks before answering by default, and thinking counts against max_tokens —
      // the old cap of 4096 could run out on a long invoice before the JSON was complete.
      // 16000 is the documented default for a non-streaming request (as in build-drafts).
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-5',
          max_tokens: 16000,
          messages: [{ role: 'user', content }],
        }),
      });
      const data = await resp.json();
      if (!resp.ok) { res.status(502).json({ error: (data.error && data.error.message) || 'Anthropic API error' }); return; }
      // A cut-off answer is a failure with a message a person can act on, not a JSON error.
      if (data.stop_reason !== 'end_turn') {
        res.status(502).json({ error: 'Ответ ИИ оборвался (' + data.stop_reason + ') — попробуйте ещё раз или сфотографируйте счёт частями' });
        return;
      }
      // Sonnet 5 sometimes puts an extended-thinking block before the actual text block, so
      // content[0] isn't reliably the text — find the text block by type instead.
      const textBlock = (data.content || []).find(b => b.type === 'text');
      const text = ((textBlock && textBlock.text) || '').trim();
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) { res.status(502).json({ error: 'no JSON in AI response' }); return; }
      const parsed = JSON.parse(match[0]);
      usable = true;
      res.status(200).json({ ok: true, result: parsed });
    } finally {
      if (!usable) await releaseScan();
    }
  } catch (e) {
    res.status(e && e.userFacing ? 400 : 500).json({ error: String(e && e.message || e) });
  }
};
