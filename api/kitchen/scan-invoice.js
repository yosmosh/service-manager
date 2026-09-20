// Server-side Claude Vision call for kitchen invoice OCR. Previously the browser called
// Anthropic directly using a key typed into Настройки доступа, whose own label claimed
// "хранится только на этом устройстве" — but setLS() in this app syncs everything to
// Firestore appdata/state (which has no read auth), and the key also ran exposed in every
// browser's Network tab regardless of where it was stored. The key now lives only in this
// function's server environment and is never sent to the client.
//
// Required Vercel environment variable: ANTHROPIC_API_KEY (shared with api/cron/telegram-digest.js)

const PROMPT = 'Это фото счёта/накладной от поставщика. Внимательно прочитай КАЖДУЮ строку документа, включая мелкий текст и колонки с цифрами — не пропускай ни одной позиции, даже если текст неразборчив (в этом случае дай наиболее вероятное значение, не выдумывай). Особое внимание удели точности цифр (количество, цена, сумма) — перепроверь каждую цифру перед тем, как записать её в ответ, особенно похожие друг на друга (0/6/8, 1/7, 3/8, 5/6). Перед выводом мысленно проверь: сумма (количество × цена) по всем позициям должна примерно совпадать с итоговой суммой счёта; если не совпадает — перепроверь распознанные цифры ещё раз.\n\nВерни ТОЛЬКО JSON без комментариев, в точности в этом формате:\n{"supplier_name":"...","date":"YYYY-MM-DD","invoice_num":"...","total":0,"items":[{"name":"...","qty":0,"unit":"кг","price":0}]}\n\nПравила:\n- Название товара — точно как написано в документе, без сокращений и без "улучшений" от себя.\n- Если поле в принципе не найдено в документе — оставь пустым ("") или 0, но саму позицию всё равно включи.\n- Включи ВСЕ строки товаров из документа, ничего не пропускай.\n- Единицы измерения: кг/г/л/мл/шт/уп/кор/бут/пак — выбери наиболее подходящую по контексту.\n- Валюта — ₽ (рубли).';

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'method not allowed' }); return; }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' }); return; }

  try {
    const { imageBase64, mediaType } = req.body || {};
    if (!imageBase64) { res.status(400).json({ error: 'imageBase64 required' }); return; }

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 4096,
        temperature: 0,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: imageBase64 } },
          { type: 'text', text: PROMPT },
        ] }],
      }),
    });
    const data = await resp.json();
    if (!resp.ok) { res.status(502).json({ error: (data.error && data.error.message) || 'Anthropic API error' }); return; }
    const text = ((data.content && data.content[0] && data.content[0].text) || '').trim();
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) { res.status(502).json({ error: 'no JSON in AI response' }); return; }
    const parsed = JSON.parse(match[0]);
    res.status(200).json({ ok: true, result: parsed });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message || e) });
  }
};
