import Anthropic from '@anthropic-ai/sdk'
import type { ClaudeCallOutcome, ExtractedReceipt, ReceiptCategory, ReceiptPaymentMethod, ReceiptTimings } from '../src/receiptTypes.js'

// Claude picks a short code; we map it back to the label the form shows.
const CATEGORY_CODES = {
  fuel: 'Fuel / Gas', repairs: 'Maintenance & Repairs', tires: 'Tires', parts: 'Parts', vehicle: 'Vehicle / Truck', insurance: 'Insurance',
  licensing: 'Registration / Licensing', tolls: 'Tolls', office: 'Office', phone: 'Phone / Communications', supplies: 'Supplies', meals: 'Meals',
  professional: 'Professional Services', advertising: 'Advertising / Marketing', trailer: 'Trailer', equipment: 'Equipment', other: 'Miscellaneous',
} as const satisfies Record<string, ReceiptCategory>
type CategoryCode = keyof typeof CATEGORY_CODES
// Fails to compile if any ReceiptCategory has no code (the missing label becomes a required key).
const categoriesWithoutCode: Record<Exclude<ReceiptCategory, (typeof CATEGORY_CODES)[CategoryCode]>, never> = {}
void categoriesWithoutCode
const PAYMENT_CODES = {
  card: 'Credit card', debit: 'Debit', cash: 'Cash', cheque: 'Cheque', etransfer: 'E-transfer', on_account: 'On account', other: 'Other',
} as const satisfies Record<string, ReceiptPaymentMethod>
type PaymentCode = keyof typeof PAYMENT_CODES

// Give the function room beyond the 15 s Claude timeout so it can return a clear error.
export const maxDuration = 30

const CLAUDE_MODEL = 'claude-haiku-5-5'
const CLAUDE_TIMEOUT_MS = 15_000
const BODY_TIMEOUT_MS = 5_000
const IMAGE_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const
type ImageMediaType = typeof IMAGE_MEDIA_TYPES[number]

export const normalizeReceiptAmounts = (receipt: ExtractedReceipt): ExtractedReceipt => {
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

const nullableString = { type: ['string', 'null'] }
const nullableNumber = { type: ['number', 'null'] }

// Only the fields the review form uses; no line items or free-text fields, to keep output short.
const saveReceiptTool: Anthropic.Tool = {
  name: 'save_receipt',
  description: 'Save the receipt fields. Use null for anything not shown.',
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      vendor: nullableString,
      date: { ...nullableString, description: 'YYYY-MM-DD' },
      receiptNumber: { ...nullableString, description: 'Invoice or receipt number' },
      subtotal: nullableNumber,
      gst: nullableNumber,
      pst: nullableNumber,
      total: nullableNumber,
      paymentMethod: { anyOf: [{ type: 'string', enum: Object.keys(PAYMENT_CODES) }, { type: 'null' }] },
      category: { type: 'string', enum: Object.keys(CATEGORY_CODES) },
    },
    required: ['vendor', 'date', 'receiptNumber', 'subtotal', 'gst', 'pst', 'total', 'paymentMethod', 'category'],
  },
}

const SYSTEM_PROMPT = `Extract Canadian receipts and invoices with save_receipt.
- vendor: business name without Inc./Ltd.
- gst = GST/HST amount; pst = PST/QST amount. Never use a tax registration number as an amount. subtotal + gst + pst = total.
- Fuel receipts list litres and price per litre; those are not totals.
- Numeric dates are month/day/year.
- paymentMethod: on_account for charge / net-terms invoices.
- category: repairs for shop labour or repair work (including on trailers).`

// Runtime check of Claude's tool input against ExtractedReceipt (strict mode should guarantee it; this keeps the type honest).
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const isNullableString = (value: unknown): value is string | null => value === null || typeof value === 'string'
const isNullableNumber = (value: unknown): value is number | null => value === null || (typeof value === 'number' && Number.isFinite(value))
const isCategoryCode = (value: unknown): value is CategoryCode => typeof value === 'string' && Object.hasOwn(CATEGORY_CODES, value)
const isPaymentCode = (value: unknown): value is PaymentCode => typeof value === 'string' && Object.hasOwn(PAYMENT_CODES, value)

export const parseExtractedReceipt = (input: unknown): ExtractedReceipt | null => {
  if (!isRecord(input)) return null
  const { vendor, date, subtotal, gst, pst, total, category, paymentMethod, receiptNumber } = input
  if (!isNullableString(vendor) || !isNullableString(date) || !isNullableNumber(subtotal) || !isNullableNumber(gst) || !isNullableNumber(pst)
    || !isNullableNumber(total) || !isCategoryCode(category) || !(paymentMethod === null || isPaymentCode(paymentMethod)) || !isNullableString(receiptNumber)) return null
  return {
    vendor, date, subtotal, gst, pst, total, receiptNumber,
    category: CATEGORY_CODES[category],
    paymentMethod: paymentMethod === null ? null : PAYMENT_CODES[paymentMethod],
  }
}

