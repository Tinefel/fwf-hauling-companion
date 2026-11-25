import type { ExpenseRecord } from './ExpenseTracker'

export type ExpenseWarning = {
  category: 'missing' | 'gst' | 'pst'
  message: string
}

export type DuplicateMatch = {
  first: ExpenseRecord
  second: ExpenseRecord
  confirmed: boolean
}

const knownCategories = new Set([
  'Fuel / Gas',
  'Maintenance & Repairs',
  'Parts',
  'Vehicle / Truck',
  'Insurance / Licensing & Registration',
  'Meals',
  'Advertising / Marketing',
  'Miscellaneous',
  'Insurance',
  'Registration / Licensing',
  'Tires',
  'Supplies',
  'Equipment',
  'Trailer',
  'Office',
  'Phone / Communications',
  'Tolls',
  'Professional Services',
])

const amountInCents = (value: string) => {
  if (!value.trim()) return null
  const amount = Number(value)
  if (!Number.isFinite(amount) || amount < 0) return null
  return Math.round(amount * 100)
}

const isValidDate = (value: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

export const getExpenseWarnings = (expense: ExpenseRecord): ExpenseWarning[] => {
  const warnings: ExpenseWarning[] = []
  if (!expense.merchant.trim()) warnings.push({ category: 'missing', message: 'Merchant name is missing or unreadable.' })
  if (!isValidDate(expense.date)) warnings.push({ category: 'missing', message: 'Transaction date is missing or unreadable.' })
  if (!knownCategories.has(expense.category.trim())) warnings.push({ category: 'missing', message: 'Expense category is missing or unreadable.' })

  const subtotal = amountInCents(expense.subtotal)
  const gst = amountInCents(expense.gst)
  const pst = amountInCents(expense.pst)
  const total = amountInCents(expense.total)
  if (subtotal == null) warnings.push({ category: 'missing', message: 'Subtotal is missing or unreadable.' })
  if (total == null) warnings.push({ category: 'missing', message: 'Total is missing or unreadable.' })
  if (gst == null) warnings.push({ category: 'gst', message: 'GST needs review: missing or unreadable.' })

  const isFuel = expense.category.trim() === 'Fuel / Gas'
  if (!isFuel && pst == null) warnings.push({ category: 'pst', message: 'PST needs review: missing or unreadable.' })
  if (isFuel && pst != null && pst > 0) {
    warnings.push({ category: 'pst', message: 'PST needs review: Manitoba fuel is normally PST-exempt.' })
  }
  if (total != null && gst != null && gst > total) {
    warnings.push({ category: 'gst', message: 'GST exceeds the transaction total; review the receipt.' })
  }
  if (total != null && pst != null && pst > total) {
    warnings.push({ category: 'pst', message: 'PST exceeds the transaction total; review the receipt.' })
  }
  if (subtotal != null && gst != null && total != null && (isFuel || pst != null)) {
    const taxPst = isFuel && pst == null ? 0 : pst ?? 0
    if (Math.abs(subtotal + gst + taxPst - total) > 2) {
      warnings.push({ category: 'gst', message: 'GST needs review: subtotal and tax amounts do not match the total.' })
      if (!isFuel || (pst != null && pst > 0)) {
        warnings.push({ category: 'pst', message: 'PST needs review: subtotal and tax amounts do not match the total.' })
      }
    }
  }
  return warnings
}

const normalizedMerchant = (value: string) => value.toLocaleLowerCase().replace(/[^a-z0-9]/g, '')

const validDateNumber = (value: string) => {
  if (!isValidDate(value)) return null
  return Date.parse(`${value}T00:00:00Z`)
}

export const findDuplicateMatches = (
  expenses: ExpenseRecord[],
  imageHashes: ReadonlyMap<string, string>,
): DuplicateMatch[] => {
  const matches: DuplicateMatch[] = []
  for (let firstIndex = 0; firstIndex < expenses.length; firstIndex += 1) {
    const first = expenses[firstIndex]
    for (let secondIndex = firstIndex + 1; secondIndex < expenses.length; secondIndex += 1) {
      const second = expenses[secondIndex]
      const firstHash = imageHashes.get(first.id)
      const secondHash = imageHashes.get(second.id)
      if (firstHash && firstHash === secondHash) {
        matches.push({ first, second, confirmed: true })
        continue
      }

      const merchant = normalizedMerchant(first.merchant)
      if (!merchant || merchant !== normalizedMerchant(second.merchant)) continue
      const firstDate = validDateNumber(first.date)
      const secondDate = validDateNumber(second.date)
      if (firstDate == null || secondDate == null || Math.abs(firstDate - secondDate) > 7 * 24 * 60 * 60 * 1000) continue

      const firstTotal = amountInCents(first.total)
      const secondTotal = amountInCents(second.total)
      if (firstTotal == null || secondTotal == null) continue
      const difference = Math.abs(firstTotal - secondTotal)
      const tolerance = Math.max(100, Math.round(Math.max(firstTotal, secondTotal) * 0.02))
      if (difference <= tolerance) matches.push({ first, second, confirmed: false })
    }
  }
  return matches
}
