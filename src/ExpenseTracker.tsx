import { useState } from 'react'
import * as pdfjsLib from 'pdfjs-dist'
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import heic2any from 'heic2any'
import { createWorker } from 'tesseract.js'
import {
  ArrowLeftIcon,
  CameraIcon,
  CheckCircleIcon,
  DocumentArrowUpIcon,
  PencilSquareIcon,
  PhotoIcon,
  ReceiptPercentIcon,
} from '@heroicons/react/24/outline'

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker

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
  currency: string
  lineItems: Array<{ description: string | null; quantity: number | null; unitPrice: number | null; amount: number | null }>
}

type ReceiptDiagnostics = {
  originalFileType: string
  originalFileSize: string
  heicConversion: string
  convertedDimensions: string
  ocrDimensions: string
  tesseractInitialized: string
  recognizedCharacters: string
  recognizedWords: string
  confidence: string
  rawText: string
  parserReceivedText: string
}

type ReceiptDiagnosticUpdate = Partial<ReceiptDiagnostics>

const CATEGORIES = [
  'Fuel',
  'Maintenance & Repairs',
  'Tires',
  'Insurance',
  'Truck',
  'Trailer',
  'Parts',
  'Tolls',
  'Meals',
  'Office',
  'Supplies',
  'Other',
]

const normalizeCategory = (value: string | null) => {
  if (!value) return 'Other'
  return CATEGORIES.find((category) => category.toLowerCase() === value.toLowerCase()) ?? 'Other'
}

const emptyDraft: ExpenseDraft = {
  merchant: '',
  date: '',
  category: 'Other',
  subtotal: '',
  gst: '',
  pst: '',
  total: '',
  invoiceNumber: '',
  description: '',
  attachmentName: '',
  attachmentType: '',
  attachmentData: '',
}

const formatAmount = (value: string) => {
  const amount = Number(value)
  return value && Number.isFinite(amount)
    ? new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD' }).format(amount)
    : '—'
}

const getDateLabel = (value: string) => {
  if (!value) return '—'
  const date = new Date(`${value}T00:00:00`)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString('en-CA', { dateStyle: 'medium' })
}

const parseAmount = (value: string) => value.replace(/[$,\s]/g, '').match(/\d+(?:\.\d{1,2})?/)?.[0] ?? ''

const datePattern = '(\\d{4}[-/]\\d{1,2}[-/]\\d{1,2}|\\d{1,2}[-/]\\d{1,2}[-/]\\d{2,4}|(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\s+\\d{1,2}(?:st|nd|rd|th)?[,]?\\s+\\d{4})'

const normalizeReceiptDate = (value: string, canadianNumeric = true) => {
  const cleaned = value.replace(/(st|nd|rd|th)/i, '').replace(/\s+/g, '')
  const numeric = cleaned.match(new RegExp('^(\\d{1,4})[./-](\\d{1,2})[./-](\\d{1,4})$'))
  if (numeric) {
    const first = Number(numeric[1])
    const second = Number(numeric[2])
    const third = Number(numeric[3])
    if (numeric[1].length === 4) {
      if (second > 12 || third > 31) return ''
      return `${first.toString().padStart(4, '0')}-${second.toString().padStart(2, '0')}-${third.toString().padStart(2, '0')}`
    }
    const year = Number(numeric[3].length === 2 ? `20${numeric[3]}` : numeric[3])
    const month = first > 12 ? second : second > 12 ? first : canadianNumeric ? second : first
    const day = first > 12 ? first : second > 12 ? second : canadianNumeric ? first : second
    if (year < 2000 || month < 1 || month > 12 || day < 1 || day > 31) return ''
    return `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`
  }
  const parsed = new Date(cleaned)
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString().slice(0, 10)
}

const cleanLines = (text: string) => text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
const receiptDebug = (message: string, details: unknown) => {
  void details
  if (import.meta.env.DEV) console.debug(`[receipt-ocr] ${message}`)
}

const findReceiptDate = (lines: string[], ocrLines?: OcrLine[]) => {
  const numericDatePattern = '\\d{1,4}\\s*[\\/.-]\\s*\\d{1,2}\\s*[\\/.-]\\s*\\d{1,4}'
  const dateCandidatePattern = new RegExp(`\\b(?:${numericDatePattern}|${datePattern})\\b`, 'gi')
  const labelPattern = /\b(?:transaction|purchase|sale|trans)?\s*date\b/i
  const candidates = lines.flatMap((line, index) => [...line.matchAll(dateCandidatePattern)].map((match) => {
    const original = match[0]
    const normalized = normalizeReceiptDate(original)
    const ocrLine = ocrLines?.[index]
    const word = ocrLine?.words.find((entry) => entry.text.includes(original.replace(/\s+/g, '')))
    const labelOnLine = labelPattern.test(line)
    const nearbyLabel = labelPattern.test(lines[index - 1] ?? '') || labelPattern.test(lines[index + 1] ?? '')
    const isHeaderDate = index < 8
    const score = (labelOnLine ? 12 : nearbyLabel ? 8 : isHeaderDate ? 5 : 0) + (normalized ? 5 : 0)
    return { original, normalized, line, index, score, labelOnLine, nearbyLabel, isHeaderDate, bbox: word?.bbox, confidence: word?.confidence ?? 0, nearbyWords: ocrLines?.slice(Math.max(0, index - 1), index + 2).flatMap((entry) => entry.words.map((item) => item.text)) ?? [] }
  })).filter((candidate) => candidate.normalized)
  const rankedCandidates = candidates.sort((first, second) => second.score - first.score || first.index - second.index)
  receiptDebug('date candidates', rankedCandidates.map((candidate) => ({ ...candidate, accepted: candidate === rankedCandidates[0], rejectionReason: candidate === rankedCandidates[0] ? '' : 'lower date-association score' })))
  return rankedCandidates[0]?.normalized ?? ''
  /*
  const findOnLine = (line: string, label: string) => {
    const afterLabel = line.match(new RegExp(`\\b${label}\\b\\s*(?:/\\s*(?:date|hour))?\\s*[:#-]?\\s*${datePattern}`, 'i'))
    if (afterLabel) return normalizeReceiptDate(afterLabel[1])
      const beforeLabel = line.match(new RegExp(`${datePattern}(?:\\s+\\S+){0,2}\\s+\\b${label}\\b`, 'i'))
    return beforeLabel ? normalizeReceiptDate(beforeLabel[1]) : ''
  }
  for (const label of ['invoice\\s+date', 'date\\s+of\\s+invoice']) {
    for (const line of lines) {
      const value = findOnLine(line, label)
      if (value) return value
    }
  }
  for (const line of lines) {
    if (/\b(?:open|completion)\s+date\b/i.test(line)) continue
    const value = findOnLine(line, 'date')
    if (value) return value
  }
  return ''
  */
}