const isImageMediaType = (value: string): value is ImageMediaType => (IMAGE_MEDIA_TYPES as readonly string[]).includes(value)

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
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim()
  if (!apiKey) return jsonResponse({ error: 'Receipt scanning is not configured: ANTHROPIC_API_KEY is not set on the server. Add it to .env.local (local) or the Vercel project settings (production).' }, 500)

  // Temporary diagnostics: every response below carries a `timings` object.
  const requestStartedAt = Date.now()
  const timings: Omit<ReceiptTimings, 'serverTotalMs'> = { bodyBytes: 0, bodyReadMs: 0, claude: null, parseMs: null }
  const respond = (payload: object, status = 200) => {
    const finished: ReceiptTimings = { ...timings, serverTotalMs: Date.now() - requestStartedAt }
    console.log(`[receipt-timing] server ${JSON.stringify(finished)}`)
    return jsonResponse({ ...payload, timings: finished }, status)
  }

  let body: { mimeType?: string; data?: string }
  try {
    const rawBody = await withTimeout(request.arrayBuffer(), BODY_TIMEOUT_MS, 'Receipt upload timed out before it reached the server.')
    timings.bodyBytes = rawBody.byteLength
    body = JSON.parse(new TextDecoder().decode(rawBody)) as { mimeType?: string; data?: string }
    timings.bodyReadMs = Date.now() - requestStartedAt
  } catch (error) {
    return respond({ error: error instanceof Error && error.message.includes('timed out') ? error.message : 'The receipt upload could not be read.' }, 400)
  }

  const { mimeType, data } = body
  if (!mimeType || !data) return respond({ error: 'A receipt photo or PDF is required.' }, 400)
  let fileBlock: Anthropic.ImageBlockParam | Anthropic.DocumentBlockParam
  if (mimeType === 'application/pdf') fileBlock = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
  else if (isImageMediaType(mimeType)) fileBlock = { type: 'image', source: { type: 'base64', media_type: mimeType, data } }
  else return respond({ error: `This file type (${mimeType}) can't be scanned. Use a JPEG, PNG, WebP, or PDF.` }, 415)

  const client = new Anthropic({ apiKey, timeout: CLAUDE_TIMEOUT_MS, maxRetries: 0 })
  const callStartedAt = Date.now()
  const recordCall = (outcome: ClaudeCallOutcome, httpStatus: number | null, response?: Anthropic.Message) => {
    timings.claude = {
      model: CLAUDE_MODEL, ms: Date.now() - callStartedAt, outcome, httpStatus,
      inputTokens: response?.usage.input_tokens ?? null, outputTokens: response?.usage.output_tokens ?? null, stopReason: response?.stop_reason ?? null,
    }
  }

  let message: Anthropic.Message
  try {
    message = await client.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 400,
      system: SYSTEM_PROMPT,
      tools: [saveReceiptTool],
      // Forced tool call: the response is the tool_use block only, with no text (or thinking) before it.
      tool_choice: { type: 'tool', name: saveReceiptTool.name },
      messages: [{ role: 'user', content: [fileBlock, { type: 'text', text: 'Record this receipt with save_receipt.' }] }],
    })
  } catch (error) {
    if (error instanceof Anthropic.APIConnectionTimeoutError) {
      recordCall('timeout', null)
      return respond({ error: `Claude took longer than ${CLAUDE_TIMEOUT_MS / 1000} seconds to read this receipt. Please try again.` }, 504)
    }
    if (error instanceof Anthropic.AuthenticationError) {
      recordCall('fail', error.status)
      return respond({ error: 'ANTHROPIC_API_KEY was rejected by Anthropic (invalid or revoked key). Check the key in .env.local or the Vercel project settings.' }, 500)
    }
    if (error instanceof Anthropic.RateLimitError) {
      recordCall('fail', error.status)
      return respond({ error: 'Claude is rate-limited right now. Please try again in a few seconds.' }, 429)
    }
    if (error instanceof Anthropic.APIConnectionError) {
      recordCall('fail', null)
      return respond({ error: 'Could not reach the Claude API. Check the server\'s internet connection and try again.' }, 502)
    }
    if (error instanceof Anthropic.APIError) {
      recordCall('fail', error.status ?? null)
      return respond({ error: `Claude API error${error.status ? ` (HTTP ${error.status})` : ''}: ${error.message}` }, 502)
    }
    recordCall('fail', null)
    return respond({ error: 'Receipt scanning failed unexpectedly.' }, 500)
  }

  recordCall('success', 200, message)
  const rawToolInput = JSON.stringify(message.content.find((block) => block.type === 'tool_use')?.input ?? null)
  console.log(`[receipt-diag] stop_reason=${message.stop_reason} blocks=${message.content.map((block) => block.type).join(',')} tool_input=${rawToolInput.slice(0, 1000)}`)
  if (message.stop_reason === 'refusal') return respond({ error: 'Claude declined to read this file.' }, 502)
  if (message.stop_reason === 'max_tokens') return respond({ error: 'Claude\'s answer was cut off (receipt too long). Please try again or enter it manually.' }, 502)
  const toolUse = message.content.find((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use' && block.name === saveReceiptTool.name)

  const parseStartedAt = Date.now()
  const extracted = toolUse ? parseExtractedReceipt(toolUse.input) : null
  timings.parseMs = Date.now() - parseStartedAt
  if (!extracted) return respond({ error: 'Claude returned receipt data in an unexpected format. Please try again.' }, 502)
  return respond(normalizeReceiptAmounts(extracted))
}
