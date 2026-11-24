import { useEffect, useRef, useState } from 'react'
import { CameraIcon, CheckCircleIcon, DocumentArrowUpIcon, DocumentTextIcon, EllipsisHorizontalIcon, PencilSquareIcon, PhotoIcon, ReceiptPercentIcon, TrashIcon, TruckIcon } from '@heroicons/react/24/outline'
import JSZip from 'jszip'
import { jsPDF } from 'jspdf'
import * as XLSX from 'xlsx'
import type { ExtractedReceipt, ReceiptApiResponse, ReceiptTimings } from './receiptTypes'
import { supabase } from './supabase'

export type ExpenseRecord = {
  id: string
  merchant: string
  date: string
  category: string
  subtotal: string
  gst: string
  pst: string
  total: string
  invoiceNumber: string
  description: string
  paymentMethod: string
  currency: string
  lineItems: string
  attachmentName: string
  attachmentType: string
  attachmentData: string
  createdAt: string
}

type CategoryTotals = {
  category: string
  count: number
  total: number
  gst: number
  pst: number
}

type ExpenseTrackerProps = {
  expenses: ExpenseRecord[]
  onExpensesChange: (expenses: ExpenseRecord[]) => Promise<void>
}

type ExpenseDraft = Omit<ExpenseRecord, 'id' | 'createdAt'>

const CATEGORIES = ['Fuel / Gas', 'Maintenance & Repairs', 'Parts', 'Vehicle / Truck', 'Insurance / Licensing & Registration', 'Meals', 'Advertising / Marketing', 'Miscellaneous']
const canonicalCategory = (value: string | null) => {
  switch (value) {
    case 'Insurance':
    case 'Registration / Licensing':
      return 'Insurance / Licensing & Registration'
    case 'Tires':
    case 'Supplies':
    case 'Equipment':
      return 'Parts'
    case 'Trailer':
      return 'Maintenance & Repairs'
    case 'Office':
    case 'Phone / Communications':
    case 'Tolls':
    case 'Professional Services':
      return 'Miscellaneous'
    default:
      return CATEGORIES.includes(value ?? '') ? value! : 'Miscellaneous'
  }
}
const emptyDraft: ExpenseDraft = {
  merchant: '', date: '', category: 'Other', subtotal: '', gst: '', pst: '', total: '', invoiceNumber: '', description: '', paymentMethod: '', currency: 'CAD', lineItems: '', attachmentName: '', attachmentType: '', attachmentData: '',
}
const CLIENT_TIMEOUT_MS = 20_000
const MAX_IMAGE_EDGE_PX = 1600
const JPEG_QUALITY = 0.8

const withTimeout = async <T,>(promise: Promise<T>, timeoutMs: number, message: string) => {
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => { timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs) })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
  }
}

const readDataUrl = (file: File) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader()
  reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('Could not attach receipt'))
  reader.onerror = () => reject(reader.error ?? new Error('Could not attach receipt'))
  reader.readAsDataURL(file)
})
// Photos are resized to 1600px on the longest side and re-encoded as JPEG 0.8 before upload
// (full-size phone photos exceed Claude's 5 MB image limit and Vercel's 4.5 MB request limit).
// PDFs and anything the browser can't decode (e.g. HEIC outside Safari) pass through unchanged.
const compressReceiptImage = async (file: File): Promise<File> => {
  if (!file.type.startsWith('image/')) return file
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
    const scale = Math.min(1, MAX_IMAGE_EDGE_PX / Math.max(bitmap.width, bitmap.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(bitmap.width * scale)
    canvas.height = Math.round(bitmap.height * scale)
    const context = canvas.getContext('2d')
    if (!context) { bitmap.close(); return file }
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    bitmap.close()
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY))
    return blob ? new File([blob], `${file.name.replace(/\.[^.]+$/, '')}.jpg`, { type: 'image/jpeg' }) : file
  } catch {
    return file
  }
}
const toUploadPayload = async (file: File) => {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return { mimeType: file.type || 'application/octet-stream', data: btoa(binary) }
}
type ScanStage = 'compressing' | 'uploading' | 'reading' | 'done'
type ScanProgress = { stage: ScanStage; uploadFraction: number }
type ScanState = ScanProgress & { fileName: string; isPdf: boolean; previewUrl: string | null }
const STAGE_LABELS: Record<ScanStage, string> = { compressing: 'Compressing…', uploading: 'Uploading…', reading: 'Reading receipt…', done: 'Done' }
// How long "Done" shows before the review form opens: the truck animation (~1800ms), or 400ms with reduced motion.
const DONE_ANIMATION_MS = 1800
const DONE_REDUCED_MOTION_MS = 400

// XMLHttpRequest instead of fetch because only XHR reports upload progress.
const postReceipt = (body: string, onUploadProgress: (fraction: number) => void, timeoutMessage: string) =>
  new Promise<{ status: number; body: ReceiptApiResponse | null }>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', '/api/receipt')
    xhr.setRequestHeader('content-type', 'application/json')
    xhr.timeout = CLIENT_TIMEOUT_MS
    xhr.upload.onprogress = (event) => { if (event.lengthComputable && event.total > 0) onUploadProgress(Math.min(1, event.loaded / event.total)) }
    xhr.upload.onload = () => onUploadProgress(1)
    xhr.onload = () => {
      let parsed: ReceiptApiResponse | null
      try {
        const json: unknown = JSON.parse(xhr.responseText)
        parsed = typeof json === 'object' && json !== null ? json as ReceiptApiResponse : null
      } catch {
        parsed = null // non-JSON body (e.g. Vercel's 413 page) → fallbackErrorFor(status)
      }
      resolve({ status: xhr.status, body: parsed })
    }
    xhr.ontimeout = () => reject(new Error(timeoutMessage))
    xhr.onerror = () => reject(new Error('Could not reach the server. Check your connection and try again.'))
    xhr.send(body)
  })

// Diagnostics: one [receipt-timing] console line per scan. Upload ≈ round trip − server total.
type ClientTimings = { compressMs: number | null; encodeMs: number | null; roundTripMs: number | null }
const formatTimingLine = (original: File, uploaded: File | null, outcome: string, client: ClientTimings, server: ReceiptTimings | undefined) => {
  const ms = (value: number | null) => value == null ? '—' : `${Math.round(value)} ms`
  const mb = (bytes: number) => `${(bytes / 1_048_576).toFixed(2)} MB`
  const sizes = uploaded && uploaded !== original ? `${mb(original.size)} ${original.type || 'unknown'} → ${mb(uploaded.size)} ${uploaded.type}` : `${mb(original.size)} ${original.type || 'unknown'}`
  const parts = [`[receipt-timing] ${outcome}`, `file ${sizes}`, `compress ${ms(client.compressMs)}`, `encode ${ms(client.encodeMs)}`, `round trip ${ms(client.roundTripMs)}`]
  if (!server) return [...parts, 'server timings unavailable'].join(' | ')
  parts.push(`≈upload ${ms(client.roundTripMs == null ? null : client.roundTripMs - server.serverTotalMs)}`, `server ${ms(server.serverTotalMs)}`, `body ${mb(server.bodyBytes)}`, `body read ${ms(server.bodyReadMs)}`)
  if (server.claude) {
    const call = server.claude
    parts.push(`${call.model} ${ms(call.ms)} ${call.outcome}${call.httpStatus == null ? '' : ` HTTP ${call.httpStatus}`}${call.stopReason ? ` stop=${call.stopReason}` : ''}`)
    if (call.inputTokens != null || call.outputTokens != null) parts.push(`tokens in ${call.inputTokens ?? '—'} / out ${call.outputTokens ?? '—'}`)
  }
  if (server.parseMs != null) parts.push(`parse ${ms(server.parseMs)}`)
  return parts.join(' | ')
}
const fallbackErrorFor = (status: number) => status === 413
  ? 'This file is too large to upload (the limit is about 4.5 MB). Try a smaller photo or PDF.'
  : `Receipt scanning failed (HTTP ${status}). Please try again.`
