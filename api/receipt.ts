type GeminiPart = { inlineData: { mimeType: string; data: string } } | { text: string }

const receiptSchema = {
  type: 'OBJECT',
  properties: {
    merchant: { type: 'STRING', nullable: true },
    date: { type: 'STRING', nullable: true },
    subtotal: { type: 'NUMBER', nullable: true },
    gst: { type: 'NUMBER', nullable: true },
    pst: { type: 'NUMBER', nullable: true },
    total: { type: 'NUMBER', nullable: true },
    receiptNumber: { type: 'STRING', nullable: true },
    invoiceNumber: { type: 'STRING', nullable: true },
    category: { type: 'STRING', nullable: true },
    paymentMethod: { type: 'STRING', nullable: true },
    currency: { type: 'STRING', enum: ['CAD'] },
    lineItems: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          description: { type: 'STRING', nullable: true },
          quantity: { type: 'NUMBER', nullable: true },
          unitPrice: { type: 'NUMBER', nullable: true },
          amount: { type: 'NUMBER', nullable: true },
        },
        required: ['description', 'quantity', 'unitPrice', 'amount'],
      },
    },
  },
  required: ['merchant', 'date', 'subtotal', 'gst', 'pst', 'total', 'receiptNumber', 'invoiceNumber', 'category', 'paymentMethod', 'currency', 'lineItems'],
}

const prompt = `Analyze this Canadian receipt image and return only the requested JSON object. Read merchant/store name and address, Canadian date, subtotal, explicitly stated GST and PST, final amount charged, receipt or invoice numbers, category, payment method, and line items. Do not guess: use null when a value is not visible or cannot be confidently determined. Preserve decimal amounts accurately. Distinguish the final total from item amounts. Categories include fuel, vehicle repairs, parts, tires, tools, insurance, food, office expenses, and other. Handle angled, shadowed, wrinkled, unevenly lit, or slightly blurry photographs and small text. Use currency CAD unless the receipt clearly shows another currency.`

const GEMINI_REQUEST_TIMEOUT_MS = 25_000

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

export default async function handler(request: Request) {
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405)
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) return jsonResponse({ error: 'Receipt service is not configured' }, 503)

  try {
    const body = await request.json() as { mimeType?: string; data?: string }
    if (!body.mimeType?.startsWith('image/') || !body.data) return jsonResponse({ error: 'An image is required' }, 400)
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), GEMINI_REQUEST_TIMEOUT_MS)
    try {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }, { inlineData: { mimeType: body.mimeType, data: body.data } }] as GeminiPart[] }],
          generationConfig: {
            responseMimeType: 'application/json',
            responseSchema: receiptSchema,
            temperature: 0,
          },
        }),
        signal: controller.signal,
      })
      if (!response.ok) return jsonResponse({ error: 'Receipt service request failed' }, 502)
      const result = await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }
      const text = result.candidates?.[0]?.content?.parts?.find((part) => part.text)?.text
      if (!text) return jsonResponse({ error: 'Receipt service returned no result' }, 502)
      const receipt = JSON.parse(text)
      return jsonResponse(receipt)
    } finally {
      clearTimeout(timeoutId)
    }
  } catch {
    return jsonResponse({ error: 'Receipt service request failed' }, 502)
  }
}