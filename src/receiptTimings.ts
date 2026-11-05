// Temporary diagnostic types shared by api/receipt.ts and the Expenses UI.
// Lives in src/ (not api/) because Vercel turns every file in api/ into an endpoint.

export type GeminiAttemptOutcome = 'success' | 'fail' | 'timeout'

export interface GeminiAttemptTiming {
  model: string
  ms: number
  outcome: GeminiAttemptOutcome
  httpStatus: number | null
}

export interface ReceiptTimings {
  bodyBytes: number
  bodyReadMs: number
  pdfRenderMs: number | null
  geminiAttempts: GeminiAttemptTiming[]
  parseMs: number | null
  serverTotalMs: number
}