const findMerchant = (lines: string[], ocrLines?: OcrLine[]) => {
  const ignored = /^(receipt|invoice|subtotal|total|gst|pst|hst|qst|date|cash|debit|credit|thank|description|amount|tax|change|item|qty|price|customer|staff|server|clerk|cashier|repair order|reprint|copy|page|transaction|approval|auth(?:orization)?|visa|mastercard|amex|interac|affirm)\b/i
  const headerLines = lines.slice(0, 20)
  const vendorLine = lines.find((line) => /\b(truck\s+service|truck\s+repair)\b/i.test(line) && !/fwf\s+hauling/i.test(line) && !/\binvoice\b|\breprint\b|\bcopy\b|\bpage\s+\d+\s+of\s+\d+/i.test(line))
  if (vendorLine) {
    const vendorMatch = vendorLine.match(/\b([A-Za-z][A-Za-z&.'-]*(?:\s+[A-Za-z][A-Za-z&.'-]*){0,2}\s+Truck\s+(?:Service|Repair))\b/i)
      const namedVendorMatch = vendorLine.match(/\b(PBX\s+Truck\s+(?:Service|Repair))\b/i)
      if (namedVendorMatch) return namedVendorMatch[1]
    if (vendorMatch) return vendorMatch[1]
  }
    const candidates = headerLines.map((line, index) => {
      const normalizedLine = line.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '').replace(/\s+/g, ' ').trim()
      const followingLines = headerLines.slice(index + 1, index + 4).join(' ')
      const ocrLine = ocrLines?.[index]
      const confidence = ocrLine?.words.length ? ocrLine.words.reduce((sum, word) => sum + word.confidence, 0) / ocrLine.words.length : 0
      const wordCount = normalizedLine.split(/\s+/).length
      const looksLikeIdentifier = /^(?=.*[A-Za-z])(?=.*\d)[A-Za-z0-9-]{5,}$/.test(normalizedLine.replace(/\s+/g, ''))
      const looksLikeFragment = normalizedLine.split(/\s+/).length <= 2 && normalizedLine.split(/\s+/).some((word) => word.length < 4)
      const hasRandomSymbols = /[^A-Za-z0-9 &'.,-]/.test(normalizedLine)
      const hasUnexpectedDigits = /\d/.test(normalizedLine)
      const isAddressOrContact = /^(?:\d+\s+.*\b(?:street|st\.?|road|rd\.?|avenue|ave\.?|drive|dr\.?|boulevard|blvd\.?|lane|ln\.?|parkway|pkwy|unit|suite)\b.*|\+?\d[\d().\s-]{7,}|.*\b[A-Z]\d[A-Z]\s?\d[A-Z]\d\b)/i.test(normalizedLine)
      const hasAddressOrContact = /\b(?:street|st\.?|road|rd\.?|avenue|ave\.?|drive|dr\.?|boulevard|blvd\.?|lane|ln\.?|parkway|pkwy|unit|suite|phone|tel|www\.|\.com\b|[A-Z]\d[A-Z]\s?\d[A-Z]\d)\b/i.test(followingLines)
      let score = 0
      if (/^[A-Z0-9 &'.,-]+$/.test(normalizedLine) && /[A-Z]/.test(normalizedLine)) score += 5
      if (/\b(transport|hauling|freight|store|market|shop|ltd\.?|limited|inc\.?|corp\.?|co\.?)\b/i.test(normalizedLine)) score += 4
      if (hasAddressOrContact) score += 4
      score += Math.max(0, 4 - index)
      if (wordCount > 8) score -= 4
      if (ignored.test(normalizedLine) || /fwf\s+hauling/i.test(normalizedLine)) score -= 12
      if (isAddressOrContact || looksLikeIdentifier || looksLikeFragment || hasRandomSymbols || hasUnexpectedDigits || /^[$\d\s.,:/#-]+$/.test(normalizedLine) || /\b(?:\d{3}[-.)\s]?){2}\d{4}\b/.test(normalizedLine)) score -= 20
      return {
        normalizedLine,
        score,
        confidence,
        x: ocrLine?.words[0]?.bbox.x0 ?? 0,
        y: ocrLine?.words[0]?.bbox.y0 ?? index,
        rejection: looksLikeIdentifier ? 'identifier' : isAddressOrContact ? 'address/contact' : looksLikeFragment ? 'short fragment' : hasRandomSymbols ? 'random symbols' : hasUnexpectedDigits ? 'unexpected digits' : '',
      }
    })
    const rankedCandidates = candidates.sort((first, second) => second.score - first.score)
    receiptDebug('merchant candidates', rankedCandidates)
    return rankedCandidates.find((candidate) => candidate.score >= 5 && candidate.normalizedLine.replace(/[^A-Za-z]/g, '').length >= 3)?.normalizedLine ?? ''
}

const findInvoiceNumber = (lines: string[]) => {
  const ignoredValues = /^(date|invoice|number|no|repair|order|customer|open|completion)$/i
  const isIdentifier = (value: string) => /\d/.test(value) && /^[A-Z0-9][A-Z0-9-]{3,}$/i.test(value)
  for (const [index, line] of lines.entries()) {
    const match = line.match(/\b(?:invoice|receipt|transaction|reference)\s*(?:number|no\.?|#|:)\s*[:#-]?\s*([A-Z0-9][A-Z0-9-]{3,})\b/i)
    if (match && isIdentifier(match[1]) && !ignoredValues.test(match[1]) && !/^(?:date|open|completion)$/i.test(match[1])) return match[1]
    const prefixedMatch = line.match(/\b([A-Z0-9][A-Z0-9-]{3,})\b\s+(?:invoice|receipt|transaction|reference)\s*:/i)
    if (prefixedMatch && isIdentifier(prefixedMatch[1]) && !ignoredValues.test(prefixedMatch[1])) return prefixedMatch[1]
    if (/^(?:invoice|receipt|transaction|reference|order)(?:\s+(?:number|no\.?))?\s*:?$/i.test(line)) {
      const nearbyValues = [lines[index - 1]?.trim() ?? '', lines[index + 1]?.trim() ?? '']
      const value = nearbyValues.find((candidate) => /\d/.test(candidate) && /^[A-Z0-9][A-Z0-9-]{3,}$/.test(candidate))
      if (value && isIdentifier(value)) return value
    }
  }
  return ''
}

const findLabeledMoneyLine = (lines: string[], labels: string[]) => {
  const labelPattern = labels.join('|')
  const moneyPattern = /\$?([0-9][0-9,]*\.[0-9]{2})\b/g
  const candidates: Array<{ label: string; value: string; line: string; source: 'line' | 'adjacent' }> = []
  for (const [index, line] of [...lines.entries()].reverse()) {
    const labelMatch = line.match(new RegExp(`\\b(?:${labelPattern})\\b`, 'i'))
    if (!labelMatch) continue
    const labelStart = labelMatch.index ?? 0
    const labelEnd = labelStart + labelMatch[0].length
    const valuesOnLine = [...line.matchAll(moneyPattern)].sort((first, second) => Math.abs((first.index ?? 0) - labelEnd) - Math.abs((second.index ?? 0) - labelEnd))
    const adjacentIndex = index > 0 && !/\b(?:subtotal|total|gst|pst|hst|qst|deposit|purchase|amount)\b/i.test(lines[index - 1]) ? index - 1 : index + 1
    const adjacentLine = lines[adjacentIndex] ?? ''
    const values = valuesOnLine.length ? valuesOnLine : [...adjacentLine.matchAll(moneyPattern)]
    const value = values[0]?.[1] ?? ''
    if (value) candidates.push({ label: labelMatch[0], value, line, source: valuesOnLine.length ? 'line' : 'adjacent' })
    if (value) continue
  }
  receiptDebug(`money candidates (${labels.join('|')})`, candidates)
  const counts = new Map(candidates.map((candidate) => [candidate.value, candidates.filter((entry) => entry.value === candidate.value).length]))
  const candidate = candidates.sort((first, second) => (counts.get(second.value) ?? 0) - (counts.get(first.value) ?? 0))[0]
  return candidate ? { value: parseAmount(candidate.value), label: candidate.label.trim() } : { value: '', label: '' }
}

const findCategory = (text: string) => {
  const categories: Array<[string, string]> = [
    ['Fuel', 'fuel|gas|esso|shell|petro|diesel'],
    ['Maintenance & Repairs', 'repair|maintenance|service|oil change'],
    ['Tires', 'tire|tyre'],
    ['Insurance', 'insurance'],
    ['Truck', 'truck'],
    ['Trailer', 'trailer'],
    ['Parts', 'parts?'],
    ['Tolls', 'toll'],
    ['Meals', 'restaurant|cafe|coffee|meal'],
    ['Office', 'office'],
    ['Supplies', 'supplies'],
  ]
  return categories.find(([, pattern]) => new RegExp(`\\b(${pattern})\\b`, 'i').test(text))?.[0] ?? 'Other'
}

type ReceiptOcrResult = { text: string; confidence: number; lines: OcrLine[] }

const extractExpenseFields = (receipt: string | ReceiptOcrResult): Partial<ExpenseDraft> => {
  const text = typeof receipt === 'string' ? receipt : receipt.text
  const lines = typeof receipt === 'string' || receipt.lines.length === 0 ? cleanLines(text.replace(/[|]/g, ' ')) : receipt.lines.map((line) => line.text)
  const ocrLines = typeof receipt === 'string' || receipt.lines.length === 0 ? lines.map((line) => ({ text: line, words: [] })) : receipt.lines
  receiptDebug('all currency-shaped OCR tokens', ocrLines.flatMap((line, lineIndex) => [...line.text.matchAll(moneyPattern)].map((match) => {
    const word = line.words.find((entry) => entry.text.includes(match[0]))
    return { text: match[0], value: match[1], x: word?.bbox.x0 ?? match.index ?? 0, y: word?.bbox.y0 ?? lineIndex, bbox: word?.bbox, confidence: word?.confidence ?? 0, nearbyWords: line.words.map((entry) => entry.text) }
  })))
  const subtotalCandidates = getMoneyCandidates(ocrLines, 'subtotal', /\b(?:invoice\s+)?sub\s*t[o0]ta[l1i]\b|\b(?:amount\s+before\s+tax|before\s+tax|net\s+amount)\b/i, false)
  const totalCandidates = getMoneyCandidates(ocrLines, 'total', /\b(?:total\s+invoice|invoice\s+total|grand\s+total|amount\s+due|t[o0]ta[l1i])\b/i)
  const totalCandidate = selectMoneyCandidate(totalCandidates)
  const subtotalCandidate = selectMoneyCandidate(subtotalCandidates, new Set(totalCandidate ? [totalCandidate.key] : []))
  const subtotal = subtotalCandidate?.value ? parseAmount(subtotalCandidate.value) : ''
  const total = totalCandidate?.value ? parseAmount(totalCandidate.value) : ''
  const amountLine = findLabeledMoneyLine(lines, ['affirm\\s+deposit', 'deposit', 'purchase'])
  const descriptionLine = lines.find((line) => /\bdescription\s*[:-]/i.test(line))
  const description = descriptionLine?.split(/[:-]/).slice(1).join(':').trim() || (/\b(?:affirm\s+deposit|deposit|purchase)\b/i.test(amountLine.label) ? amountLine.label : '')
  const extracted = {
    merchant: findMerchant(lines, ocrLines),
    date: findReceiptDate(lines, ocrLines),
    category: findCategory(text),
    subtotal,
    gst: (() => { const candidate = selectMoneyCandidate(getMoneyCandidates(ocrLines, 'gst', /\b(?:g[.\s]?s[.\s]?t\.?|h[.\s]?s[.\s]?t\.?|goods\s+and\s+services\s+tax|tax)\b/i), new Set([...(totalCandidate ? [totalCandidate.key] : []), ...(subtotalCandidate ? [subtotalCandidate.key] : [])])); return candidate?.value ? parseAmount(candidate.value) : '' })(),
    pst: (() => { const candidate = selectMoneyCandidate(getMoneyCandidates(ocrLines, 'pst', /\b(?:p[.\s]?s[.\s]?t\.?|provincial\s+sales\s+tax)\b/i), new Set([...(totalCandidate ? [totalCandidate.key] : []), ...(subtotalCandidate ? [subtotalCandidate.key] : [])])); return candidate?.value ? parseAmount(candidate.value) : '' })(),
    total,
    invoiceNumber: findInvoiceNumber(lines),
    description,
  }
  receiptDebug('final extracted fields', extracted)
  return extracted
}

type OcrWord = {
  text: string
  confidence: number
  bbox: { x0: number; y0: number; x1: number; y1: number }
}

type OcrLine = { text: string; words: OcrWord[] }

type MonetaryCandidate = {
  key: string
  value: string
  text: string
  x: number
  y: number
  bbox: OcrWord['bbox']
  confidence: number
  nearbyWords: string[]
  nearestLabel: string
  labelDistance: number
  nearbyLabels: string[]
  field: string
  score: number
  reason: string
}

const moneyPattern = /\$?([0-9][0-9,]*\.[0-9]{2})\b/g
const financialLabelPattern = /\b(?:sub\s*t[o0]ta[l1i]|amount\s+before\s+tax|before\s+tax|net\s+amount|g[.\s]?s[.\s]?t\.?|h[.\s]?s[.\s]?t\.?|p[.\s]?s[.\s]?t\.?|tax|total|deposit|purchase|amount)\b/i

const getMoneyCandidates = (ocrLines: OcrLine[], field: string, labels: RegExp, allowAdjacent = true): MonetaryCandidate[] => {
  const candidates: MonetaryCandidate[] = []
  const labelExpression = new RegExp(labels.source, `${labels.flags.replace('g', '')}g`)
  for (const [labelIndex, labelLine] of ocrLines.entries()) {
    const labelMatches = [...labelLine.text.matchAll(labelExpression)]
    if (!labelMatches.length) continue
    const sameLineAmounts = [...labelLine.text.matchAll(moneyPattern)]
    if (!sameLineAmounts.length && !allowAdjacent) continue
    const adjacentIndex = sameLineAmounts.length ? labelIndex : labelIndex + 1 < ocrLines.length && !financialLabelPattern.test(ocrLines[labelIndex + 1].text) ? labelIndex + 1 : labelIndex - 1
    const amountLine = sameLineAmounts.length ? labelLine : ocrLines[adjacentIndex]
    if (!amountLine) continue
    const lineMoney = sameLineAmounts.length ? sameLineAmounts : [...amountLine.text.matchAll(moneyPattern)]
    const nearbyLines = ocrLines.slice(Math.max(0, labelIndex - 1), labelIndex + 2)
    for (const amount of lineMoney) {
      const word = amountLine.words.find((entry) => entry.text.includes(amount[0]))
      const nearbyLabels = nearbyLines.flatMap((entry) => entry.text.match(financialLabelPattern) ? [entry.text] : [])
      const nearestLabelMatch = labelMatches.reduce((nearest, match) => Math.abs((amount.index ?? 0) - (match.index ?? 0)) < Math.abs((amount.index ?? 0) - (nearest.index ?? 0)) ? match : nearest, labelMatches[0])
      const labelDistance = Math.abs((amount.index ?? 0) - (nearestLabelMatch.index ?? 0))
      const confidence = word?.confidence ?? 0
      const amountOnlyLine = !financialLabelPattern.test(amountLine.text)
      const score = 10 + (amountOnlyLine ? 3 : 0) + Math.max(0, 5 - labelDistance / 20) + confidence / 20
      candidates.push({
        key: `${labelIndex}:${amount.index ?? 0}:${amount[0]}`,
        value: amount[1],
        text: amountLine.text,
        x: word?.bbox.x0 ?? amount.index ?? 0,
        y: word?.bbox.y0 ?? adjacentIndex,
        bbox: word?.bbox ?? { x0: amount.index ?? 0, y0: adjacentIndex, x1: (amount.index ?? 0) + amount[0].length, y1: adjacentIndex + 1 },
        confidence,
        nearbyWords: nearbyLines.flatMap((entry) => entry.words.map((entryWord) => entryWord.text)),
        nearbyLabels,
        nearestLabel: nearestLabelMatch[0],
        labelDistance,
        field,
        score,
        reason: `matched ${sameLineAmounts.length ? 'same-line' : 'adjacent amount-only line'} label; character distance ${labelDistance}`,
      })
    }
  }
  receiptDebug(`monetary candidates for ${field}`, candidates)
  return candidates
}

const selectMoneyCandidate = (candidates: MonetaryCandidate[], excludedKeys = new Set<string>()) => {
  const associated = candidates.filter((candidate) => !candidate.reason.startsWith('rejected') && !excludedKeys.has(candidate.key))
  const counts = new Map(associated.map((candidate) => [candidate.value, associated.filter((entry) => entry.value === candidate.value).length]))
  const selected = associated.sort((first, second) => (counts.get(second.value) ?? 0) - (counts.get(first.value) ?? 0) || second.score - first.score)[0]
  receiptDebug('monetary assignment', { field: candidates[0]?.field ?? '', selected: selected?.value ?? '', candidates: candidates.map((candidate) => ({ ...candidate, assigned: candidate === selected, reason: candidate === selected ? 'selected' : `rejected: ${candidate.reason}; lower priority than selected candidate` })) })
  return selected
}

const layoutLinesFromWords = (words: OcrWord[]): OcrLine[] => {
  const orderedWords = words.filter((word) => word.text.trim()).sort((first, second) => {
    const firstCenter = (first.bbox.y0 + first.bbox.y1) / 2
    const secondCenter = (second.bbox.y0 + second.bbox.y1) / 2
    return firstCenter - secondCenter || first.bbox.x0 - second.bbox.x0
  })
  const lines: Array<{ baseline: number; height: number; words: OcrWord[] }> = []
  for (const word of orderedWords) {
    const center = (word.bbox.y0 + word.bbox.y1) / 2
    const height = Math.max(1, word.bbox.y1 - word.bbox.y0)
    const line = lines.find((candidate) => Math.abs(candidate.baseline - center) <= Math.max(candidate.height, height) * 0.55)
    if (line) {
      line.words.push(word)
      line.baseline = (line.baseline + center) / 2
      line.height = Math.max(line.height, height)
    } else {
      lines.push({ baseline: center, height, words: [word] })
    }
  }
  return lines
    .sort((first, second) => first.baseline - second.baseline)
    .map((line) => ({
      text: line.words.sort((first, second) => first.bbox.x0 - second.bbox.x0).map((word) => word.text).join(' '),
      words: line.words,
    }))
}

const enhanceImageForOcr = async (source: Blob, updateDiagnostics?: (update: ReceiptDiagnosticUpdate) => void) => {
  receiptDebug('preprocessing input', { type: source.type, bytes: source.size })
  const bitmap = await createImageBitmap(source, { imageOrientation: 'from-image' })
  updateDiagnostics?.({ convertedDimensions: `${bitmap.width} x ${bitmap.height}` })
  receiptDebug('image conversion', { type: source.type, bytes: source.size, width: bitmap.width, height: bitmap.height })
  const targetWidth = Math.min(3000, Math.max(1800, bitmap.width))
  const scale = targetWidth / bitmap.width
  const canvas = window.document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) {
    bitmap.close()
    throw new Error('Could not prepare receipt image')
  }
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()

  const pixels = context.getImageData(0, 0, canvas.width, canvas.height)
  const cornerLuminance = [
    pixels.data[0],
    pixels.data[(canvas.width - 1) * 4],
    pixels.data[(canvas.height - 1) * canvas.width * 4],
    pixels.data[(canvas.height * canvas.width - 1) * 4],
  ].reduce((sum, value) => sum + value, 0) / 4
  if (cornerLuminance > 220) {
    const contentThreshold = cornerLuminance - 35
    let left = canvas.width
    let top = canvas.height
    let right = 0
    let bottom = 0
    for (let y = 0; y < canvas.height; y += 2) {
      for (let x = 0; x < canvas.width; x += 2) {
        if (pixels.data[(y * canvas.width + x) * 4] < contentThreshold) {
          left = Math.min(left, x)
          top = Math.min(top, y)
          right = Math.max(right, x)
          bottom = Math.max(bottom, y)
        }
      }
    }
    const contentWidth = right - left
    const contentHeight = bottom - top
    if (contentWidth > canvas.width * 0.2 && contentHeight > canvas.height * 0.2 && contentWidth * contentHeight < canvas.width * canvas.height * 0.92) {
      const marginX = Math.round(contentWidth * 0.08)
      const marginY = Math.round(contentHeight * 0.08)
      const croppedCanvas = window.document.createElement('canvas')
      const cropLeft = Math.max(0, left - marginX)
      const cropTop = Math.max(0, top - marginY)
      const cropRight = Math.min(canvas.width, right + marginX)
      const cropBottom = Math.min(canvas.height, bottom + marginY)
      croppedCanvas.width = cropRight - cropLeft
      croppedCanvas.height = cropBottom - cropTop
      croppedCanvas.getContext('2d')?.drawImage(canvas, cropLeft, cropTop, croppedCanvas.width, croppedCanvas.height, 0, 0, croppedCanvas.width, croppedCanvas.height)
      canvas.width = croppedCanvas.width
      canvas.height = croppedCanvas.height
      context.drawImage(croppedCanvas, 0, 0)
    }
  }

  const enhancedPixels = context.getImageData(0, 0, canvas.width, canvas.height)
  const grayscale = new Uint8Array(canvas.width * canvas.height)
  const histogram = new Uint32Array(256)
  for (let index = 0, pixel = 0; index < enhancedPixels.data.length; index += 4, pixel += 1) {
    const luminance = Math.round(enhancedPixels.data[index] * 0.299 + enhancedPixels.data[index + 1] * 0.587 + enhancedPixels.data[index + 2] * 0.114)
    grayscale[pixel] = luminance
    histogram[luminance] += 1
  }
  const pixelCount = grayscale.length
  let low = 0
  let high = 255
  let accumulated = 0
  while (low < 255 && accumulated + histogram[low] < pixelCount * 0.01) accumulated += histogram[low++]
  accumulated = 0
  while (high > 0 && accumulated + histogram[high] < pixelCount * 0.01) accumulated += histogram[high--]
  const range = Math.max(1, high - low)
  for (let index = 0, pixel = 0; index < enhancedPixels.data.length; index += 4, pixel += 1) {
    const contrast = Math.max(0, Math.min(255, Math.round((grayscale[pixel] - low) * 255 / range)))
    enhancedPixels.data[index] = contrast
    enhancedPixels.data[index + 1] = contrast
    enhancedPixels.data[index + 2] = contrast
  }
  context.putImageData(enhancedPixels, 0, 0)

  const denoised = new Uint8Array(grayscale.length)
  for (let y = 0; y < canvas.height; y += 1) {
    for (let x = 0; x < canvas.width; x += 1) {
      let sum = 0
      let count = 0
      for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
        for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
          const neighborX = x + offsetX
          const neighborY = y + offsetY
          if (neighborX >= 0 && neighborX < canvas.width && neighborY >= 0 && neighborY < canvas.height) {
            sum += grayscale[neighborY * canvas.width + neighborX]
            count += 1
          }
        }
      }
      denoised[y * canvas.width + x] = Math.round(sum / count)
    }
  }

  const thresholdCanvas = window.document.createElement('canvas')
  thresholdCanvas.width = canvas.width
  thresholdCanvas.height = canvas.height
  const thresholdContext = thresholdCanvas.getContext('2d', { willReadFrequently: true })
  if (!thresholdContext) return [canvas]
  const thresholdPixels = thresholdContext.createImageData(canvas.width, canvas.height)
  const tileSize = 32
  for (let tileTop = 0; tileTop < canvas.height; tileTop += tileSize) {
    for (let tileLeft = 0; tileLeft < canvas.width; tileLeft += tileSize) {
      let sum = 0
      let count = 0
      for (let y = tileTop; y < Math.min(canvas.height, tileTop + tileSize); y += 1) {
        for (let x = tileLeft; x < Math.min(canvas.width, tileLeft + tileSize); x += 1) {
          sum += denoised[y * canvas.width + x]
          count += 1
        }
      }
      const threshold = sum / count - 12
      for (let y = tileTop; y < Math.min(canvas.height, tileTop + tileSize); y += 1) {
        for (let x = tileLeft; x < Math.min(canvas.width, tileLeft + tileSize); x += 1) {
          const pixel = y * canvas.width + x
          const value = denoised[pixel] < threshold ? 0 : 255
          const index = pixel * 4
          thresholdPixels.data[index] = value
          thresholdPixels.data[index + 1] = value
          thresholdPixels.data[index + 2] = value
          thresholdPixels.data[index + 3] = 255
        }
      }
    }
  }
  thresholdContext.putImageData(thresholdPixels, 0, 0)
  const samplePixels = [
    enhancedPixels.data[0],
    enhancedPixels.data[Math.max(0, enhancedPixels.data.length - 4)],
    thresholdPixels.data[0],
    thresholdPixels.data[Math.max(0, thresholdPixels.data.length - 4)],
  ]
  receiptDebug('preprocessing output', { width: canvas.width, height: canvas.height, pixels: canvas.width * canvas.height, samplePixels })
  updateDiagnostics?.({ ocrDimensions: `${canvas.width} x ${canvas.height} (contrast), ${thresholdCanvas.width} x ${thresholdCanvas.height} (thresholded)` })
  return [canvas, thresholdCanvas]
}

const readImageText = async (source: Blob) => {
  const worker = await createWorker('eng')
  try {
    const result = await worker.recognize(source)
    return result.data.text
  } finally {
    await worker.terminate()
  }
}

const isHeicFile = (file: File) => /image\/(heic|heif)/i.test(file.type) || /\.(heic|heif)$/i.test(file.name)

const toOcrSource = async (file: File, updateDiagnostics?: (update: ReceiptDiagnosticUpdate) => void) => {
  receiptDebug('OCR source input', { name: file.name, type: file.type, bytes: file.size, heic: isHeicFile(file) })
  if (!isHeicFile(file)) {
    updateDiagnostics?.({ heicConversion: 'Not needed (non-HEIC)' })
    return file
  }
  let converted: Blob | Blob[]
  try {
    converted = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.92 })
  } catch (error) {
    updateDiagnostics?.({ heicConversion: `Failed (${error instanceof Error ? error.message : 'unknown error'})` })
    throw error
  }
  const source = Array.isArray(converted) ? converted[0] : converted
  receiptDebug('HEIC conversion output', { type: source.type, bytes: source.size })
  updateDiagnostics?.({ heicConversion: `Succeeded (${source.type}, ${source.size.toLocaleString()} bytes)` })
  return source
}

