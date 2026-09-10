import { createCanvas } from '@napi-rs/canvas'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'

type GeminiPart = { inlineData: { mimeType: string; data: string } } | { text: string }

type ReceiptResponse = {
  merchant: string | null
  date: string | null
  subtotal: number | null
  gst: number | null
  pst: number | null
  total: number | null
  receiptNumber: string | null
  category: string | null
  paymentMethod: string | null
  currency: string | null
  lineItems: Array<{
    description: string | null
    quantity: number | null
    unitPrice: number | null
    amount: number | null
  }>
}

export const normalizeReceiptAmounts = (receipt: ReceiptResponse) => {
  const total = typeof receipt.total === 'number' && Number.isFinite(receipt.total) && receipt.total >= 0 ? receipt.total : null
  const isPlausibleTax = (value: number | null) => value == null || (Number.isFinite(value) && value >= 0 && (total == null || value <= total))
  const gst = isPlausibleTax(receipt.gst) ? receipt.gst : null
  const subtotal = typeof receipt.subtotal === 'number' && Number.isFinite(receipt.subtotal) && receipt.subtotal >= 0 ? receipt.subtotal : null
  const explicitPst = isPlausibleTax(receipt.pst) ? receipt.pst : null
  const pst = explicitPst ?? (total != null && gst != null && subtotal != null && Math.abs(total - gst - subtotal) <= 0.02 ? 0 : null)
  const taxTotal = gst != null && pst != null ? gst + pst : null
  const hasCompleteAmounts = total != null && taxTotal != null && taxTotal <= total + 0.02
  const calculatedSubtotal = hasCompleteAmounts ? Math.max(0, total - taxTotal) : null

  return {
    ...receipt,
    subtotal: calculatedSubtotal ?? subtotal,
    gst,
    pst,
    total,
  }
}

const receiptSchema = {
  type: 'OBJECT',
  properties: {
    merchant: { type: 'STRING', nullable: true },
    date: { type: 'STRING', nullable: true, description: 'Return visible dates as YYYY-MM-DD. For numeric dates, interpret month/day/year order, so 06/11/2026 means 2026-06-11.' },
    subtotal: { type: 'NUMBER', nullable: true },
    gst: { type: 'NUMBER', nullable: true },
    pst: { type: 'NUMBER', nullable: true },
    total: { type: 'NUMBER', nullable: true },
    receiptNumber: { type: 'STRING', nullable: true },
    invoiceNumber: { type: 'STRING', nullable: true },
    category: {
      type: 'STRING',
      enum: ['Fuel / Gas', 'Maintenance & Repairs', 'Tires', 'Parts', 'Vehicle / Truck', 'Insurance', 'Registration / Licensing', 'Tolls', 'Office', 'Phone / Communications', 'Supplies', 'Meals', 'Professional Services', 'Advertising / Marketing', 'Trailer', 'Equipment', 'Miscellaneous'],
    },
    paymentMethod: { type: 'STRING', nullable: true },
    currency: { type: 'STRING', nullable: true },
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

const prompt = `Read the receipt image and return the requested JSON. Extract only visible information; never invent values. Interpret numeric dates as month/day/year and return them as YYYY-MM-DD, so 06/11/2026 means 2026-06-11. Return null when a date is unreadable. Select exactly one category from the allowed category values; use Miscellaneous if the category cannot be determined.

Tax extraction is strict: distinguish GST, HST, PST, and QST registration numbers, business numbers, account numbers, phone numbers, and invoice/receipt numbers from transaction-level tax amounts. Never use an identification or registration number as a tax amount, even when it appears beside or underneath a GST/PST/HST label. Read actual amounts from the transaction/tax section and labels such as GST, HST, PST, QST, Tax, Taxes, Tax paid by customer, GST included, or PST included. If tax is explicitly included in the total, use the actual included tax amount shown on the receipt. If a tax is not charged or not shown, return 0 or null, never guess.

Validate the amounts against the receipt: subtotal plus GST plus PST should equal total within normal cent rounding. If the extracted tax values make that equation impossible, reject the values and re-examine the transaction/tax section. When total and actual included taxes are clear but subtotal is not printed, calculate subtotal as total minus those taxes. Do not invent taxes to make the equation work.`

const GEMINI_TIMEOUT_MS = 9_000
const GEMINI_ATTEMPT_TIMEOUT_MS = 7_000
const PDF_GEMINI_TIMEOUT_MS = 40_000
const PDF_GEMINI_ATTEMPT_TIMEOUT_MS = 20_000
const BODY_TIMEOUT_MS = 5_000
const GEMINI_MODELS = ['gemini-3.5-flash-lite', 'gemini-3.5-flash']

const renderPdfPages = async (data: string) => {
  const document = await getDocument({ data: Uint8Array.from(Buffer.from(data, 'base64')) }).promise
  const pages: GeminiPart[] = []
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber)
    const viewport = page.getViewport({ scale: 1.5 })
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
    await page.render({ canvas: null, canvasContext: canvas.getContext('2d'), viewport }).promise
    pages.push({ inlineData: { mimeType: 'image/png', data: canvas.toBuffer('image/png').toString('base64') } })
  }
  return pages
}

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const withTimeout = async <T,>(promise: Promise<T>, timeoutMs: number, message: string) => {
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
  }
}

