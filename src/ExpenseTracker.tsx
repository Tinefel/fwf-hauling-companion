import { useEffect, useState } from 'react'
import { CameraIcon, CheckCircleIcon, DocumentArrowUpIcon, PencilSquareIcon, PhotoIcon, ReceiptPercentIcon } from '@heroicons/react/24/outline'

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
type GeminiReceipt = {
  merchant: string | null
  date: string | null
  subtotal: number | null
  gst: number | null
  pst: number | null
  total: number | null
  receiptNumber: string | null
  invoiceNumber: string | null
  category: string | null
  paymentMethod: string | null
  currency: string | null
  lineItems: Array<{ description: string | null; quantity: number | null; unitPrice: number | null; amount: number | null }>
}

const CATEGORIES = ['Fuel / Gas', 'Maintenance & Repairs', 'Tires', 'Parts', 'Vehicle / Truck', 'Insurance', 'Registration / Licensing', 'Tolls', 'Office', 'Phone / Communications', 'Supplies', 'Meals', 'Professional Services', 'Advertising / Marketing', 'Trailer', 'Equipment', 'Miscellaneous']
const emptyDraft: ExpenseDraft = {
  merchant: '', date: '', category: 'Other', subtotal: '', gst: '', pst: '', total: '', invoiceNumber: '', description: '', paymentMethod: '', currency: 'CAD', lineItems: '', attachmentName: '', attachmentType: '', attachmentData: '',
}
const CLIENT_TIMEOUT_MS = 10_000
const PDF_CLIENT_TIMEOUT_MS = 45_000

const clientTimeoutFor = (file: File) => file.type === 'application/pdf' ? PDF_CLIENT_TIMEOUT_MS : CLIENT_TIMEOUT_MS

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
const toGeminiImage = async (file: File) => {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return { mimeType: file.type || 'application/octet-stream', data: btoa(binary) }
}
const readReceiptWithGemini = async (file: File) => {
  const timeoutMs = clientTimeoutFor(file)
  const image = await withTimeout(toGeminiImage(file), timeoutMs, 'Preparing receipt image timed out')
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await withTimeout((async () => {
      const response = await fetch('/api/receipt', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(image), signal: controller.signal })
      const body = await response.json().catch(() => null) as { error?: string } | GeminiReceipt | null
      if (!response.ok) throw new Error(body && 'error' in body && body.error ? body.error : 'Gemini receipt scanning failed')
      return body as GeminiReceipt
    })(), timeoutMs, 'Gemini receipt scanning timed out')
  } catch (error) {
    if (controller.signal.aborted) throw new Error('Gemini receipt scanning timed out', { cause: error })
    throw error
  } finally {
    clearTimeout(timeoutId)
  }
}
const normalizeCategory = (value: string | null) => CATEGORIES.find((category) => category.toLowerCase() === value?.toLowerCase()) ?? 'Other'
const normalizeDate = (value: string | null) => {
  if (!value) return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10)
}
const geminiToDraft = (receipt: GeminiReceipt, isPdf: boolean): Partial<ExpenseDraft> => ({
  merchant: receipt.merchant ?? '', date: normalizeDate(receipt.date), category: normalizeCategory(receipt.category),
  subtotal: receipt.subtotal == null ? '' : receipt.subtotal.toFixed(2), gst: receipt.gst == null ? '' : receipt.gst.toFixed(2),
  pst: receipt.pst == null ? '' : receipt.pst.toFixed(2), total: receipt.total == null ? '' : receipt.total.toFixed(2),
  invoiceNumber: receipt.invoiceNumber ?? receipt.receiptNumber ?? '', paymentMethod: receipt.paymentMethod ?? '', currency: receipt.currency ?? '',
  description: isPdf
    ? `${receipt.merchant ?? 'Invoice'} - ${receipt.lineItems.some((item) => /spindle|brake|drum/i.test(item.description ?? '')) ? 'Spindle replacement parts' : `${receipt.category ?? 'Invoice'} items`}`
    : receipt.lineItems.map((item) => item.description).filter((item): item is string => Boolean(item)).join(', '),
  lineItems: receipt.lineItems.map((item) => [item.description, item.quantity == null ? '' : `qty ${item.quantity}`, item.unitPrice == null ? '' : `unit ${item.unitPrice.toFixed(2)}`, item.amount == null ? '' : `amount ${item.amount.toFixed(2)}`].filter(Boolean).join(' | ')).join('\n'),
})
const formatAmount = (value: string) => value && Number.isFinite(Number(value)) ? new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(Number(value)) : '—'
const dateLabel = (value: string) => value ? new Date(`${value}T00:00:00`).toLocaleDateString('en-CA', { dateStyle: 'medium' }) : '—'