const scanReceipt = async (file: File, onProgress: (progress: ScanProgress) => void): Promise<ExtractedReceipt> => {
  let outcome = 'failed'
  let uploaded: File | null = null
  const client: ClientTimings = { compressMs: null, encodeMs: null, roundTripMs: null }
  let requestStartedAt: number | null = null
  let serverTimings: ReceiptTimings | undefined
  try {
    onProgress({ stage: 'compressing', uploadFraction: 0 })
    const compressStartedAt = performance.now()
    uploaded = await withTimeout(compressReceiptImage(file), CLIENT_TIMEOUT_MS, 'Preparing the receipt image timed out.')
    client.compressMs = performance.now() - compressStartedAt
    const encodeStartedAt = performance.now()
    const payload = await withTimeout(toUploadPayload(uploaded), CLIENT_TIMEOUT_MS, 'Preparing the receipt image timed out.')
    client.encodeMs = performance.now() - encodeStartedAt
    const timeoutMessage = `Receipt scan timed out after ${CLIENT_TIMEOUT_MS / 1000} seconds with no response from the server. Check your connection and try again.`
    onProgress({ stage: 'uploading', uploadFraction: 0 })
    requestStartedAt = performance.now()
    const response = await postReceipt(
      JSON.stringify(payload),
      (fraction) => onProgress(fraction >= 1 ? { stage: 'reading', uploadFraction: 1 } : { stage: 'uploading', uploadFraction: fraction }),
      timeoutMessage,
    )
    client.roundTripMs = performance.now() - requestStartedAt
    const { body } = response
    serverTimings = body?.timings
    const isOk = response.status >= 200 && response.status < 300
    if (!isOk || !body || 'error' in body) throw new Error(body && 'error' in body ? body.error : fallbackErrorFor(response.status))
    outcome = 'ok'
    return body
  } finally {
    if (client.roundTripMs == null && requestStartedAt != null) client.roundTripMs = performance.now() - requestStartedAt
    console.log(formatTimingLine(file, uploaded, outcome, client, serverTimings))
  }
}

function ScanProgressBar({ value, celebrate = false }: { value: number | null; celebrate?: boolean }) {
  const percent = value == null ? undefined : Math.round(value * 100)
  return (
    <div className="relative">
      <div role="progressbar" aria-label="Scan progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} className="h-1.5 w-full overflow-hidden rounded-full bg-stone-200">
        {value == null
          ? <div className="h-full w-1/3 rounded-full bg-amber-800 motion-safe:animate-receipt-indeterminate motion-reduce:w-full motion-reduce:opacity-60" />
          : celebrate
            // The truck pulls the fill to 100%; reduced motion just shows it full.
            ? <div className="h-full w-full rounded-full bg-amber-800 motion-safe:animate-receipt-truck-fill" />
            : <div className="h-full rounded-full bg-amber-800 transition-[width] duration-200 motion-reduce:transition-none" style={{ width: `${percent ?? 0}%` }} />}
      </div>
      {celebrate && (
        // Taller than the track and clipped at its edges, so the truck drives along it and exits off the right.
        <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-5 overflow-hidden motion-reduce:hidden">
          <div className="absolute bottom-0.5 motion-safe:animate-receipt-truck-drive">
            <span className="absolute -left-1 bottom-0.5 h-1.5 w-1.5 rounded-full bg-stone-400/70 motion-safe:animate-receipt-dust" />
            <span className="absolute -left-2.5 bottom-1 h-1 w-1 rounded-full bg-stone-400/60 motion-safe:animate-receipt-dust" style={{ animationDelay: '280ms' }} />
            <span className="absolute -left-1.5 bottom-0 h-1 w-1 rounded-full bg-stone-400/50 motion-safe:animate-receipt-dust" style={{ animationDelay: '560ms' }} />
            <TruckIcon className="h-4 w-4 text-amber-800" />
          </div>
        </div>
      )}
    </div>
  )
}

