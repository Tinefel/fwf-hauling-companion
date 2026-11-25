import { useEffect, useRef, useState } from 'react'
import { CameraIcon, CheckCircleIcon, DocumentArrowUpIcon, DocumentTextIcon, EllipsisHorizontalIcon, PencilSquareIcon, PhotoIcon, ReceiptPercentIcon, TrashIcon, TruckIcon } from '@heroicons/react/24/outline'
import JSZip from 'jszip'
import * as XLSX from 'xlsx'
import type { ExtractedReceipt, ReceiptApiResponse, ReceiptTimings } from './receiptTypes'
import { findDuplicateMatches, getExpenseWarnings, type DuplicateMatch, type ExpenseWarning } from './expenseReview'

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
const receiptToDraft = (receipt: ExtractedReceipt): Partial<ExpenseDraft> => ({
  merchant: receipt.vendor ?? '', date: normalizeDate(receipt.date), category: receipt.category ? normalizeCategory(receipt.category) : '',
  subtotal: receipt.subtotal == null ? '' : receipt.subtotal.toFixed(2), gst: receipt.gst == null ? '' : receipt.gst.toFixed(2),
  pst: receipt.pst == null ? '' : receipt.pst.toFixed(2), total: receipt.total == null ? '' : receipt.total.toFixed(2),
  invoiceNumber: receipt.receiptNumber ?? '', paymentMethod: receipt.paymentMethod ?? '',
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
const isValidExpenseDate = (value: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
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
const errorMessage = (error: unknown, fallback: string) => {
  if (error instanceof Error) return error.message
  if (typeof error === 'object' && error !== null && 'message' in error) return String(error.message)
  return fallback
}
const attachmentFromDataUrl = (dataUrl: string, fallbackType: string) => {
  const separator = dataUrl.indexOf(',')
  if (!dataUrl.startsWith('data:') || separator < 0) throw new Error('Saved receipt data is invalid')
  const metadata = dataUrl.slice(5, separator)
  const content = dataUrl.slice(separator + 1)
  const mimeType = metadata.split(';')[0] || fallbackType || 'application/octet-stream'
  const binary = metadata.toLowerCase().includes(';base64')
    ? atob(content)
    : decodeURIComponent(content)
  const bytes = metadata.toLowerCase().includes(';base64')
    ? Uint8Array.from(binary, (character) => character.charCodeAt(0))
    : new TextEncoder().encode(binary)
  return { bytes, mimeType, blob: new Blob([bytes], { type: mimeType }) }
}
const receiptFilenamePart = (value: string) => value
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-zA-Z0-9._-]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 60) || 'Unknown'
const receiptExtension = (name: string, mimeType: string) => {
  const originalExtension = /\.([a-z0-9]{1,10})$/i.exec(name)?.[1]
  if (originalExtension) return originalExtension
  const extensions: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/heic': 'heic',
    'image/heif': 'heif',
    'application/pdf': 'pdf',
  }
  return extensions[mimeType] || 'bin'
}
type PackagedReceipt = {
  filename: string
  isImage: boolean
  thumbnail?: { bytes: Uint8Array; width: number; height: number }
}
const sha256 = async (bytes: Uint8Array) => {
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)
  const digest = await crypto.subtle.digest('SHA-256', buffer)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}