const scoreReceiptCandidate = (candidate: { text: string; confidence: number; lines: OcrLine[] }) => {
  const fields = extractExpenseFields(candidate)
  const amounts = [fields.subtotal, fields.gst, fields.pst, fields.total].map((value) => Number(value || 0))
  const hasSubtotalAndTotal = Boolean(fields.subtotal && fields.total)
  const taxes = amounts[1] + amounts[2]
  const amountsAgree = hasSubtotalAndTotal && Math.abs(amounts[0] + taxes - amounts[3]) <= 0.03
  const populatedFields = [fields.merchant, fields.date, fields.subtotal, fields.gst, fields.pst, fields.total, fields.invoiceNumber, fields.description].filter(Boolean).length
  const textQuality = Math.min(10, cleanLines(candidate.text).length) + Math.min(5, candidate.text.length / 120)
  return candidate.confidence + populatedFields * 3 + textQuality + (amountsAgree ? 18 : 0)
}

const readImageReceiptText = async (source: Blob, updateDiagnostics?: (update: ReceiptDiagnosticUpdate) => void) => {
  receiptDebug('original image received', { type: source.type, bytes: source.size })
  const images = [source, ...(await enhanceImageForOcr(source, updateDiagnostics))]
  receiptDebug('OCR images ready', { count: images.length, images: images.map((image) => image instanceof HTMLCanvasElement ? { type: 'canvas', bytes: undefined, width: image.width, height: image.height } : { type: image.type, bytes: image.size, width: undefined, height: undefined }) })
  updateDiagnostics?.({ ocrDimensions: images.map((image, index) => image instanceof HTMLCanvasElement ? `${image.width} x ${image.height} (${index === 1 ? 'contrast' : 'thresholded'})` : 'source image').join('; ') })
  const passNames = ['original', 'contrast-normalized', 'thresholded']
  let worker: Awaited<ReturnType<typeof createWorker>>
  try {
    worker = await createWorker('eng')
  } catch (error) {
    updateDiagnostics?.({ tesseractInitialized: `No (${error instanceof Error ? error.message : 'unknown error'})` })
    throw error
  }
  updateDiagnostics?.({ tesseractInitialized: 'Yes' })
  receiptDebug('Tesseract worker ready', { language: 'eng' })
  try {
    const results = await Promise.all(images.map((image) => worker.recognize(image)))
    const passes = results
      .map((result) => {
        const data = result.data as typeof result.data & { words?: OcrWord[]; confidence?: number }
        const lines = data.words?.length ? layoutLinesFromWords(data.words) : []
        const text = lines.length ? lines.map((line) => line.text).join('\n') : data.text
        const confidence = data.confidence ?? (data.words?.length ? data.words.reduce((sum, word) => sum + word.confidence, 0) / data.words.length : 0)
        return { rawText: data.text, text, confidence, lines, words: data.words ?? [] }
      })
    passes.forEach((pass, index) => receiptDebug(`OCR pass: ${passNames[index] ?? `pass-${index + 1}`}`, { textLength: pass.text.length, rawTextLength: pass.rawText.length, confidence: pass.confidence, wordCount: pass.words.length, text: pass.text, pass }))
      const ranked = passes
        .map((pass) => ({ pass, score: scoreReceiptCandidate(pass) }))
        .sort((first, second) => second.score - first.score)
      const selected = ranked[0]?.pass ?? { rawText: '', text: '', confidence: 0, lines: [], words: [] }
      updateDiagnostics?.({ recognizedCharacters: `${selected.text.length}`, recognizedWords: `${selected.words.length}`, confidence: `${selected.confidence.toFixed(2)}%`, rawText: selected.rawText.slice(0, 300) })
      receiptDebug('selected OCR pass', { selected: selected.text, ranking: ranked.map((entry, index) => ({ pass: passNames[passes.indexOf(entry.pass)] ?? `pass-${index + 1}`, score: entry.score, confidence: entry.pass.confidence })) })
      return selected
  } finally {
    await worker.terminate()
  }
}