function ScanStatus({ scan }: { scan: ScanState }) {
  const [previewFailed, setPreviewFailed] = useState(false)
  const isDone = scan.stage === 'done'
  const progress = scan.stage === 'reading' ? null : scan.stage === 'uploading' ? scan.uploadFraction : isDone ? 1 : 0
  const FallbackIcon = scan.isPdf ? DocumentTextIcon : PhotoIcon
  return (
    <div className="mt-4 flex items-center gap-4 rounded-2xl bg-stone-50 p-3 ring-1 ring-stone-200">
      <div className="relative h-24 w-20 shrink-0 overflow-hidden rounded-xl bg-white ring-1 ring-stone-200">
        {scan.previewUrl && !previewFailed
          ? <img src={scan.previewUrl} alt="" className="h-full w-full object-cover" onError={() => setPreviewFailed(true)} />
          : <div className="flex h-full w-full items-center justify-center text-amber-900"><FallbackIcon className="h-9 w-9" /></div>}
        {!isDone && (
          <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-amber-900/10">
            <div className="absolute inset-x-0 top-0 h-0.5 bg-amber-600 shadow-[0_0_8px_2px_rgba(217,119,6,0.55)] motion-safe:animate-receipt-scan motion-reduce:hidden" />
          </div>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-stone-900">{scan.fileName}</p>
        <p aria-live="polite" className={`mt-1 flex items-center gap-1.5 text-sm ${isDone ? 'font-semibold text-emerald-700' : 'text-stone-600'}`}>
          {isDone && <CheckCircleIcon className="h-4 w-4 motion-safe:animate-receipt-check-pop" />}{STAGE_LABELS[scan.stage]}
        </p>
        <div className="mt-3"><ScanProgressBar value={progress} celebrate={isDone} /></div>
      </div>
    </div>
  )
}
const normalizeCategory = (value: string | null) => canonicalCategory(value)
const normalizeDate = (value: string | null) => {
  if (!value) return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10)
}
const receiptToDraft = (receipt: ExtractedReceipt, isPdf: boolean): Partial<ExpenseDraft> => ({
  merchant: receipt.vendor ?? '', date: normalizeDate(receipt.date), category: normalizeCategory(receipt.category),
  subtotal: receipt.subtotal == null ? '' : receipt.subtotal.toFixed(2), gst: receipt.gst == null ? '' : receipt.gst.toFixed(2),
  pst: receipt.pst == null ? '' : receipt.pst.toFixed(2), total: receipt.total == null ? '' : receipt.total.toFixed(2),
  invoiceNumber: receipt.receiptNumber ?? '', paymentMethod: receipt.paymentMethod ?? '',
  // Line items are no longer extracted (latency); currency keeps the draft default (CAD).
  description: isPdf ? `${receipt.vendor ?? 'Invoice'} - ${receipt.category} items` : '',
})
const formatAmount = (value: string) => value && Number.isFinite(Number(value)) ? new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(Number(value)) : '—'
const amountInCents = (value: string) => {
  const normalized = value.trim()
  if (!normalized || !Number.isFinite(Number(normalized))) return 0
  const match = /^([+-]?)(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(normalized)
  if (!match) return 0
  const [, sign, integerPart, fractionPart = '', exponentPart = '0'] = match
  const digits = `${integerPart || '0'}${fractionPart}`.replace(/^0+(?=\d)/, '')
  const centsScale = 2 - fractionPart.length + Number(exponentPart)
  let cents: bigint
  if (centsScale >= 0) {
    cents = BigInt(digits) * (10n ** BigInt(centsScale))
  } else {
    const divisor = 10n ** BigInt(-centsScale)
    const amount = BigInt(digits)
    cents = amount / divisor
    if ((amount % divisor) * 2n >= divisor) cents += 1n
  }
  const result = Number(cents) * (sign === '-' ? -1 : 1)
  return Number.isSafeInteger(result) ? result : 0
}
const formatCents = (value: number) => formatAmount((value / 100).toFixed(2))
const exportAmount = (value: string) => value.trim() && Number.isFinite(Number(value)) ? amountInCents(value) / 100 : ''
const formatCurrencyColumns = (sheet: XLSX.WorkSheet, columns: number[], rows: number) => {
  columns.forEach((column) => {
    for (let row = 1; row <= rows; row += 1) {
      const cell = sheet[XLSX.utils.encode_cell({ r: row, c: column })]
      if (cell?.t === 'n') cell.z = '"$"#,##0.00'
    }
  })
}
const dateLabel = (value: string) => value ? new Date(`${value}T00:00:00`).toLocaleDateString('en-CA', { dateStyle: 'medium' }) : '—'
const monthLabel = (value: string) => value === 'Unknown date' ? value : new Date(`${value}-01T00:00:00`).toLocaleDateString('en-CA', { month: 'long', year: 'numeric' })
const expenseTotal = (expense: ExpenseRecord) => Number.isFinite(Number(expense.total)) ? Number(expense.total) : 0
const formatTaxValue = (value: string) => value.trim() && Number.isFinite(Number(value)) ? formatCents(amountInCents(value)) : 'Missing'
const isValidExpenseDate = (value: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}
const escapeFilePart = (value: string) => value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'Unknown'
const dataUrlToBlob = (dataUrl: string) => {
  const separator = dataUrl.indexOf(',')
  if (!dataUrl.startsWith('data:') || separator < 0) throw new Error('A saved receipt has invalid data')
  const metadata = dataUrl.slice(5, separator)
  const payload = dataUrl.slice(separator + 1)
  const binary = metadata.endsWith(';base64') ? atob(payload) : decodeURIComponent(payload)
  return new Blob([Uint8Array.from(binary, (character) => character.charCodeAt(0))], {
    type: metadata.split(';')[0] || 'application/octet-stream',
  })
}
const triggerDownload = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
}
const buildQuarterlyPdf = (
  quarter: string,
  year: string,
  expenses: ExpenseRecord[],
  unknownDateExpenses: ExpenseRecord[],
  totals: { total: number; gst: number; pst: number },
  categories: CategoryTotals[],
) => {
  const pdf = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'letter' })
  const pageWidth = pdf.internal.pageSize.getWidth()
  const pageHeight = pdf.internal.pageSize.getHeight()
  const margin = 36
  const columns = [
    { label: 'Date', width: 52 },
    { label: 'Merchant', width: 100 },
    { label: 'Category', width: 105 },
    { label: 'Description', width: 190 },
    { label: 'Subtotal', width: 58 },
    { label: 'GST', width: 50 },
    { label: 'PST', width: 50 },
    { label: 'Total', width: 65 },
  ]
  const drawTransactionTable = (rows: ExpenseRecord[], title: string) => {
    let y = 40
    pdf.setFont('helvetica', 'bold')
    pdf.setFontSize(15)
    pdf.text(title, margin, y)
    y += 14
    pdf.setFontSize(7)
    const drawHeader = () => {
      pdf.setFillColor(120, 53, 15)
      pdf.rect(margin, y, pageWidth - margin * 2, 19, 'F')
      pdf.setTextColor(255, 255, 255)
      pdf.setFont('helvetica', 'bold')
      let x = margin + 4
      columns.forEach((column) => {
        pdf.text(column.label, x, y + 12)
        x += column.width
      })
      pdf.setTextColor(35, 35, 35)
      y += 19
    }
    drawHeader()
    rows.forEach((expense, index) => {
      const values = [
        isValidExpenseDate(expense.date) ? dateLabel(expense.date) : 'Unknown date',
        expense.merchant || 'Unnamed merchant',
        canonicalCategory(expense.category),
        expense.description || '—',
        expense.subtotal.trim() ? formatTaxValue(expense.subtotal) : '—',
        formatTaxValue(expense.gst),
        formatTaxValue(expense.pst),
        expense.total.trim() ? formatTaxValue(expense.total) : '—',
      ]
      const wrapped = values.map((value, valueIndex) => pdf.splitTextToSize(value, columns[valueIndex].width - 7) as string[])
      const rowHeight = Math.max(19, ...wrapped.map((lines) => lines.length * 8 + 7))
      if (y + rowHeight > pageHeight - margin) {
        pdf.addPage()
        y = 40
        drawHeader()
      }
      if (index % 2 === 1) {
        pdf.setFillColor(250, 247, 242)
        pdf.rect(margin, y, pageWidth - margin * 2, rowHeight, 'F')
      }
      let x = margin + 4
      wrapped.forEach((lines, valueIndex) => {
        pdf.setFont('helvetica', 'normal')
        pdf.setFontSize(7)
        pdf.text(lines, x, y + 10)
        x += columns[valueIndex].width
      })
      y += rowHeight
    })
  }

  pdf.setFillColor(120, 53, 15)
  pdf.rect(0, 0, pageWidth, 112, 'F')
  pdf.setTextColor(255, 255, 255)
  pdf.setFont('helvetica', 'bold')
  pdf.setFontSize(22)
  pdf.text('FWF Hauling', margin, 38)
  pdf.setFontSize(13)
  pdf.text(`${quarter} ${year} Quarterly Expense Report`, margin, 60)
  pdf.setFont('helvetica', 'normal')
  pdf.setFontSize(9)
  pdf.text(`Transactions: ${expenses.length}  |  Total expenses: ${formatCents(totals.total)}  |  GST: ${formatCents(totals.gst)}  |  PST: ${formatCents(totals.pst)}`, margin, 82)

  let y = 139
  pdf.setTextColor(35, 35, 35)
  pdf.setFont('helvetica', 'bold')
  pdf.setFontSize(12)
  pdf.text('Category summary', margin, y)
  y += 16
  pdf.setFontSize(8)
  pdf.text('Category', margin, y)
  pdf.text('Expenses', margin + 220, y)
  pdf.text('GST', margin + 330, y)
  pdf.text('PST', margin + 430, y)
  y += 5
  categories.forEach((category) => {
    y += 14
    pdf.setFont('helvetica', 'normal')
    pdf.text(category.category, margin, y)
    pdf.text(`${formatCents(category.total)} (${category.count})`, margin + 220, y)
    pdf.text(formatCents(category.gst), margin + 330, y)
    pdf.text(formatCents(category.pst), margin + 430, y)
  })
  if (unknownDateExpenses.length > 0) {
    y += 22
    pdf.setTextColor(153, 27, 27)
    pdf.setFont('helvetica', 'bold')
    pdf.text(`${unknownDateExpenses.length} expense${unknownDateExpenses.length === 1 ? '' : 's'} are listed under Expenses requiring date review and excluded from quarter totals.`, margin, y)
  }

  pdf.addPage()
  drawTransactionTable(expenses, 'Individual expenses')
  if (unknownDateExpenses.length > 0) {
    pdf.addPage()
    drawTransactionTable(unknownDateExpenses, 'Expenses requiring date review')
  }
  return pdf.output('blob')
}
const sortedByExpenseDate = (items: ExpenseRecord[]) => [...items].sort((a, b) => {
  const dateDifference = b.date.localeCompare(a.date)
  return dateDifference || b.createdAt.localeCompare(a.createdAt)
})