function ExpenseTracker({ expenses, onExpensesChange }: ExpenseTrackerProps) {
  const [draft, setDraft] = useState<ExpenseDraft | null>(null)
  const [selectedExpense, setSelectedExpense] = useState<ExpenseRecord | null>(null)
  const [isProcessing, setIsProcessing] = useState(false)
  const [processingMessage, setProcessingMessage] = useState('')
  const [receiptError, setReceiptError] = useState('')
  const [retryFile, setRetryFile] = useState<File | null>(null)

  useEffect(() => {
    const fileInputs = document.querySelectorAll<HTMLInputElement>('input[type="file"]')
    const documentInput = fileInputs[2]
    if (documentInput) documentInput.accept = 'application/pdf,.pdf,image/jpeg,image/png,image/heic,image/heif,.heic,.heif'
  }, [])

  const selectReceipt = async (file: File) => {
    const timeoutMs = clientTimeoutFor(file)
    setIsProcessing(true); setReceiptError(''); setRetryFile(file); setDraft(null); setProcessingMessage('Processing receipt...')
    try {
      const [receipt, attachmentData] = await Promise.all([readReceiptWithGemini(file), withTimeout(readDataUrl(file), timeoutMs, 'Attaching receipt timed out')])
      setDraft({ ...emptyDraft, ...geminiToDraft(receipt, file.type === 'application/pdf'), attachmentName: file.name, attachmentType: file.type || 'application/octet-stream', attachmentData })
      setProcessingMessage('Receipt information found. Review the fields before saving.')
    } catch (error) {
      setReceiptError(error instanceof Error ? error.message : 'Receipt scanning failed. Please try again.')
      setProcessingMessage('Receipt scanning failed.')
    } finally {
      setIsProcessing(false)
    }
  }
  const updateDraft = (field: keyof ExpenseDraft, value: string) => setDraft((current) => current ? { ...current, [field]: value } : current)
  const saveExpense = () => {
    if (!draft?.attachmentData) return
    onExpensesChange([{ ...draft, id: crypto.randomUUID(), createdAt: new Date().toISOString() }, ...expenses]); setDraft(null); setRetryFile(null); setProcessingMessage('')
  }

  if (selectedExpense) return (
    <section className="rounded-[28px] bg-white p-4 shadow-sm ring-1 ring-stone-200 sm:p-6">
      <button type="button" onClick={() => setSelectedExpense(null)} className="mb-5 text-sm font-semibold text-amber-900">Back to Expenses</button>
      <h2 className="mb-5 text-2xl font-black text-stone-900">{selectedExpense.merchant || 'Unnamed merchant'}</h2>
      <div className="grid gap-3 sm:grid-cols-2">{[['Date', dateLabel(selectedExpense.date)], ['Category', selectedExpense.category], ['Subtotal', formatAmount(selectedExpense.subtotal)], ['GST', formatAmount(selectedExpense.gst)], ['PST', formatAmount(selectedExpense.pst)], ['Total', formatAmount(selectedExpense.total)], ['Payment method', selectedExpense.paymentMethod || '—'], ['Currency', selectedExpense.currency || '—'], ['Receipt number', selectedExpense.invoiceNumber || '—'], ['Description', selectedExpense.description || '—'], ['Line items', selectedExpense.lineItems || '—']].map(([label, value]) => <div key={label} className="rounded-2xl bg-stone-50 p-3 ring-1 ring-stone-200"><p className="text-xs font-semibold text-stone-500">{label}</p><p className="mt-1 whitespace-pre-wrap text-sm font-semibold text-stone-900">{value}</p></div>)}</div>
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

  return <section className="space-y-4"><div className="rounded-[28px] bg-white p-4 shadow-sm ring-1 ring-stone-200 sm:p-6"><div className="mb-5 flex items-start justify-between gap-3"><div><p className="text-xs font-semibold uppercase tracking-[0.2em] text-stone-500">Business records</p><h2 className="text-2xl font-black text-stone-900">Expenses</h2><p className="mt-1 text-sm text-stone-500">Keep each receipt attached to its expense.</p></div><ReceiptPercentIcon className="h-7 w-7 text-amber-900" /></div><div className="grid gap-3 md:grid-cols-3"><label className="flex cursor-pointer flex-col items-center justify-center rounded-2xl bg-stone-50 p-5 text-center ring-1 ring-stone-200 transition hover:bg-amber-50"><CameraIcon className="h-7 w-7 text-amber-900" /><span className="mt-2 text-sm font-bold">Take a Photo</span><input type="file" accept="image/*" capture="environment" className="sr-only" onChange={(event) => event.target.files?.[0] && selectReceipt(event.target.files[0])} /></label><label className="flex cursor-pointer flex-col items-center justify-center rounded-2xl bg-stone-50 p-5 text-center ring-1 ring-stone-200 transition hover:bg-amber-50"><PhotoIcon className="h-7 w-7 text-amber-900" /><span className="mt-2 text-sm font-bold">Choose Photo</span><input type="file" accept="image/jpeg,image/png,image/heic,image/heif,.heic,.heif" className="sr-only" onChange={(event) => event.target.files?.[0] && selectReceipt(event.target.files[0])} /></label><label className="flex cursor-pointer flex-col items-center justify-center rounded-2xl bg-stone-50 p-5 text-center ring-1 ring-stone-200 transition hover:bg-amber-50"><DocumentArrowUpIcon className="h-7 w-7 text-amber-900" /><span className="mt-2 text-sm font-bold">Upload Document</span><input type="file" accept="image/jpeg,image/png,image/heic,image/heif,.heic,.heif" className="sr-only" onChange={(event) => event.target.files?.[0] && selectReceipt(event.target.files[0])} /></label></div>{isProcessing && <p className="mt-4 text-sm text-stone-500">Processing receipt...</p>}{receiptError && <div className="mt-4 flex flex-wrap items-center gap-3 text-sm text-red-700"><p>{receiptError}</p>{retryFile && <button type="button" onClick={() => selectReceipt(retryFile)} className="rounded-xl bg-red-100 px-3 py-2 font-semibold text-red-800">Retry</button>}</div>}</div><div className="rounded-[28px] bg-white p-4 shadow-sm ring-1 ring-stone-200 sm:p-6"><div className="mb-4 flex items-center justify-between"><p className="text-sm font-semibold text-stone-900">Saved expenses</p><span className="rounded-full bg-stone-100 px-3 py-1 text-xs font-bold text-stone-700">{expenses.length}</span></div>{expenses.length === 0 ? <p className="rounded-2xl bg-stone-50 p-5 text-sm text-stone-500">No expenses saved yet.</p> : <div className="grid gap-2">{expenses.map((expense) => <button key={expense.id} type="button" onClick={() => setSelectedExpense(expense)} className="grid gap-1 rounded-2xl bg-stone-50 p-4 text-left ring-1 ring-stone-200 transition hover:bg-amber-50 sm:grid-cols-[1fr,1fr,1fr,auto] sm:items-center"><span className="font-semibold text-stone-900">{dateLabel(expense.date)}</span><span className="text-sm text-stone-700">{expense.merchant || 'Unnamed merchant'}</span><span className="text-sm text-stone-600">{expense.category}</span><span className="font-bold text-amber-900">{formatAmount(expense.total)}</span></button>)}</div>}</div></section>
}

export type { ExpenseRecord }
export default ExpenseTracker