const readPdfText = async (file: File) => {
  const pdfDocument = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise
  const pageTexts: string[] = []
  for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
    const page = await pdfDocument.getPage(pageNumber)
    const content = await page.getTextContent()
    const lines = new Map<number, string[]>()
    for (const item of content.items) {
      if (!('str' in item) || !('transform' in item)) continue
      const y = Math.round(item.transform[5])
      const line = lines.get(y) ?? []
      line.push(item.str)
      lines.set(y, line)
    }
    const text = [...lines.entries()].sort(([first], [second]) => second - first).map(([, line]) => line.join(' ')).join('\n')
    if (text.trim().length >= 20) {
      pageTexts.push(text)
      continue
    }
    const viewport = page.getViewport({ scale: 2 })
    const canvas = window.document.createElement('canvas')
    canvas.width = viewport.width
    canvas.height = viewport.height
    const context = canvas.getContext('2d')
    if (!context) continue
    await page.render({ canvas, canvasContext: context, viewport }).promise
    const image = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('Could not render PDF page')))
    })
    pageTexts.push(await readImageText(image))
  }
  return pageTexts.join('\n--- PAGE ---\n')
}

const readReceiptText = async (file: File, updateDiagnostics?: (update: ReceiptDiagnosticUpdate) => void) => {
  if (file.type === 'application/pdf') return readPdfText(file)
  return readImageReceiptText(await toOcrSource(file, updateDiagnostics), updateDiagnostics)
}