const createReceiptThumbnail = async (blob: Blob) => {
  const url = URL.createObjectURL(blob)
  try {
    const image = new Image()
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve()
      image.onerror = () => reject(new Error('The browser could not decode this receipt image for a thumbnail'))
      image.src = url
    })
    const scale = Math.min(1, 72 / image.naturalWidth, 72 / image.naturalHeight)
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale))
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale))
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Could not create a receipt thumbnail')
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, canvas.width, canvas.height)
    context.drawImage(image, 0, 0, canvas.width, canvas.height)
    const thumbnail = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((result) => result ? resolve(result) : reject(new Error('Could not encode a receipt thumbnail')), 'image/jpeg', 0.82)
    })
    return { bytes: new Uint8Array(await thumbnail.arrayBuffer()), width: canvas.width, height: canvas.height }
  } finally {
    URL.revokeObjectURL(url)
  }
}
const appendStyleEntry = (xml: string, tag: string, entry: string) => {
  const expression = new RegExp(`<${tag} count="(\\d+)">([\\s\\S]*?)</${tag}>`)
  const updated = xml.replace(expression, (_collection, count: string, children: string) => (
    `<${tag} count="${Number(count) + 1}">${children}${entry}</${tag}>`
  ))
  if (updated === xml) throw new Error(`Could not add workbook ${tag} formatting`)
  return updated
}
const styleWorkbookHeaders = async (workbook: JSZip) => {
  const stylesFile = workbook.file('xl/styles.xml')
  if (!stylesFile) throw new Error('Could not style the accountant workbook')
  let styles = await stylesFile.async('string')
  styles = appendStyleEntry(styles, 'fonts', '<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/><family val="2"/></font>')
  styles = appendStyleEntry(styles, 'fills', '<fill><patternFill patternType="solid"><fgColor rgb="FF78350F"/><bgColor indexed="64"/></patternFill></fill>')
  styles = appendStyleEntry(styles, 'cellXfs', '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>')
  workbook.file('xl/styles.xml', styles)
  for (const sheetPath of ['xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml', 'xl/worksheets/sheet3.xml']) {
    const sheetFile = workbook.file(sheetPath)
    if (!sheetFile) throw new Error('Could not format the accountant workbook sheets')
    const sheet = await sheetFile.async('string')
    const styledSheet = sheet.replace(/(<row\b[^>]*\br="1"[^>]*>[\s\S]*?<\/row>)/, (row) => row.replace(/<c\b([^>]*)>/g, (cell, attributes: string) => (
      /\bs=/.test(attributes) ? cell : `<c${attributes} s="1">`
    )))
    workbook.file(sheetPath, styledSheet)
  }
}
const addWorkbookThumbnails = async (workbook: JSZip, thumbnails: Array<{ row: number; bytes: Uint8Array; width: number; height: number }>) => {
  if (thumbnails.length === 0) return
  const sheetPath = 'xl/worksheets/sheet1.xml'
  const sheetFile = workbook.file(sheetPath)
  const contentTypesFile = workbook.file('[Content_Types].xml')
  if (!sheetFile || !contentTypesFile) throw new Error('Could not add receipt thumbnails to the workbook')

  const relationshipsPath = 'xl/worksheets/_rels/sheet1.xml.rels'
  const relationshipsFile = workbook.file(relationshipsPath)
  let relationships = relationshipsFile
    ? await relationshipsFile.async('string')
    : '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>'
  const relationshipIds = [...relationships.matchAll(/\bId="rId(\d+)"/g)].map((match) => Number(match[1]))
  const drawingId = `rId${Math.max(0, ...relationshipIds) + 1}`
  relationships = relationships.replace('</Relationships>', `<Relationship Id="${drawingId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing1.xml"/></Relationships>`)
  workbook.file(relationshipsPath, relationships)

  let drawingRelationships = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
  let drawingContent = '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
  thumbnails.forEach((thumbnail, index) => {
    const imageId = `rId${index + 1}`
    const imageName = `image${index + 1}.jpg`
    const extentWidth = thumbnail.width * 9525
    const extentHeight = thumbnail.height * 9525
    workbook.file(`xl/media/${imageName}`, thumbnail.bytes)
    drawingRelationships += `<Relationship Id="${imageId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${imageName}"/>`
    drawingContent += `<xdr:oneCellAnchor><xdr:from><xdr:col>8</xdr:col><xdr:colOff>1400000</xdr:colOff><xdr:row>${thumbnail.row - 1}</xdr:row><xdr:rowOff>95000</xdr:rowOff></xdr:from><xdr:ext cx="${extentWidth}" cy="${extentHeight}"/><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="${index + 1}" name="Receipt thumbnail ${index + 1}"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="${imageId}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill><xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${extentWidth}" cy="${extentHeight}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic><xdr:clientData/></xdr:oneCellAnchor>`
  })
  drawingContent += '</xdr:wsDr>'
  drawingRelationships += '</Relationships>'
  workbook.file('xl/drawings/drawing1.xml', drawingContent)
  workbook.file('xl/drawings/_rels/drawing1.xml.rels', drawingRelationships)

  const sheet = await sheetFile.async('string')
  workbook.file(sheetPath, sheet.replace('</worksheet>', `<drawing r:id="${drawingId}"/></worksheet>`))
  let contentTypes = await contentTypesFile.async('string')
  if (!contentTypes.includes('Extension="jpg"')) {
    contentTypes = contentTypes.replace('</Types>', '<Default Extension="jpg" ContentType="image/jpeg"/></Types>')
  }
  contentTypes = contentTypes.replace('</Types>', '<Override PartName="/xl/drawings/drawing1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/></Types>')
  workbook.file('[Content_Types].xml', contentTypes)
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
  const [duplicateMatches, setDuplicateMatches] = useState<DuplicateMatch[]>([])
  const [duplicateScanError, setDuplicateScanError] = useState('')
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const longPressActivated = useRef(false)

  useEffect(() => {
    let active = true
    const compareReceipts = async () => {
      try {
        const imageEntries = await Promise.all(expenses
          .filter((expense) => expense.attachmentData)
          .map(async (expense) => {
            const attachment = attachmentFromDataUrl(expense.attachmentData, expense.attachmentType)
            return [expense.id, await sha256(attachment.bytes)] as const
          }))
        if (active) {
          setDuplicateMatches(findDuplicateMatches(expenses, new Map(imageEntries)))
          setDuplicateScanError('')
        }
      } catch (error) {
        if (active) {
          setDuplicateMatches(findDuplicateMatches(expenses, new Map()))
          setDuplicateScanError(errorMessage(error, 'Saved receipt images could not be compared.'))
        }
      }
    }
    void compareReceipts()
    return () => { active = false }
  }, [expenses])

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
      setDraft({ ...emptyDraft, ...receiptToDraft(receipt), attachmentName: file.name, attachmentType: file.type || 'application/octet-stream', attachmentData })
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
  const exportAccountantFiles = async () => {
    setIsExporting(true)
    setExportMessage('')
    setExportError('')
    try {
      const zipFilename = `FWF_Hauling_${selectedQuarter}_${selectedQuarterYear}_Accountant_Export.zip`
      const exportZip = new JSZip()
      const receiptsFolder = exportZip.folder('Original_Receipts')
      if (!receiptsFolder) throw new Error('Could not create the original receipts folder.')
      const receiptFilesByExpense = new Map<string, PackagedReceipt>()
      const uniqueReceipts = new Map<string, PackagedReceipt>()
      const filenameCounts = new Map<string, number>()
      const unavailableReceipts: string[] = []
      const unavailableThumbnails: string[] = []

      for (const expense of quarterExpenses) {
        if (!expense.attachmentData) {
          unavailableReceipts.push(`${expense.merchant || 'Unnamed merchant'} (${expense.date}, expense ${expense.id})`)
          continue
        }
        try {
          const attachment = attachmentFromDataUrl(expense.attachmentData, expense.attachmentType)
          const digest = await sha256(attachment.bytes)
          let receipt = uniqueReceipts.get(digest)
          if (!receipt) {
            const originalName = expense.attachmentName.split(/[\\/]/).pop() || 'receipt'
            const extension = receiptExtension(originalName, attachment.mimeType)
            const datePart = isValidExpenseDate(expense.date) ? expense.date : 'Unknown_Date'
            const baseName = `${receiptFilenamePart(datePart)}_${receiptFilenamePart(expense.merchant || 'Unknown_Merchant')}`
            const nameKey = `${baseName}.${extension.toLowerCase()}`
            const duplicateNumber = (filenameCounts.get(nameKey) ?? 0) + 1
            filenameCounts.set(nameKey, duplicateNumber)
            const suffix = duplicateNumber === 1 ? '' : `_${duplicateNumber}`
            const filename = `${baseName}${suffix}.${extension}`
            receiptsFolder.file(filename, attachment.bytes)
            receipt = { filename, isImage: attachment.mimeType.startsWith('image/') }
            if (receipt.isImage) {
              try {
                receipt.thumbnail = await createReceiptThumbnail(attachment.blob)
              } catch (error) {
                unavailableThumbnails.push(`${expense.merchant || 'Unnamed merchant'} (${expense.date}, ${expense.attachmentName || 'receipt'}): ${errorMessage(error, 'Could not create thumbnail')}`)
              }
            }
            uniqueReceipts.set(digest, receipt)
          }
          receiptFilesByExpense.set(expense.id, receipt)
        } catch (error) {
          unavailableReceipts.push(`${expense.merchant || 'Unnamed merchant'} (${expense.date}, expense ${expense.id}): ${errorMessage(error, 'Saved receipt data could not be read')}`)
        }
      }

      const transactionHeaders = ['Date', 'Merchant', 'Category', 'Description', 'Subtotal', 'GST', 'PST', 'Total', 'Receipt']
      const transactionRows = quarterExpenses.map((expense) => {
        const receipt = receiptFilesByExpense.get(expense.id)
        const receiptLabel = !receipt
          ? 'Receipt unavailable'
          : receipt.thumbnail
            ? 'Open full-size original'
            : receipt.isImage
              ? 'Open original (thumbnail unavailable)'
              : 'Open original document'
        return [
          expense.date,
          expense.merchant,
          canonicalCategory(expense.category),
          expense.description,
          exportAmount(expense.subtotal),
          exportAmount(expense.gst),
          exportAmount(expense.pst),
          exportAmount(expense.total),
          receiptLabel,
        ]
      })
      const workbook = XLSX.utils.book_new()
      const individualSheet = XLSX.utils.aoa_to_sheet([transactionHeaders, ...transactionRows])
      individualSheet['!cols'] = [{ wch: 14 }, { wch: 24 }, { wch: 34 }, { wch: 38 }, { wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 16 }, { wch: 42 }]
      individualSheet['!rows'] = [{ hpt: 28 }, ...quarterExpenses.map(() => ({ hpt: 78 }))]
      individualSheet['!views'] = [{ state: 'frozen', ySplit: 1, topLeftCell: 'A2', activePane: 'bottomLeft' }]
      formatCurrencyColumns(individualSheet, [4, 5, 6, 7], transactionRows.length + 1)
      const thumbnails: Array<{ row: number; bytes: Uint8Array; width: number; height: number }> = []
      quarterExpenses.forEach((expense, index) => {
        const receipt = receiptFilesByExpense.get(expense.id)
        const receiptCell = individualSheet[XLSX.utils.encode_cell({ r: index + 1, c: 8 })]
        if (receipt && receiptCell) {
          receiptCell.l = {
            Target: `Original_Receipts/${receipt.filename}`,
            Tooltip: 'Open the full-size original receipt',
          }
          if (receipt.thumbnail) thumbnails.push({ row: index + 2, ...receipt.thumbnail })
        }
      })
      XLSX.utils.book_append_sheet(workbook, individualSheet, 'Individual Expenses')
      const categoryRows = [
        ['Category', 'Number of expenses', 'Total expenses', 'Total GST', 'Total PST'],
        ...quarterCategories.map(({ category, count, total, gst, pst }) => [category, count, total / 100, gst / 100, pst / 100]),
      ]
      const categorySheet = XLSX.utils.aoa_to_sheet(categoryRows)
      categorySheet['!cols'] = [{ wch: 42 }, { wch: 22 }, { wch: 18 }, { wch: 16 }, { wch: 16 }]
      categorySheet['!rows'] = [{ hpt: 28 }, ...quarterCategories.map(() => ({ hpt: 22 }))]
      formatCurrencyColumns(categorySheet, [2, 3, 4], categoryRows.length)
      XLSX.utils.book_append_sheet(workbook, categorySheet, 'Category Summary')
      const summarySheet = XLSX.utils.aoa_to_sheet([
        ['Quarterly Tax Summary', ''],
        ['Business name', 'FWF Hauling'],
        ['Quarter and year', `${selectedQuarter} ${selectedQuarterYear}`],
        ['Total expenses', quarterTotal / 100],
        ['Total GST', quarterGst / 100],
        ['Total PST', quarterPst / 100],
        ['Number of transactions', quarterExpenses.length],
      ])
      summarySheet['!cols'] = [{ wch: 40 }, { wch: 26 }]
      summarySheet['!rows'] = [{ hpt: 28 }, ...Array.from({ length: 6 }, () => ({ hpt: 24 }))]
      for (const cellAddress of ['B4', 'B5', 'B6']) {
        const cell = summarySheet[cellAddress]
        if (cell?.t === 'n') cell.z = '"$"#,##0.00'
      }
      XLSX.utils.book_append_sheet(workbook, summarySheet, 'Quarterly Tax Summary')
      const spreadsheet = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' })
      const workbookZip = await JSZip.loadAsync(spreadsheet)
      await styleWorkbookHeaders(workbookZip)
      await addWorkbookThumbnails(workbookZip, thumbnails)
      exportZip.file('Expense_Report.xlsx', await workbookZip.generateAsync({ type: 'uint8array' }))
      const archive = await exportZip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } })
      triggerDownload(archive, zipFilename)
      setExportMessage(`ZIP download started: ${zipFilename}`)
      const exportWarnings = [
        unavailableReceipts.length > 0
          ? `Receipt images unavailable in the app's loaded data (not fetched from Supabase):\n${unavailableReceipts.join('\n')}`
          : '',
        unavailableThumbnails.length > 0
          ? `Original receipts are included, but thumbnails could not be created for:\n${unavailableThumbnails.join('\n')}`
          : '',
      ].filter(Boolean)
      if (exportWarnings.length > 0) {
        setExportError(exportWarnings.join('\n\n'))
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
  const draftWarnings: ExpenseWarning[] = draft
    ? getExpenseWarnings({ ...draft, id: 'draft', createdAt: '' })
    : []
  const expenseWarnings = expenses.flatMap((expense) => getExpenseWarnings(expense)
    .map((warning) => ({ expense, warning })))

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
      {draftWarnings.length > 0 && <div role="status" className="mb-4 rounded-2xl bg-amber-50 p-4 text-sm text-amber-950 ring-1 ring-amber-200"><p className="font-bold">Review the flagged receipt details before saving</p><ul className="mt-2 list-inside list-disc space-y-1">{draftWarnings.map((warning, index) => <li key={`${warning.category}-${index}`}>{warning.message}</li>)}</ul></div>}
      <div className="grid gap-3 sm:grid-cols-2">{[['merchant', 'Merchant'], ['date', 'Date'], ['subtotal', 'Subtotal'], ['gst', 'GST'], ['pst', 'PST'], ['total', 'Total'], ['invoiceNumber', 'Receipt number'], ['paymentMethod', 'Payment method']].map(([field, label]) => <label key={field} className="rounded-2xl bg-stone-50 p-3 ring-1 ring-stone-200"><span className="mb-2 block text-sm font-semibold">{label}</span><input type={field === 'date' ? 'date' : 'text'} value={draft[field as keyof ExpenseDraft]} onChange={(event) => updateDraft(field as keyof ExpenseDraft, event.target.value)} className="w-full rounded-2xl border border-stone-300 bg-white px-4 py-3 outline-none focus:border-amber-700" /></label>)}
        <label className="rounded-2xl bg-stone-50 p-3 ring-1 ring-stone-200"><span className="mb-2 block text-sm font-semibold">Category</span><select value={draft.category} onChange={(event) => updateDraft('category', event.target.value)} className="w-full rounded-2xl border border-stone-300 bg-white px-4 py-3 outline-none">{!draft.category && <option value="">Select category — review receipt</option>}{CATEGORIES.map((category) => <option key={category}>{category}</option>)}</select></label>
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

      <section aria-label="Expense warnings and duplicate review" className="rounded-[28px] bg-white p-4 shadow-sm ring-1 ring-stone-200 sm:p-6">
        <div className="mb-4">
          <p className="text-sm font-semibold text-stone-900">Warnings &amp; duplicate review</p>
          <p className="mt-1 text-sm text-stone-500">Warnings never change or remove an expense. Review each flagged record manually.</p>
        </div>
        {duplicateScanError && <p role="alert" className="mb-3 rounded-xl bg-red-50 p-3 text-sm text-red-800">{duplicateScanError}</p>}
        {duplicateMatches.length === 0 && expenseWarnings.length === 0
          ? <p className="rounded-xl bg-stone-50 p-3 text-sm text-stone-600">No warnings found in the loaded expenses.</p>
          : <div className="space-y-4">
            {duplicateMatches.map(({ first, second, confirmed }) => (
              <article key={`${first.id}-${second.id}`} className="rounded-2xl bg-amber-50 p-4 ring-1 ring-amber-200">
                <h3 className="font-bold text-amber-950">{confirmed ? 'Confirmed duplicate receipt' : 'Possible duplicate transaction'}</h3>
                <p className="mt-1 text-sm text-amber-900">{confirmed
                  ? 'These transactions have identical saved receipt image data.'
                  : 'Merchant, date, and amount are similar. Compare the receipts; this is not confirmation of a duplicate.'}</p>
                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  {[first, second].map((expense) => (
                    <div key={expense.id} className="min-w-0 rounded-xl bg-white p-3 ring-1 ring-amber-200">
                      <p className="font-semibold text-stone-900">{expense.merchant || 'Unnamed merchant'}</p>
                      <p className="mt-1 text-sm text-stone-600">{dateLabel(expense.date)} · {formatAmount(expense.total)} · {canonicalCategory(expense.category)}</p>
                      <div className="mt-3 flex min-h-36 items-center justify-center overflow-hidden rounded-lg bg-stone-100">
                        {expense.attachmentData
                          ? expense.attachmentType === 'application/pdf'
                            ? <iframe title={`Receipt for ${expense.merchant || 'unnamed merchant'}`} src={expense.attachmentData} className="h-56 w-full" />
                            : <img src={expense.attachmentData} alt={`Receipt for ${expense.merchant || 'unnamed merchant'}`} className="max-h-64 w-full object-contain" />
                          : <p className="p-3 text-sm text-stone-500">Receipt image is not available in the loaded expense data.</p>}
                      </div>
                      <button type="button" onClick={() => startEdit(expense)} className="mt-3 rounded-xl bg-amber-900 px-3 py-2 text-sm font-semibold text-white">Review transaction</button>
                    </div>
                  ))}
                </div>
              </article>
            ))}
            {expenseWarnings.map(({ expense, warning }, index) => (
              <div key={`${expense.id}-${warning.category}-${index}`} className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-stone-50 p-3 ring-1 ring-stone-200">
                <div>
                  <p className="text-xs font-bold uppercase tracking-wide text-amber-900">{warning.category === 'missing' ? 'Missing / unreadable information' : `${warning.category.toUpperCase()} needs review`}</p>
                  <p className="mt-1 text-sm text-stone-800">{warning.message}</p>
                  <p className="mt-1 text-xs text-stone-500">{expense.merchant || 'Unnamed merchant'} · {dateLabel(expense.date)} · {formatAmount(expense.total)}</p>
                </div>
                <button type="button" onClick={() => startEdit(expense)} className="rounded-xl bg-stone-200 px-3 py-2 text-sm font-semibold text-stone-800">Review transaction</button>
              </div>
            ))}
          </div>}
      </section>

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