function ExpenseTracker({ expenses, onExpensesChange }: ExpenseTrackerProps) {
  const [draft, setDraft] = useState<ExpenseDraft | null>(null)
  const [selectedExpense, setSelectedExpense] = useState<ExpenseRecord | null>(null)
  const [scan, setScan] = useState<ScanState | null>(null)
  const isScanning = scan !== null
  const [processingMessage, setProcessingMessage] = useState('')
  const [receiptError, setReceiptError] = useState('')
  const [retryFile, setRetryFile] = useState<File | null>(null)
  const [merchantSearch, setMerchantSearch] = useState('')
  const [categoryFilter, setCategoryFilter] = useState('All categories')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [monthFilter, setMonthFilter] = useState('')
  const [yearFilter, setYearFilter] = useState('')
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(() => new Set())
  const [selectedQuarter, setSelectedQuarter] = useState(() => `Q${Math.floor(new Date().getMonth() / 3) + 1}`)
  const [selectedQuarterYear, setSelectedQuarterYear] = useState(() => String(new Date().getFullYear()))
  const [isExporting, setIsExporting] = useState(false)
  const [exportMessage, setExportMessage] = useState('')
  const [exportError, setExportError] = useState('')
  const [editingExpenseId, setEditingExpenseId] = useState<string | null>(null)
  const [editingDraft, setEditingDraft] = useState<ExpenseDraft | null>(null)
  const [deleteExpenseId, setDeleteExpenseId] = useState<string | null>(null)
  const [expenseMenuId, setExpenseMenuId] = useState<string | null>(null)
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const longPressActivated = useRef(false)

  useEffect(() => {
    const fileInputs = document.querySelectorAll<HTMLInputElement>('input[type="file"]')
    const documentInput = fileInputs[2]
    if (documentInput) documentInput.accept = 'application/pdf,.pdf,image/jpeg,image/png,image/heic,image/heif,.heic,.heif'
  }, [])

  const selectReceipt = async (file: File) => {
    if (isScanning) return
    const isPdf = file.type === 'application/pdf'
    const previewUrl = file.type.startsWith('image/') ? URL.createObjectURL(file) : null
    setScan({ fileName: file.name, isPdf, previewUrl, stage: 'compressing', uploadFraction: 0 })
    setReceiptError(''); setRetryFile(file); setDraft(null); setProcessingMessage('')
    try {
      const onProgress = (progress: ScanProgress) => setScan((current) => current ? { ...current, ...progress } : current)
      const [receipt, attachmentData] = await Promise.all([scanReceipt(file, onProgress), withTimeout(readDataUrl(file), CLIENT_TIMEOUT_MS, 'Attaching receipt timed out')])
      setScan((current) => current ? { ...current, stage: 'done', uploadFraction: 1 } : current)
      const donePauseMs = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? DONE_REDUCED_MOTION_MS : DONE_ANIMATION_MS
      await new Promise<void>((resolve) => { setTimeout(resolve, donePauseMs) })
      setDraft({ ...emptyDraft, ...receiptToDraft(receipt, isPdf), attachmentName: file.name, attachmentType: file.type || 'application/octet-stream', attachmentData })
      setProcessingMessage('Receipt information found. Review the fields before saving.')
    } catch (error) {
      setReceiptError(error instanceof Error ? error.message : 'Receipt scanning failed. Please try again.')
      setProcessingMessage('Receipt scanning failed.')
    } finally {
      setScan(null)
      if (previewUrl) URL.revokeObjectURL(previewUrl)
    }
  }
  const captureButtonClass = `flex flex-col items-center justify-center rounded-2xl bg-stone-50 p-5 text-center ring-1 ring-stone-200 transition ${isScanning ? 'cursor-not-allowed opacity-50' : 'cursor-pointer hover:bg-amber-50'}`
  const updateDraft = (field: keyof ExpenseDraft, value: string) => setDraft((current) => current ? { ...current, [field]: value } : current)
  const saveExpense = async () => {
    if (!draft?.attachmentData) return
    try {
      await onExpensesChange([{ ...draft, id: crypto.randomUUID(), createdAt: new Date().toISOString() }, ...expenses])
      setDraft(null); setRetryFile(null); setProcessingMessage('')
    } catch (error) {
      console.error('Could not save expense locally:', error)
      setReceiptError(error instanceof Error ? error.message : 'Could not save expense locally.')
    }
  }
  const startEdit = (expense: ExpenseRecord) => {
    setSelectedExpense(null)
    setExpenseMenuId(null)
    setEditingExpenseId(expense.id)
    setEditingDraft({
      merchant: expense.merchant,
      date: expense.date,
      category: canonicalCategory(expense.category),
      subtotal: expense.subtotal,
      gst: expense.gst,
      pst: expense.pst,
      total: expense.total,
      invoiceNumber: expense.invoiceNumber,
      description: expense.description,
      paymentMethod: expense.paymentMethod,
      currency: expense.currency,
      lineItems: expense.lineItems,
      attachmentName: expense.attachmentName,
      attachmentType: expense.attachmentType,
      attachmentData: expense.attachmentData,
    })
  }
  const updateEditingDraft = (field: keyof ExpenseDraft, value: string) => setEditingDraft((current) => current ? { ...current, [field]: value } : current)
  const replaceEditingAttachment = async (file: File) => {
    try {
      const attachmentData = await withTimeout(readDataUrl(file), CLIENT_TIMEOUT_MS, 'Attaching receipt timed out')
      setEditingDraft((current) => current ? { ...current, attachmentName: file.name, attachmentType: file.type || 'application/octet-stream', attachmentData } : current)
    } catch (error) {
      setReceiptError(error instanceof Error ? error.message : 'Could not replace the receipt attachment.')
    }
  }
  const saveEditedExpense = async () => {
    if (!editingExpenseId || !editingDraft) return
    try {
      await onExpensesChange(expenses.map((expense) => expense.id === editingExpenseId ? { ...editingDraft, id: expense.id, createdAt: expense.createdAt } : expense))
      setEditingExpenseId(null)
      setEditingDraft(null)
    } catch (error) {
      console.error('Could not save edited expense locally:', error)
      setReceiptError(error instanceof Error ? error.message : 'Could not save edited expense locally.')
    }
  }
  const cancelEdit = () => {
    setEditingExpenseId(null)
    setEditingDraft(null)
  }
  const confirmDelete = async () => {
    if (!deleteExpenseId) return
    try {
      await onExpensesChange(expenses.filter((expense) => expense.id !== deleteExpenseId))
      setDeleteExpenseId(null)
      setExpenseMenuId(null)
    } catch (error) {
      console.error('Could not save expense deletion locally:', error)
      setReceiptError(error instanceof Error ? error.message : 'Could not save expense deletion locally.')
    }
  }
  const clearFilters = () => {
    setMerchantSearch('')
    setCategoryFilter('All categories')
    setStartDate('')
    setEndDate('')
    setMonthFilter('')
    setYearFilter('')
  }
  const normalizedSearch = merchantSearch.trim().toLowerCase()
  const filteredExpenses = sortedByExpenseDate(expenses.filter((expense) => {
    if (normalizedSearch && !expense.merchant.toLowerCase().includes(normalizedSearch)) return false
    if (categoryFilter !== 'All categories' && canonicalCategory(expense.category) !== categoryFilter) return false
    if (startDate && expense.date < startDate) return false
    if (endDate && expense.date > endDate) return false
    if (monthFilter && expense.date.slice(0, 7) !== monthFilter) return false
    if (yearFilter && expense.date.slice(0, 4) !== yearFilter) return false
    return true
  }))
  const filteredTotal = filteredExpenses.reduce((sum, expense) => sum + expenseTotal(expense), 0)
  const categoryGroups = CATEGORIES.map((category) => {
    const items = filteredExpenses.filter((expense) => canonicalCategory(expense.category) === category)
    return {
      category,
      items,
      total: items.reduce((sum, expense) => sum + amountInCents(expense.total), 0),
      gst: items.reduce((sum, expense) => sum + amountInCents(expense.gst), 0),
      pst: items.reduce((sum, expense) => sum + amountInCents(expense.pst), 0),
    }
  }).filter((group) => group.items.length > 0)
  const quarterNumber = Number(selectedQuarter.slice(1))
  const quarterStartMonth = (quarterNumber - 1) * 3 + 1
  const quarterStart = `${selectedQuarterYear}-${String(quarterStartMonth).padStart(2, '0')}-01`
  const quarterEndMonth = quarterStartMonth + 3
  const quarterEnd = quarterEndMonth > 12
    ? `${Number(selectedQuarterYear) + 1}-01-01`
    : `${selectedQuarterYear}-${String(quarterEndMonth).padStart(2, '0')}-01`
  const quarterExpenses = expenses.filter((expense) => (
    isValidExpenseDate(expense.date) && expense.date >= quarterStart && expense.date < quarterEnd
  ))
  const quarterCategories = CATEGORIES.map((category) => {
    const items = quarterExpenses.filter((expense) => canonicalCategory(expense.category) === category)
    return {
      category,
      count: items.length,
      total: items.reduce((sum, expense) => sum + amountInCents(expense.total), 0),
      gst: items.reduce((sum, expense) => sum + amountInCents(expense.gst), 0),
      pst: items.reduce((sum, expense) => sum + amountInCents(expense.pst), 0),
    }
  })
  const quarterYears = [...new Set([String(new Date().getFullYear()), ...expenses
    .filter((expense) => isValidExpenseDate(expense.date))
    .map((expense) => expense.date.slice(0, 4))])]
    .sort((a, b) => b.localeCompare(a))
  const quarterTotal = quarterExpenses.reduce((sum, expense) => sum + amountInCents(expense.total), 0)
  const quarterGst = quarterExpenses.reduce((sum, expense) => sum + amountInCents(expense.gst), 0)
  const quarterPst = quarterExpenses.reduce((sum, expense) => sum + amountInCents(expense.pst), 0)
  const unknownDateExpenses = expenses.filter((expense) => !isValidExpenseDate(expense.date))
  const quarterTotals = { total: quarterTotal, gst: quarterGst, pst: quarterPst }
  const exportAccountantFiles = async () => {
    setIsExporting(true)
    setExportMessage('')
    setExportError('')
    try {
      const quarterLabel = `${selectedQuarter}-${selectedQuarterYear}`
      const transactionRows = [
        ['Date', 'Merchant', 'Category', 'Description', 'Subtotal', 'GST', 'PST', 'Total expense', 'Receipt filename or reference'],
        ...quarterExpenses.map((expense) => [
          expense.date,
          expense.merchant,
          canonicalCategory(expense.category),
          expense.description,
          exportAmount(expense.subtotal),
          exportAmount(expense.gst),
          exportAmount(expense.pst),
          exportAmount(expense.total),
          expense.attachmentName || (expense.attachmentData ? 'Receipt attached' : ''),
        ]),
      ]
      const unknownRows = unknownDateExpenses.length > 0
        ? [
            [],
            ['Expenses requiring date review'],
            transactionRows[0],
            ...unknownDateExpenses.map((expense) => [
              expense.date || 'Unknown date',
              expense.merchant,
              canonicalCategory(expense.category),
              expense.description,
              exportAmount(expense.subtotal),
              exportAmount(expense.gst),
              exportAmount(expense.pst),
              exportAmount(expense.total),
              expense.attachmentName || (expense.attachmentData ? 'Receipt attached' : ''),
            ]),
          ]
        : []
      const workbook = XLSX.utils.book_new()
      const individualSheet = XLSX.utils.aoa_to_sheet([...transactionRows, ...unknownRows])
      individualSheet['!cols'] = [{ wch: 14 }, { wch: 24 }, { wch: 34 }, { wch: 38 }, { wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 16 }, { wch: 32 }]
      formatCurrencyColumns(individualSheet, [4, 5, 6, 7], transactionRows.length + unknownRows.length)
      XLSX.utils.book_append_sheet(workbook, individualSheet, 'Individual Expenses')
      const categoryRows = [
        ['Category', 'Number of expenses', 'Total expenses', 'Total GST', 'Total PST'],
        ...quarterCategories.map(({ category, count, total, gst, pst }) => [category, count, total / 100, gst / 100, pst / 100]),
      ]
      const categorySheet = XLSX.utils.aoa_to_sheet(categoryRows)
      formatCurrencyColumns(categorySheet, [2, 3, 4], categoryRows.length)
      XLSX.utils.book_append_sheet(workbook, categorySheet, 'Category Summary')
      const summarySheet = XLSX.utils.aoa_to_sheet([
        ['Quarter', selectedQuarter],
        ['Year', Number(selectedQuarterYear)],
        ['Total expenses', quarterTotal / 100],
        ['Total GST', quarterGst / 100],
        ['Total PST', quarterPst / 100],
        ['Number of transactions', quarterExpenses.length],
        ['Unknown dates for review (excluded from totals)', unknownDateExpenses.length],
      ])
      for (const cellAddress of ['B3', 'B4', 'B5']) {
        const cell = summarySheet[cellAddress]
        if (cell?.t === 'n') cell.z = '"$"#,##0.00'
      }
      XLSX.utils.book_append_sheet(workbook, summarySheet, 'Quarterly Tax Summary')
      const spreadsheet = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' })

      const receiptsZip = new JSZip()
      const seenReceiptHashes = new Set<string>()
      const receiptFailures: string[] = []
      const receiptPathsByExpense = new Map<string, string>()
      if (quarterExpenses.length > 0) {
        const { data: receiptRecords, error } = await supabase
          .from('fwf_expenses')
          .select('id, receipt_path')
          .in('id', quarterExpenses.map((expense) => expense.id))
          .eq('deleted', false)
        if (error) throw new Error(`Could not check Supabase receipt references: ${error.message}`)
        receiptRecords?.forEach((record) => {
          if (record.receipt_path) receiptPathsByExpense.set(record.id, record.receipt_path)
        })
      }
      for (const expense of quarterExpenses) {
        let receiptBlob: Blob | null = null
        let storageError: unknown
        const receiptPath = receiptPathsByExpense.get(expense.id) ?? `${expense.id}/receipt`
        try {
          const { data, error } = await supabase.storage.from('expense-receipts').download(receiptPath)
          if (error) storageError = error
          else receiptBlob = data
        } catch (error) {
          storageError = error
        }
        let localAttachmentError: unknown
        if (!receiptBlob && expense.attachmentData) {
          try {
            receiptBlob = dataUrlToBlob(expense.attachmentData)
          } catch (error) {
            localAttachmentError = error
          }
        }
        if (!receiptBlob) {
          const missingStorageObject = typeof storageError === 'object'
            && storageError !== null
            && 'statusCode' in storageError
            && String(storageError.statusCode) === '404'
          const hasReceiptReference = Boolean(receiptPathsByExpense.has(expense.id) || expense.attachmentData || expense.attachmentName)
          if (hasReceiptReference || (storageError && !missingStorageObject)) {
            const reason = localAttachmentError instanceof Error
              ? localAttachmentError.message
              : storageError instanceof Error
              ? storageError.message
              : storageError && typeof storageError === 'object' && 'message' in storageError
                ? String(storageError.message)
                : 'receipt could not be retrieved'
            receiptFailures.push(`${expense.merchant || 'Unnamed merchant'} (expense ${expense.id}): ${reason}`)
          }
          continue
        }
        try {
          const bytes = await receiptBlob.arrayBuffer()
          const digest = await crypto.subtle.digest('SHA-256', bytes)
          const receiptHash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
          if (seenReceiptHashes.has(receiptHash)) continue
          seenReceiptHashes.add(receiptHash)
          const originalName = expense.attachmentName || `receipt${expense.attachmentType === 'application/pdf' ? '.pdf' : ''}`
          const receiptName = `${isValidExpenseDate(expense.date) ? expense.date : 'unknown-date'}_${escapeFilePart(expense.merchant)}_${escapeFilePart(expense.id.slice(0, 8))}_${escapeFilePart(originalName)}`
          receiptsZip.file(receiptName, bytes)
        } catch (error) {
          const reason = error instanceof Error ? error.message : 'receipt could not be added to the ZIP'
          receiptFailures.push(`${expense.merchant || 'Unnamed merchant'} (expense ${expense.id}): ${reason}`)
        }
      }
      if (receiptFailures.length > 0) {
        receiptsZip.file('Receipt retrieval issues.txt', [
          'Receipts that could not be retrieved:',
          ...receiptFailures.map((failure) => `- ${failure}`),
          '',
        ].join('\n'))
      }
      const receiptArchive = await receiptsZip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } })
      const report = buildQuarterlyPdf(selectedQuarter, selectedQuarterYear, quarterExpenses, unknownDateExpenses, quarterTotals, quarterCategories)

      triggerDownload(report, `FWF-Hauling-${quarterLabel}-Quarterly-Report.pdf`)
      triggerDownload(new Blob([spreadsheet], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `FWF-Hauling-${quarterLabel}-Expenses.xlsx`)
      triggerDownload(receiptArchive, `FWF-Hauling-${quarterLabel}-Receipts.zip`)
      setExportMessage(`Downloads created for ${selectedQuarter} ${selectedQuarterYear}.`)
      if (receiptFailures.length > 0) {
        setExportError(`Some receipts could not be retrieved; see "Receipt retrieval issues.txt" in the ZIP:\n${receiptFailures.join('\n')}`)
      }
    } catch (error) {
      console.error('Could not export accountant files:', error)
      setExportError(error instanceof Error ? error.message : 'Could not create the accountant export.')
    } finally {
      setIsExporting(false)
    }
  }
  const monthlyTotals = [...filteredExpenses.reduce((totals, expense) => {
    const month = expense.date.slice(0, 7) || 'Unknown date'
    totals.set(month, (totals.get(month) ?? 0) + expenseTotal(expense))
    return totals
  }, new Map<string, number>())]
    .sort(([a], [b]) => b.localeCompare(a))
  const yearlyTotals = [...filteredExpenses.reduce((totals, expense) => {
    const year = expense.date.slice(0, 4) || 'Unknown date'
    totals.set(year, (totals.get(year) ?? 0) + expenseTotal(expense))
    return totals
  }, new Map<string, number>())]
    .sort(([a], [b]) => b.localeCompare(a))
  const toggleCategory = (category: string) => setExpandedCategories((current) => {
    const next = new Set(current)
    if (next.has(category)) next.delete(category)
    else next.add(category)
    return next
  })

  if (editingExpenseId && editingDraft) return (
    <section className="rounded-[28px] bg-white p-4 shadow-sm ring-1 ring-stone-200 sm:p-6">
      <div className="mb-5 flex items-start justify-between gap-3"><div><p className="text-xs font-semibold uppercase tracking-[0.2em] text-stone-500">Saved expense</p><h2 className="text-2xl font-black text-stone-900">Edit Expense</h2></div><PencilSquareIcon className="h-5 w-5 text-amber-900" /></div>
      {receiptError && <p role="alert" className="mb-3 text-sm text-red-700">{receiptError}</p>}
      <div className="grid gap-3 sm:grid-cols-2">{[['merchant', 'Merchant / Supplier'], ['date', 'Expense date'], ['subtotal', 'Subtotal'], ['gst', 'GST'], ['pst', 'PST'], ['total', 'Total']].map(([field, label]) => <label key={field} className="rounded-2xl bg-stone-50 p-3 ring-1 ring-stone-200"><span className="mb-2 block text-sm font-semibold">{label}</span><input type={field === 'date' ? 'date' : field === 'merchant' ? 'text' : 'number'} step={field === 'merchant' ? undefined : '0.01'} value={editingDraft[field as keyof ExpenseDraft]} onChange={(event) => updateEditingDraft(field as keyof ExpenseDraft, event.target.value)} className="w-full rounded-2xl border border-stone-300 bg-white px-4 py-3 outline-none focus:border-amber-700" /></label>)}
        <label className="rounded-2xl bg-stone-50 p-3 ring-1 ring-stone-200"><span className="mb-2 block text-sm font-semibold">Expense category</span><select value={editingDraft.category} onChange={(event) => updateEditingDraft('category', event.target.value)} className="w-full rounded-2xl border border-stone-300 bg-white px-4 py-3 outline-none">{CATEGORIES.map((category) => <option key={category}>{category}</option>)}</select></label>
        <label className="rounded-2xl bg-stone-50 p-3 ring-1 ring-stone-200 sm:col-span-2"><span className="mb-2 block text-sm font-semibold">Description / Notes</span><textarea value={editingDraft.description} onChange={(event) => updateEditingDraft('description', event.target.value)} rows={3} className="w-full rounded-2xl border border-stone-300 bg-white px-4 py-3 outline-none" /></label>
        <label className="rounded-2xl bg-stone-50 p-3 ring-1 ring-stone-200 sm:col-span-2"><span className="mb-2 block text-sm font-semibold">Receipt photo or document</span><input type="file" accept="image/jpeg,image/png,image/heic,image/heif,.heic,.heif,application/pdf,.pdf" onChange={(event) => event.target.files?.[0] && void replaceEditingAttachment(event.target.files[0])} className="block w-full text-sm text-stone-700" /><span className="mt-2 block text-xs text-stone-500">Attached: {editingDraft.attachmentName || 'None'}</span></label>
      </div>
      {editingDraft.attachmentData && <div className="mt-4 overflow-hidden rounded-2xl bg-stone-100 ring-1 ring-stone-200">{editingDraft.attachmentType === 'application/pdf' ? <iframe title={editingDraft.attachmentName} src={editingDraft.attachmentData} className="h-[min(70vh,720px)] w-full" /> : <img src={editingDraft.attachmentData} alt={editingDraft.attachmentName} className="max-h-[720px] w-full object-contain" />}</div>}
      <div className="mt-5 flex flex-wrap items-center gap-3"><button type="button" onClick={cancelEdit} className="rounded-2xl bg-stone-200 px-4 py-3 text-sm font-semibold text-stone-800">Cancel</button><button type="button" onClick={saveEditedExpense} className="flex items-center gap-2 rounded-2xl bg-amber-900 px-4 py-3 text-sm font-semibold text-white"><CheckCircleIcon className="h-5 w-5" />Save Changes</button></div>
    </section>
  )

  if (selectedExpense) return (
    <section className="rounded-[28px] bg-white p-4 shadow-sm ring-1 ring-stone-200 sm:p-6">
      <button type="button" onClick={() => setSelectedExpense(null)} className="mb-5 text-sm font-semibold text-amber-900">Back to Expenses</button>
      <h2 className="mb-5 text-2xl font-black text-stone-900">{selectedExpense.merchant || 'Unnamed merchant'}</h2>
      <div className="grid gap-3 sm:grid-cols-2">{[['Date', dateLabel(selectedExpense.date)], ['Category', canonicalCategory(selectedExpense.category)], ['Subtotal', formatAmount(selectedExpense.subtotal)], ['GST', formatAmount(selectedExpense.gst)], ['PST', formatAmount(selectedExpense.pst)], ['Total', formatAmount(selectedExpense.total)], ['Payment method', selectedExpense.paymentMethod || '—'], ['Currency', selectedExpense.currency || '—'], ['Receipt number', selectedExpense.invoiceNumber || '—'], ['Description', selectedExpense.description || '—'], ['Line items', selectedExpense.lineItems || '—']].map(([label, value]) => <div key={label} className="rounded-2xl bg-stone-50 p-3 ring-1 ring-stone-200"><p className="text-xs font-semibold text-stone-500">{label}</p><p className="mt-1 whitespace-pre-wrap text-sm font-semibold text-stone-900">{value}</p></div>)}</div>
      <div className="mt-5 overflow-hidden rounded-2xl bg-stone-100 ring-1 ring-stone-200">{selectedExpense.attachmentType === 'application/pdf' ? <iframe title={selectedExpense.attachmentName} src={selectedExpense.attachmentData} className="h-[min(70vh,720px)] w-full" /> : <img src={selectedExpense.attachmentData} alt={selectedExpense.attachmentName} className="max-h-[720px] w-full object-contain" />}</div>
      <p className="mt-2 text-xs text-stone-500">Attached: {selectedExpense.attachmentName}</p>
    </section>
  )

  if (draft) return (
    <section className="rounded-[28px] bg-white p-4 shadow-sm ring-1 ring-stone-200 sm:p-6">
      <div className="mb-5 flex items-start justify-between gap-3"><div><p className="text-xs font-semibold uppercase tracking-[0.2em] text-stone-500">Review before saving</p><h2 className="text-2xl font-black text-stone-900">Check receipt details</h2><p className="mt-1 text-sm text-stone-500">Confirm or edit every extracted field before saving.</p><p className="mt-2 text-sm font-semibold text-emerald-700">{processingMessage}</p></div><PencilSquareIcon className="h-5 w-5 text-amber-900" /></div>
      {receiptError && <p role="alert" className="mb-3 text-sm text-red-700">{receiptError}</p>}
      <div className="grid gap-3 sm:grid-cols-2">{[['merchant', 'Merchant'], ['date', 'Date'], ['subtotal', 'Subtotal'], ['gst', 'GST'], ['pst', 'PST'], ['total', 'Total'], ['invoiceNumber', 'Receipt number'], ['paymentMethod', 'Payment method']].map(([field, label]) => <label key={field} className="rounded-2xl bg-stone-50 p-3 ring-1 ring-stone-200"><span className="mb-2 block text-sm font-semibold">{label}</span><input type={field === 'date' ? 'date' : 'text'} value={draft[field as keyof ExpenseDraft]} onChange={(event) => updateDraft(field as keyof ExpenseDraft, event.target.value)} className="w-full rounded-2xl border border-stone-300 bg-white px-4 py-3 outline-none focus:border-amber-700" /></label>)}
        <label className="rounded-2xl bg-stone-50 p-3 ring-1 ring-stone-200"><span className="mb-2 block text-sm font-semibold">Category</span><select value={draft.category} onChange={(event) => updateDraft('category', event.target.value)} className="w-full rounded-2xl border border-stone-300 bg-white px-4 py-3 outline-none">{CATEGORIES.map((category) => <option key={category}>{category}</option>)}</select></label>
        <label className="rounded-2xl bg-stone-50 p-3 ring-1 ring-stone-200 sm:col-span-2"><span className="mb-2 block text-sm font-semibold">Description</span><textarea value={draft.description} onChange={(event) => updateDraft('description', event.target.value)} rows={3} className="w-full rounded-2xl border border-stone-300 bg-white px-4 py-3 outline-none" /></label>
      </div>
      <div className="mt-5 flex flex-wrap items-center gap-3"><button type="button" onClick={() => setDraft(null)} className="rounded-2xl bg-stone-200 px-4 py-3 text-sm font-semibold text-stone-800">Cancel</button><button type="button" onClick={saveExpense} className="flex items-center gap-2 rounded-2xl bg-amber-900 px-4 py-3 text-sm font-semibold text-white"><CheckCircleIcon className="h-5 w-5" /> Save Expense</button><span className="text-xs text-stone-500">Attached: {draft.attachmentName}</span></div>
    </section>
  )

  const years = [...new Set(expenses.map((expense) => expense.date.slice(0, 4)).filter(Boolean))].sort().reverse()

  return (
    <>
      <section className="space-y-4">
      <div className="rounded-[28px] bg-white p-4 shadow-sm ring-1 ring-stone-200 sm:p-6">
        <div className="mb-5 flex items-start justify-between gap-3"><div><p className="text-xs font-semibold uppercase tracking-[0.2em] text-stone-500">Business records</p><h2 className="text-2xl font-black text-stone-900">Expenses</h2><p className="mt-1 text-sm text-stone-500">Keep each receipt attached to its expense.</p></div><ReceiptPercentIcon className="h-7 w-7 text-amber-900" /></div>
        <div className="grid gap-3 md:grid-cols-3"><label aria-disabled={isScanning} className={captureButtonClass}><CameraIcon className="h-7 w-7 text-amber-900" /><span className="mt-2 text-sm font-bold">Take a Photo</span><input type="file" accept="image/*" capture="environment" disabled={isScanning} className="sr-only" onChange={(event) => event.target.files?.[0] && selectReceipt(event.target.files[0])} /></label><label aria-disabled={isScanning} className={captureButtonClass}><PhotoIcon className="h-7 w-7 text-amber-900" /><span className="mt-2 text-sm font-bold">Choose Photo</span><input type="file" accept="image/jpeg,image/png,image/heic,image/heif,.heic,.heif" disabled={isScanning} className="sr-only" onChange={(event) => event.target.files?.[0] && selectReceipt(event.target.files[0])} /></label><label aria-disabled={isScanning} className={captureButtonClass}><DocumentArrowUpIcon className="h-7 w-7 text-amber-900" /><span className="mt-2 text-sm font-bold">Upload Document</span><input type="file" accept="image/jpeg,image/png,image/heic,image/heif,.heic,.heif" disabled={isScanning} className="sr-only" onChange={(event) => event.target.files?.[0] && selectReceipt(event.target.files[0])} /></label></div>
        {scan && <ScanStatus key={scan.previewUrl ?? scan.fileName} scan={scan} />}
        {receiptError && <div role="alert" className="mt-4 flex flex-wrap items-center gap-3 text-sm text-red-700"><p>{receiptError}</p>{retryFile && <button type="button" onClick={() => selectReceipt(retryFile)} className="rounded-xl bg-red-100 px-3 py-2 font-semibold text-red-800">Retry</button>}</div>}
      </div>

      <div className="rounded-[28px] bg-white p-4 shadow-sm ring-1 ring-stone-200 sm:p-6">
        <div className="mb-4 flex items-center justify-between"><p className="text-sm font-semibold text-stone-900">Expense overview</p><span className="rounded-full bg-stone-100 px-3 py-1 text-xs font-bold text-stone-700">{filteredExpenses.length} of {expenses.length}</span></div>
        <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="rounded-2xl bg-stone-50 p-3 ring-1 ring-stone-200"><span className="mb-2 block text-sm font-semibold">Search merchant</span><input type="search" value={merchantSearch} onChange={(event) => setMerchantSearch(event.target.value)} placeholder="e.g. PBX Truck Service" className="w-full rounded-xl border border-stone-300 bg-white px-3 py-2 text-sm outline-none" /></label>
          <label className="rounded-2xl bg-stone-50 p-3 ring-1 ring-stone-200"><span className="mb-2 block text-sm font-semibold">Category</span><select value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)} className="w-full rounded-xl border border-stone-300 bg-white px-3 py-2 text-sm outline-none"><option>All categories</option>{CATEGORIES.map((category) => <option key={category}>{category}</option>)}</select></label>
          <label className="rounded-2xl bg-stone-50 p-3 ring-1 ring-stone-200"><span className="mb-2 block text-sm font-semibold">Start date</span><input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} className="w-full rounded-xl border border-stone-300 bg-white px-3 py-2 text-sm outline-none" /></label>
          <label className="rounded-2xl bg-stone-50 p-3 ring-1 ring-stone-200"><span className="mb-2 block text-sm font-semibold">End date</span><input type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} className="w-full rounded-xl border border-stone-300 bg-white px-3 py-2 text-sm outline-none" /></label>
          <label className="rounded-2xl bg-stone-50 p-3 ring-1 ring-stone-200"><span className="mb-2 block text-sm font-semibold">Month</span><input type="month" value={monthFilter} onChange={(event) => setMonthFilter(event.target.value)} className="w-full rounded-xl border border-stone-300 bg-white px-3 py-2 text-sm outline-none" /></label>
          <label className="rounded-2xl bg-stone-50 p-3 ring-1 ring-stone-200"><span className="mb-2 block text-sm font-semibold">Year</span><select value={yearFilter} onChange={(event) => setYearFilter(event.target.value)} className="w-full rounded-xl border border-stone-300 bg-white px-3 py-2 text-sm outline-none"><option value="">All years</option>{years.map((year) => <option key={year}>{year}</option>)}</select></label>
          <button type="button" onClick={clearFilters} className="rounded-2xl bg-stone-200 px-4 py-3 text-sm font-semibold text-stone-800 sm:self-end">Clear all filters</button>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-2xl bg-amber-50 p-4 ring-1 ring-amber-200"><p className="text-xs font-semibold uppercase tracking-wide text-amber-900">Selected period total</p><p className="mt-1 text-xl font-black text-amber-950">{formatAmount(filteredTotal.toFixed(2))}</p></div>
          <div className="rounded-2xl bg-stone-50 p-4 ring-1 ring-stone-200"><p className="text-xs font-semibold uppercase tracking-wide text-stone-500">Categories</p><p className="mt-1 text-xl font-black text-stone-900">{categoryGroups.length}</p></div>
          <div className="rounded-2xl bg-stone-50 p-4 ring-1 ring-stone-200"><p className="text-xs font-semibold uppercase tracking-wide text-stone-500">Monthly totals</p><p className="mt-1 text-xl font-black text-stone-900">{monthlyTotals.length}</p></div>
          <div className="rounded-2xl bg-stone-50 p-4 ring-1 ring-stone-200"><p className="text-xs font-semibold uppercase tracking-wide text-stone-500">Yearly totals</p><p className="mt-1 text-xl font-black text-stone-900">{yearlyTotals.length}</p></div>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(260px,1fr)]">
        <div className="rounded-[28px] bg-white p-4 shadow-sm ring-1 ring-stone-200 sm:p-6">
          <div className="mb-4 flex items-center justify-between"><p className="text-sm font-semibold text-stone-900">Expenses by category</p><span className="text-xs text-stone-500">Newest first</span></div>
          {categoryGroups.length === 0 ? <p className="rounded-2xl bg-stone-50 p-5 text-sm text-stone-500">No expenses match the selected filters.</p> : <div className="space-y-3">{categoryGroups.map(({ category, items, total, gst, pst }) => {
            const isExpanded = expandedCategories.has(category)
            return <div key={category} className="overflow-hidden rounded-2xl ring-1 ring-stone-200"><button type="button" onClick={() => toggleCategory(category)} aria-expanded={isExpanded} className="flex w-full items-center justify-between gap-3 bg-stone-50 p-4 text-left"><span><span className="block font-semibold text-stone-900">{category}</span><span className="mt-1 block text-xs text-stone-500">{items.length} expense{items.length === 1 ? '' : 's'}</span><span className="mt-1 block text-xs text-stone-600">GST: {formatCents(gst)} <span className="mx-1">|</span> PST: {formatCents(pst)}</span></span><span className="flex items-center gap-3"><span className="font-bold text-amber-900">{formatCents(total)}</span><span className="text-stone-500">{isExpanded ? '−' : '+'}</span></span></button>{isExpanded && <div className="grid gap-2 p-3">{items.map((expense) => <div key={expense.id} className="relative flex rounded-xl bg-white ring-1 ring-stone-200"><button type="button" onTouchStart={() => { longPressActivated.current = false; if (longPressTimer.current) clearTimeout(longPressTimer.current); longPressTimer.current = setTimeout(() => { longPressActivated.current = true; setExpenseMenuId(expense.id) }, 650) }} onTouchEnd={() => { if (longPressTimer.current) clearTimeout(longPressTimer.current) }} onTouchCancel={() => { if (longPressTimer.current) clearTimeout(longPressTimer.current) }} onContextMenu={(event) => { event.preventDefault(); setExpenseMenuId(expense.id) }} onClick={() => { if (longPressActivated.current) { longPressActivated.current = false; return } startEdit(expense) }} className="grid min-w-0 flex-1 gap-1 p-4 text-left transition hover:bg-amber-50 sm:grid-cols-[1fr,1fr,auto] sm:items-center"><span className="font-semibold text-stone-900">{dateLabel(expense.date)}</span><span className="text-sm text-stone-700">{expense.merchant || 'Unnamed merchant'}</span><span className="font-bold text-amber-900">{formatAmount(expense.total)}</span></button><button type="button" aria-label={`Expense options for ${expense.merchant || 'Unnamed merchant'}`} onClick={() => setExpenseMenuId((current) => current === expense.id ? null : expense.id)} className="flex w-12 shrink-0 items-center justify-center rounded-r-xl text-stone-600 hover:bg-stone-100"><EllipsisHorizontalIcon className="h-6 w-6" /></button>{expenseMenuId === expense.id && <div className="absolute right-3 top-12 z-20 w-36 rounded-xl bg-white p-1 shadow-lg ring-1 ring-stone-200"><button type="button" onClick={() => startEdit(expense)} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-semibold text-stone-800 hover:bg-stone-100"><PencilSquareIcon className="h-4 w-4" />Edit</button><button type="button" onClick={() => { setExpenseMenuId(null); setDeleteExpenseId(expense.id) }} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-semibold text-red-700 hover:bg-red-50"><TrashIcon className="h-4 w-4" />Delete</button></div>}</div>)}</div>}</div>
          })}</div>}
        </div>
        <div className="space-y-4">
          <div className="rounded-[28px] bg-white p-4 shadow-sm ring-1 ring-stone-200"><p className="mb-3 text-sm font-semibold text-stone-900">Monthly spending</p>{monthlyTotals.length === 0 ? <p className="text-sm text-stone-500">No monthly totals.</p> : <div className="space-y-2">{monthlyTotals.map(([month, total]) => <div key={month} className="flex items-center justify-between rounded-xl bg-stone-50 px-3 py-2"><span className="text-sm text-stone-700">{monthLabel(month)}</span><span className="font-bold text-amber-900">{formatAmount(total.toFixed(2))}</span></div>)}</div>}</div>
          <div className="rounded-[28px] bg-white p-4 shadow-sm ring-1 ring-stone-200"><p className="mb-3 text-sm font-semibold text-stone-900">Yearly spending</p>{yearlyTotals.length === 0 ? <p className="text-sm text-stone-500">No yearly totals.</p> : <div className="space-y-2">{yearlyTotals.map(([year, total]) => <div key={year} className="flex items-center justify-between rounded-xl bg-stone-50 px-3 py-2"><span className="text-sm text-stone-700">{year}</span><span className="font-bold text-amber-900">{formatAmount(total.toFixed(2))}</span></div>)}</div>}</div>
        </div>
      </div>
      <div className="mb-4 rounded-2xl bg-amber-50 p-4 ring-1 ring-amber-200">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div><p className="text-xs font-semibold uppercase tracking-wide text-amber-900">Quarterly tax summary</p><h3 className="mt-1 text-lg font-black text-amber-950">{selectedQuarter} {selectedQuarterYear}</h3></div>
          <div className="flex gap-2">
            <label className="text-sm font-semibold text-stone-700"><span className="sr-only">Quarter</span><select aria-label="Quarter" value={selectedQuarter} onChange={(event) => setSelectedQuarter(event.target.value)} className="rounded-xl border border-stone-300 bg-white px-3 py-2"><option value="Q1">Q1 (January–March)</option><option value="Q2">Q2 (April–June)</option><option value="Q3">Q3 (July–September)</option><option value="Q4">Q4 (October–December)</option></select></label>
            <label className="text-sm font-semibold text-stone-700"><span className="sr-only">Year</span><select aria-label="Year" value={selectedQuarterYear} onChange={(event) => setSelectedQuarterYear(event.target.value)} className="rounded-xl border border-stone-300 bg-white px-3 py-2">{quarterYears.map((year) => <option key={year}>{year}</option>)}</select></label>
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-xl bg-white p-3"><p className="text-xs font-semibold text-stone-500">Total expenses</p><p className="mt-1 font-black text-stone-900">{formatCents(quarterTotal)}</p></div>
          <div className="rounded-xl bg-white p-3"><p className="text-xs font-semibold text-stone-500">Total GST</p><p className="mt-1 font-black text-stone-900">{formatCents(quarterGst)}</p></div>
          <div className="rounded-xl bg-white p-3"><p className="text-xs font-semibold text-stone-500">Total PST</p><p className="mt-1 font-black text-stone-900">{formatCents(quarterPst)}</p></div>
        </div>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[480px] text-left text-sm">
            <thead><tr className="text-xs text-stone-500"><th className="pb-2 pr-3 font-semibold">Category</th><th className="pb-2 pr-3 font-semibold">Expenses</th><th className="pb-2 pr-3 font-semibold">GST</th><th className="pb-2 font-semibold">PST</th></tr></thead>
            <tbody>{quarterCategories.map(({ category, count, total, gst, pst }) => <tr key={category} className="border-t border-amber-100"><th className="py-2 pr-3 font-semibold text-stone-800">{category}</th><td className="py-2 pr-3 text-stone-700">{formatCents(total)} <span className="text-xs text-stone-500">({count})</span></td><td className="py-2 pr-3 text-stone-700">{formatCents(gst)}</td><td className="py-2 text-stone-700">{formatCents(pst)}</td></tr>)}</tbody>
          </table>
        </div>
        {exportError && <p role="alert" className="mt-3 text-sm text-red-800">{exportError}</p>}
        {exportMessage && <p role="status" className="mt-3 text-sm font-semibold text-emerald-800">{exportMessage}</p>}
        <button type="button" onClick={() => void exportAccountantFiles()} disabled={isExporting} className="mt-4 flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl bg-amber-900 px-4 py-3 text-center text-sm font-bold text-white transition hover:bg-amber-950 disabled:cursor-wait disabled:opacity-70">
          <DocumentArrowUpIcon className="h-5 w-5" />
          {isExporting ? 'Preparing Accountant Export…' : 'Accountant Export / Download'}
        </button>
      </div>
      </section>
      {deleteExpenseId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-stone-950/40 p-4" role="dialog" aria-modal="true" aria-label="Delete expense confirmation">
          <div className="w-full max-w-sm rounded-[24px] bg-white p-5 shadow-xl ring-1 ring-stone-200">
            <h2 className="text-lg font-black text-stone-900">Delete expense?</h2>
            <p className="mt-2 text-sm text-stone-600">Are you sure you want to permanently delete this expense?</p>
            {receiptError && <p role="alert" className="mt-3 text-sm text-red-700">{receiptError}</p>}
            <div className="mt-5 flex justify-end gap-3"><button type="button" onClick={() => setDeleteExpenseId(null)} className="rounded-xl bg-stone-200 px-4 py-2 text-sm font-semibold text-stone-800">Cancel</button><button type="button" onClick={confirmDelete} className="rounded-xl bg-red-700 px-4 py-2 text-sm font-semibold text-white">Delete</button></div>
          </div>
        </div>
      )}
    </>
  )
}

export default ExpenseTracker