const toGeminiImage = async (file: File) => {
  const source = await toOcrSource(file)
  const buffer = await source.arrayBuffer()
  let binary = ''
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte)
  return { mimeType: source.type || 'image/jpeg', data: btoa(binary) }
}

const readReceiptWithGemini = async (file: File) => {
  const image = await toGeminiImage(file)
  const response = await fetch('/api/receipt', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(image) })
  if (!response.ok) throw new Error('Gemini receipt request failed')
  return await response.json() as GeminiReceipt
}

const geminiToDraft = (receipt: GeminiReceipt): Partial<ExpenseDraft> => ({
  merchant: receipt.merchant ?? '',
  date: receipt.date ? normalizeReceiptDate(receipt.date) : '',
  category: normalizeCategory(receipt.category),
  subtotal: receipt.subtotal == null ? '' : receipt.subtotal.toFixed(2),
  gst: receipt.gst == null ? '' : receipt.gst.toFixed(2),
  pst: receipt.pst == null ? '' : receipt.pst.toFixed(2),
  total: receipt.total == null ? '' : receipt.total.toFixed(2),
  invoiceNumber: receipt.invoiceNumber ?? receipt.receiptNumber ?? '',
  description: receipt.lineItems.map((item) => item.description).filter((item): item is string => Boolean(item)).join(', '),
})