export async function POST(request: Request) {
  const apiKey = process.env.GEMINI_API_KEY?.trim()
  if (!apiKey) return jsonResponse({ error: 'Receipt service is not configured. Check GEMINI_API_KEY.' }, 503)

  try {
    const body = await withTimeout(request.json() as Promise<{ mimeType?: string; data?: string }>, BODY_TIMEOUT_MS, 'Receipt request body timed out')
    if ((!body.mimeType?.startsWith('image/') && body.mimeType !== 'application/pdf') || !body.data) return jsonResponse({ error: 'A JPEG, PNG, HEIC, or PDF file is required.' }, 400)

    const isPdf = body.mimeType === 'application/pdf'
    const totalTimeoutMs = isPdf ? PDF_GEMINI_TIMEOUT_MS : GEMINI_TIMEOUT_MS
    const attemptTimeoutMs = isPdf ? PDF_GEMINI_ATTEMPT_TIMEOUT_MS : GEMINI_ATTEMPT_TIMEOUT_MS
    const pdfPages = isPdf ? await renderPdfPages(body.data) : null
    const contents = isPdf
      ? [{ role: 'user', parts: [{ text: prompt }, ...(pdfPages ?? [])] as GeminiPart[] }]
      : [{ role: 'user', parts: [{ text: prompt }, { inlineData: { mimeType: body.mimeType, data: body.data } }] as GeminiPart[] }]
    const startedAt = Date.now()
    let rateLimitedModelCount = 0
    for (const model of GEMINI_MODELS) {
      const remainingMs = totalTimeoutMs - (Date.now() - startedAt)
      if (remainingMs <= 0) throw new Error('Gemini request timed out')

      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), Math.min(attemptTimeoutMs, remainingMs))
      try {
        const { response, result } = await withTimeout((async () => {
          const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              contents,
              generationConfig: {
                responseMimeType: 'application/json',
                responseSchema: receiptSchema,
                thinkingConfig: { thinkingLevel: 'minimal' },
                temperature: 0,
              },
            }),
            signal: controller.signal,
          })
          return { response, result: await response.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> } }
        })(), Math.min(attemptTimeoutMs, remainingMs), 'Gemini request timed out')
        if (response.status === 429 && !isPdf) rateLimitedModelCount += 1
        if ((response.status === 429 && !isPdf) || response.status === 503 || response.status === 504) continue
        if (!response.ok) return jsonResponse({ error: 'Gemini could not read this receipt.' }, 502)
        const text = result.candidates?.[0]?.content?.parts?.find((part) => part.text)?.text
        if (!text) return jsonResponse({ error: 'Gemini returned no receipt data.' }, 502)
        const receipt = normalizeReceiptAmounts(JSON.parse(text) as ReceiptResponse)
        return jsonResponse(receipt)
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') continue
        if (error instanceof Error && error.message === 'Gemini request timed out') continue
        throw error
      } finally {
        clearTimeout(timeoutId)
      }
    }
    if (!isPdf && rateLimitedModelCount === GEMINI_MODELS.length) return jsonResponse({ error: 'Gemini is temporarily busy. Please try again in a few seconds.' }, 429)
    return jsonResponse({ error: 'Gemini could not read this receipt.' }, 502)
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') return jsonResponse({ error: 'Gemini receipt scanning timed out.' }, 504)
    if (error instanceof Error && error.message.includes('timed out')) return jsonResponse({ error: error.message }, 504)
    return jsonResponse({ error: 'Gemini receipt scanning failed.' }, 502)
  }
}
