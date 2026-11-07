import { useEffect, useRef, useState } from 'react'
import { CameraIcon, CheckCircleIcon, DocumentArrowUpIcon, DocumentTextIcon, EllipsisHorizontalIcon, PencilSquareIcon, PhotoIcon, ReceiptPercentIcon, TrashIcon, TruckIcon } from '@heroicons/react/24/outline'
import type { ExtractedReceipt, ReceiptApiResponse, ReceiptTimings } from './receiptTypes'

type ExpenseRecord = {
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

type ExpenseTrackerProps = {
  expenses: ExpenseRecord[]
  onExpensesChange: (expenses: ExpenseRecord[]) => void
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
const dateLabel = (value: string) => value ? new Date(`${value}T00:00:00`).toLocaleDateString('en-CA', { dateStyle: 'medium' }) : '—'
const monthLabel = (value: string) => value === 'Unknown date' ? value : new Date(`${value}-01T00:00:00`).toLocaleDateString('en-CA', { month: 'long', year: 'numeric' })
const expenseTotal = (expense: ExpenseRecord) => Number.isFinite(Number(expense.total)) ? Number(expense.total) : 0
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

  useEffect(() => {
    const migrated = expenses.map((expense) => {
      const category = canonicalCategory(expense.category)
      return expense.category === category ? expense : { ...expense, category }
    })
    if (migrated.some((expense, index) => expense.category !== expenses[index].category)) {
      onExpensesChange(migrated)
    }
  }, [expenses, onExpensesChange])

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
  const saveExpense = () => {
    if (!draft?.attachmentData) return
    onExpensesChange([{ ...draft, id: crypto.randomUUID(), createdAt: new Date().toISOString() }, ...expenses]); setDraft(null); setRetryFile(null); setProcessingMessage('')
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
  const saveEditedExpense = () => {
    if (!editingExpenseId || !editingDraft) return
    onExpensesChange(expenses.map((expense) => expense.id === editingExpenseId ? { ...editingDraft, id: expense.id, createdAt: expense.createdAt } : expense))
    setEditingExpenseId(null)
    setEditingDraft(null)
  }
  const cancelEdit = () => {
    setEditingExpenseId(null)
    setEditingDraft(null)
  }
  const confirmDelete = () => {
    if (!deleteExpenseId) return
    onExpensesChange(expenses.filter((expense) => expense.id !== deleteExpenseId))
    setDeleteExpenseId(null)
    setExpenseMenuId(null)
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
    return { category, items, total: items.reduce((sum, expense) => sum + expenseTotal(expense), 0) }
  }).filter((group) => group.items.length > 0)
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
          {categoryGroups.length === 0 ? <p className="rounded-2xl bg-stone-50 p-5 text-sm text-stone-500">No expenses match the selected filters.</p> : <div className="space-y-3">{categoryGroups.map(({ category, items, total }) => {
            const isExpanded = !expandedCategories.has(category)
            return <div key={category} className="overflow-hidden rounded-2xl ring-1 ring-stone-200"><button type="button" onClick={() => toggleCategory(category)} aria-expanded={isExpanded} className="flex w-full items-center justify-between gap-3 bg-stone-50 p-4 text-left"><span><span className="block font-semibold text-stone-900">{category}</span><span className="mt-1 block text-xs text-stone-500">{items.length} expense{items.length === 1 ? '' : 's'}</span></span><span className="flex items-center gap-3"><span className="font-bold text-amber-900">{formatAmount(total.toFixed(2))}</span><span className="text-stone-500">{isExpanded ? '−' : '+'}</span></span></button>{isExpanded && <div className="grid gap-2 p-3">{items.map((expense) => <div key={expense.id} className="relative flex rounded-xl bg-white ring-1 ring-stone-200"><button type="button" onTouchStart={() => { longPressActivated.current = false; if (longPressTimer.current) clearTimeout(longPressTimer.current); longPressTimer.current = setTimeout(() => { longPressActivated.current = true; setExpenseMenuId(expense.id) }, 650) }} onTouchEnd={() => { if (longPressTimer.current) clearTimeout(longPressTimer.current) }} onTouchCancel={() => { if (longPressTimer.current) clearTimeout(longPressTimer.current) }} onContextMenu={(event) => { event.preventDefault(); setExpenseMenuId(expense.id) }} onClick={() => { if (longPressActivated.current) { longPressActivated.current = false; return } startEdit(expense) }} className="grid min-w-0 flex-1 gap-1 p-4 text-left transition hover:bg-amber-50 sm:grid-cols-[1fr,1fr,auto] sm:items-center"><span className="font-semibold text-stone-900">{dateLabel(expense.date)}</span><span className="text-sm text-stone-700">{expense.merchant || 'Unnamed merchant'}</span><span className="font-bold text-amber-900">{formatAmount(expense.total)}</span></button><button type="button" aria-label={`Expense options for ${expense.merchant || 'Unnamed merchant'}`} onClick={() => setExpenseMenuId((current) => current === expense.id ? null : expense.id)} className="flex w-12 shrink-0 items-center justify-center rounded-r-xl text-stone-600 hover:bg-stone-100"><EllipsisHorizontalIcon className="h-6 w-6" /></button>{expenseMenuId === expense.id && <div className="absolute right-3 top-12 z-20 w-36 rounded-xl bg-white p-1 shadow-lg ring-1 ring-stone-200"><button type="button" onClick={() => startEdit(expense)} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-semibold text-stone-800 hover:bg-stone-100"><PencilSquareIcon className="h-4 w-4" />Edit</button><button type="button" onClick={() => { setExpenseMenuId(null); setDeleteExpenseId(expense.id) }} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-semibold text-red-700 hover:bg-red-50"><TrashIcon className="h-4 w-4" />Delete</button></div>}</div>)}</div>}</div>
          })}</div>}
        </div>
        <div className="space-y-4">
          <div className="rounded-[28px] bg-white p-4 shadow-sm ring-1 ring-stone-200"><p className="mb-3 text-sm font-semibold text-stone-900">Monthly spending</p>{monthlyTotals.length === 0 ? <p className="text-sm text-stone-500">No monthly totals.</p> : <div className="space-y-2">{monthlyTotals.map(([month, total]) => <div key={month} className="flex items-center justify-between rounded-xl bg-stone-50 px-3 py-2"><span className="text-sm text-stone-700">{monthLabel(month)}</span><span className="font-bold text-amber-900">{formatAmount(total.toFixed(2))}</span></div>)}</div>}</div>
          <div className="rounded-[28px] bg-white p-4 shadow-sm ring-1 ring-stone-200"><p className="mb-3 text-sm font-semibold text-stone-900">Yearly spending</p>{yearlyTotals.length === 0 ? <p className="text-sm text-stone-500">No yearly totals.</p> : <div className="space-y-2">{yearlyTotals.map(([year, total]) => <div key={year} className="flex items-center justify-between rounded-xl bg-stone-50 px-3 py-2"><span className="text-sm text-stone-700">{year}</span><span className="font-bold text-amber-900">{formatAmount(total.toFixed(2))}</span></div>)}</div>}</div>
        </div>
      </div>
      </section>
      {deleteExpenseId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-stone-950/40 p-4" role="dialog" aria-modal="true" aria-label="Delete expense confirmation">
          <div className="w-full max-w-sm rounded-[24px] bg-white p-5 shadow-xl ring-1 ring-stone-200">
            <h2 className="text-lg font-black text-stone-900">Delete expense?</h2>
            <p className="mt-2 text-sm text-stone-600">Are you sure you want to permanently delete this expense?</p>
            <div className="mt-5 flex justify-end gap-3"><button type="button" onClick={() => setDeleteExpenseId(null)} className="rounded-xl bg-stone-200 px-4 py-2 text-sm font-semibold text-stone-800">Cancel</button><button type="button" onClick={confirmDelete} className="rounded-xl bg-red-700 px-4 py-2 text-sm font-semibold text-white">Delete</button></div>
          </div>
        </div>
      )}
    </>
  )
}

export type { ExpenseRecord }
export default ExpenseTracker