const readDataUrl = (file: File) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader()
  reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('Could not attach file'))
  reader.onerror = () => reject(reader.error ?? new Error('Could not attach file'))
  reader.readAsDataURL(file)
})

const ReceiptDiagnosticsPanel = ({ diagnostics }: { diagnostics: ReceiptDiagnostics | null }) => {
  if (!diagnostics) return null
  const rows: Array<[string, string]> = [
    ['Original file type', diagnostics.originalFileType],
    ['Original file size', diagnostics.originalFileSize],
    ['HEIC conversion', diagnostics.heicConversion],
    ['Converted image dimensions', diagnostics.convertedDimensions],
    ['OCR image dimensions', diagnostics.ocrDimensions],
    ['Tesseract initialized', diagnostics.tesseractInitialized],
    ['Recognized characters', diagnostics.recognizedCharacters],
    ['Recognized words', diagnostics.recognizedWords],
    ['OCR confidence', diagnostics.confidence],
    ['Parser received non-empty OCR text', diagnostics.parserReceivedText],
  ]
  return (
    <div className="mt-5 rounded-2xl border border-dashed border-amber-300 bg-amber-50 p-3 text-sm text-stone-800">
      <p className="font-bold text-amber-900">Temporary OCR diagnostics</p>
      <dl className="mt-2 grid gap-1 sm:grid-cols-2">
        {rows.map(([label, value]) => <div key={label}><dt className="inline font-semibold">{label}: </dt><dd className="inline break-words">{value}</dd></div>)}
      </dl>
      <p className="mt-2 font-semibold">Raw OCR text (first 300 characters)</p>
      <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-white p-2 text-xs">{diagnostics.rawText || '(empty)'}</pre>
    </div>
  )
}

