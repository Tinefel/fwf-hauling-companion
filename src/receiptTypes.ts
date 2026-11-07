// Types shared by api/receipt.ts and the Expenses UI.
// Lives in src/ (not api/) because Vercel turns every file in api/ into an endpoint.
// Types only: the API imports this with `import type`, which is erased at runtime.

export type ReceiptCategory = 'Fuel / Gas' | 'Maintenance & Repairs' | 'Parts' | 'Vehicle / Truck' | 'Insurance / Licensing & Registration' | 'Meals' | 'Advertising / Marketing' | 'Miscellaneous'

export type ReceiptPaymentMethod = 'Credit card' | 'Debit' | 'Cash' | 'Cheque' | 'E-transfer' | 'On account' | 'Other'

// Only the fields the review form uses.
export interface ExtractedReceipt {
  vendor: string | null
  /** YYYY-MM-DD */
  date: string | null
  subtotal: number | null
  gst: number | null
  pst: number | null
  total: number | null
  category: ReceiptCategory
  paymentMethod: ReceiptPaymentMethod | null
  receiptNumber: string | null
}

// Temporary diagnostics returned alongside every /api/receipt response.
export type ClaudeCallOutcome = 'success' | 'fail' | 'timeout'

export interface ClaudeCallTiming {
  model: string
  ms: number
  outcome: ClaudeCallOutcome
  httpStatus: number | null
  inputTokens: number | null
  outputTokens: number | null
  stopReason: string | null
}

export interface ReceiptTimings {
  bodyBytes: number
  bodyReadMs: number
  claude: ClaudeCallTiming | null
  parseMs: number | null
  serverTotalMs: number
}

export type ReceiptApiResponse = (ExtractedReceipt & { timings?: ReceiptTimings }) | { error: string; timings?: ReceiptTimings }