function ExpenseTracker({ expenses, onExpensesChange }: ExpenseTrackerProps) {
  const [draft, setDraft] = useState<ExpenseDraft | null>(null)
  const [selectedExpense, setSelectedExpense] = useState<ExpenseRecord | null>(null)
  const [isProcessing, setIsProcessing] = useState(false)
  const [processingMessage, setProcessingMessage] = useState('')
  const [receiptDiagnostics, setReceiptDiagnostics] = useState<ReceiptDiagnostics | null>(null)

  const updateDraft = (field: keyof ExpenseDraft, value: string) => {
    setDraft((current) => (current ? { ...current, [field]: value } : current))
  }

  const selectReceipt = async (file: File) => {
    setIsProcessing(true)
    setProcessingMessage('Reading receipt...')
    setReceiptDiagnostics({
      originalFileType: file.type || '(missing)',
      originalFileSize: `${file.size.toLocaleString()} bytes`,
      heicConversion: 'Not reached',
      convertedDimensions: 'Not reached',
      ocrDimensions: 'Not reached',
      tesseractInitialized: 'Not reached',
      recognizedCharacters: 'Not reached',
      recognizedWords: 'Not reached',
      confidence: 'Not reached',
      rawText: '',
      parserReceivedText: 'Not reached',
    })
    const updateDiagnostics = (update: ReceiptDiagnosticUpdate) => setReceiptDiagnostics((current) => current ? { ...current, ...update } : current)
    try {
      const attachmentDataPromise = readDataUrl(file)
      let extracted: Partial<ExpenseDraft>
      let receiptWasReadable = false
      if (file.type === 'application/pdf') {
        const receiptText = await readReceiptText(file, updateDiagnostics)
        const parserText = typeof receiptText === 'string' ? receiptText : receiptText.text
        receiptWasReadable = Boolean(parserText.trim())
        updateDiagnostics({ parserReceivedText: parserText.trim() ? 'Yes' : 'No' })
        receiptDebug('parser input', { kind: typeof receiptText, textLength: typeof receiptText === 'string' ? receiptText.length : receiptText.text.length, confidence: typeof receiptText === 'string' ? undefined : receiptText.confidence, wordCount: typeof receiptText === 'string' ? undefined : receiptText.lines.reduce((count, line) => count + line.words.length, 0) })
        extracted = extractExpenseFields(receiptText)
      } else {
        try {
          extracted = geminiToDraft(await readReceiptWithGemini(file))
          receiptWasReadable = true
          updateDiagnostics({ tesseractInitialized: 'Not used (Gemini succeeded)', parserReceivedText: 'Yes' })
        } catch {
          const receiptText = await readReceiptText(file, updateDiagnostics)
          const parserText = typeof receiptText === 'string' ? receiptText : receiptText.text
          receiptWasReadable = Boolean(parserText.trim())
          updateDiagnostics({ parserReceivedText: parserText.trim() ? 'Yes' : 'No' })
          receiptDebug('parser input', { kind: typeof receiptText, textLength: typeof receiptText === 'string' ? receiptText.length : receiptText.text.length, confidence: typeof receiptText === 'string' ? undefined : receiptText.confidence, wordCount: typeof receiptText === 'string' ? undefined : receiptText.lines.reduce((count, line) => count + line.words.length, 0) })
          extracted = extractExpenseFields(receiptText)
        }
      }
      const attachmentData = await attachmentDataPromise
      setDraft({
        ...emptyDraft,
        ...extracted,
        attachmentName: file.name,
        attachmentType: file.type || 'application/octet-stream',
        attachmentData,
      })
      setProcessingMessage(receiptWasReadable ? 'Receipt information found' : "Couldn't read some information from this receipt. Please review and enter the missing fields manually.")
    } catch {
      try {
        const attachmentData = await readDataUrl(file)
        setDraft({
          ...emptyDraft,
          attachmentName: file.name,
          attachmentType: file.type || 'application/octet-stream',
          attachmentData,
        })
      } catch {
        setDraft(null)
      }
      setProcessingMessage("Couldn't read some information from this receipt. Please review and enter the missing fields manually.")
    } finally {
      setIsProcessing(false)
    }
  }

  const saveExpense = () => {
    if (!draft?.attachmentData) return
    const expense: ExpenseRecord = {
      ...draft,
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
    }
    onExpensesChange([expense, ...expenses])
    setDraft(null)
  }

  if (selectedExpense) {
    return (
      <section className="rounded-[28px] bg-white p-4 shadow-sm ring-1 ring-stone-200 sm:p-6">
        <button type="button" onClick={() => setSelectedExpense(null)} className="mb-5 flex items-center gap-2 text-sm font-semibold text-amber-900">
          <ArrowLeftIcon className="h-4 w-4" /> Back to Expenses
        </button>
        <div className="mb-5 flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-stone-500">Expense details</p>
            <h2 className="text-2xl font-black text-stone-900">{selectedExpense.merchant || 'Unnamed merchant'}</h2>
          </div>
          <ReceiptPercentIcon className="h-7 w-7 text-amber-900" />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {[
            ['Date', getDateLabel(selectedExpense.date)],
            ['Category', selectedExpense.category],
            ['Subtotal', formatAmount(selectedExpense.subtotal)],
            ['GST', formatAmount(selectedExpense.gst)],
            ['PST', formatAmount(selectedExpense.pst)],
            ['Total', formatAmount(selectedExpense.total)],
            ['Receipt/invoice number', selectedExpense.invoiceNumber || '—'],
            ['Description', selectedExpense.description || '—'],
          ].map(([label, value]) => (
            <div key={label} className="rounded-2xl bg-stone-50 p-3 ring-1 ring-stone-200">
              <p className="text-xs font-semibold text-stone-500">{label}</p>
              <p className="mt-1 text-sm font-semibold text-stone-900">{value}</p>
            </div>
          ))}
        </div>
        <div className="mt-5 overflow-hidden rounded-2xl bg-stone-100 ring-1 ring-stone-200">
          {selectedExpense.attachmentType === 'application/pdf' ? (
            <iframe title={selectedExpense.attachmentName} src={selectedExpense.attachmentData} className="h-[min(70vh,720px)] w-full" />
          ) : (
            <img src={selectedExpense.attachmentData} alt={selectedExpense.attachmentName} className="max-h-[720px] w-full object-contain" />
          )}
        </div>
        <p className="mt-2 text-xs text-stone-500">Attached: {selectedExpense.attachmentName}</p>
      </section>
    )
  }

  if (draft) {
    return (
      <section className="rounded-[28px] bg-white p-4 shadow-sm ring-1 ring-stone-200 sm:p-6">
        <div className="mb-5 flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-stone-500">Review before saving</p>
            <h2 className="text-2xl font-black text-stone-900">Check receipt details</h2>
            <p className="mt-1 text-sm text-stone-500">Unread fields are blank. Confirm or enter the details before saving.</p>
            <p className={`mt-2 text-sm font-semibold ${processingMessage.startsWith('Receipt information') ? 'text-emerald-700' : 'text-amber-800'}`}>{processingMessage}</p>
            <ReceiptDiagnosticsPanel diagnostics={receiptDiagnostics} />
          </div>
          <button type="button" onClick={() => document.getElementById('expense-merchant')?.focus()} className="flex items-center gap-1 rounded-xl bg-stone-100 px-3 py-2 text-sm font-semibold text-stone-800">
            <PencilSquareIcon className="h-4 w-4 text-amber-900" /> Edit
          </button>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {[
            ['merchant', 'Merchant'],
            ['date', 'Date'],
            ['subtotal', 'Subtotal'],
            ['gst', 'GST'],
            ['pst', 'PST'],
            ['total', 'Total'],
            ['invoiceNumber', 'Receipt/invoice number'],
          ].map(([field, label]) => (
            <label key={field} className="rounded-2xl bg-stone-50 p-3 ring-1 ring-stone-200">
              <span className="mb-2 block text-sm font-semibold">{label}</span>
              <input
                type={field === 'date' ? 'date' : field === 'subtotal' || field === 'gst' || field === 'pst' || field === 'total' ? 'number' : 'text'}
                step="0.01"
                id={field === 'merchant' ? 'expense-merchant' : undefined}
                value={draft[field as keyof ExpenseDraft]}
                onChange={(event) => updateDraft(field as keyof ExpenseDraft, event.target.value)}
                className="w-full rounded-2xl border border-stone-300 bg-white px-4 py-3 outline-none focus:border-amber-700"
              />
            </label>
          ))}
          <label className="rounded-2xl bg-stone-50 p-3 ring-1 ring-stone-200">
            <span className="mb-2 block text-sm font-semibold">Category</span>
            <select value={draft.category} onChange={(event) => updateDraft('category', event.target.value)} className="w-full rounded-2xl border border-stone-300 bg-white px-4 py-3 outline-none">
              {CATEGORIES.map((category) => <option key={category}>{category}</option>)}
            </select>
          </label>
          <label className="rounded-2xl bg-stone-50 p-3 ring-1 ring-stone-200 sm:col-span-2">
            <span className="mb-2 block text-sm font-semibold">Description</span>
            <textarea value={draft.description} onChange={(event) => updateDraft('description', event.target.value)} rows={3} className="w-full rounded-2xl border border-stone-300 bg-white px-4 py-3 outline-none focus:border-amber-700" />
          </label>
        </div>
        <div className="mt-5 flex flex-wrap items-center gap-3">
          <button type="button" onClick={() => setDraft(null)} className="rounded-2xl bg-stone-200 px-4 py-3 text-sm font-semibold text-stone-800">Cancel</button>
          <button type="button" onClick={saveExpense} className="flex items-center gap-2 rounded-2xl bg-amber-900 px-4 py-3 text-sm font-semibold text-white">
            <CheckCircleIcon className="h-5 w-5" /> Save Expense
          </button>
          <span className="text-xs text-stone-500">Attached: {draft.attachmentName}</span>
        </div>
      </section>
    )
  }

  return (
    <section className="space-y-4">
      <ReceiptDiagnosticsPanel diagnostics={receiptDiagnostics} />
      <div className="rounded-[28px] bg-white p-4 shadow-sm ring-1 ring-stone-200 sm:p-6">
        <div className="mb-5 flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-stone-500">Business records</p>
            <h2 className="text-2xl font-black text-stone-900">Expenses</h2>
            <p className="mt-1 text-sm text-stone-500">Keep each receipt attached to its expense.</p>
          </div>
          <ReceiptPercentIcon className="h-7 w-7 text-amber-900" />
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          <label className="flex cursor-pointer flex-col items-center justify-center rounded-2xl bg-stone-50 p-5 text-center ring-1 ring-stone-200 transition hover:bg-amber-50">
            <CameraIcon className="h-7 w-7 text-amber-900" />
            <span className="mt-2 text-sm font-bold">Take a Photo</span>
            <input type="file" accept="image/*" capture="environment" className="sr-only" onChange={(event) => event.target.files?.[0] && selectReceipt(event.target.files[0])} />
          </label>
          <label className="flex cursor-pointer flex-col items-center justify-center rounded-2xl bg-stone-50 p-5 text-center ring-1 ring-stone-200 transition hover:bg-amber-50">
            <PhotoIcon className="h-7 w-7 text-amber-900" />
            <span className="mt-2 text-sm font-bold">Choose Photo</span>
            <input type="file" accept="image/*,.heic,.heif" className="sr-only" onChange={(event) => event.target.files?.[0] && selectReceipt(event.target.files[0])} />
          </label>
          <label className="flex cursor-pointer flex-col items-center justify-center rounded-2xl bg-stone-50 p-5 text-center ring-1 ring-stone-200 transition hover:bg-amber-50">
            <DocumentArrowUpIcon className="h-7 w-7 text-amber-900" />
            <span className="mt-2 text-sm font-bold">Upload Document</span>
            <input type="file" accept="application/pdf,.pdf" className="sr-only" onChange={(event) => event.target.files?.[0] && selectReceipt(event.target.files[0])} />
          </label>
        </div>
        {isProcessing && <p className="mt-4 text-sm text-stone-500">Processing receipt...</p>}
      </div>

      <div className="rounded-[28px] bg-white p-4 shadow-sm ring-1 ring-stone-200 sm:p-6">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <p className="text-sm font-semibold text-stone-900">Saved expenses</p>
            <p className="text-xs text-stone-500">Select an expense to view its receipt and full details.</p>
          </div>
          <span className="rounded-full bg-stone-100 px-3 py-1 text-xs font-bold text-stone-700">{expenses.length}</span>
        </div>
        {expenses.length === 0 ? (
          <p className="rounded-2xl bg-stone-50 p-5 text-sm text-stone-500">No expenses saved yet.</p>
        ) : (
          <div className="grid gap-2">
            {expenses.map((expense) => (
              <button key={expense.id} type="button" onClick={() => setSelectedExpense(expense)} className="grid gap-1 rounded-2xl bg-stone-50 p-4 text-left ring-1 ring-stone-200 transition hover:bg-amber-50 sm:grid-cols-[1fr,1fr,1fr,auto] sm:items-center">
                <span className="font-semibold text-stone-900">{getDateLabel(expense.date)}</span>
                <span className="text-sm text-stone-700">{expense.merchant || 'Unnamed merchant'}</span>
                <span className="text-sm text-stone-600">{expense.category}</span>
                <span className="font-bold text-amber-900">{formatAmount(expense.total)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}

export type { ExpenseRecord }
export default ExpenseTracker
