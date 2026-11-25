import { ensureAnonymousSession, RECEIPTS_BUCKET, supabase } from './supabase'
import type { ExpenseRecord } from './ExpenseTracker'

const DATABASE_NAME = 'fwf-hauling-expenses'
const DATABASE_VERSION = 1
const RECORDS_STORE = 'records'
const OUTBOX_STORE = 'outbox'
const EXPENSES_TABLE = 'fwf_expenses'
type LocalRecord = {
  id: string
  expense: ExpenseRecord
  updatedAt: string
  deleted: boolean
}

type RemoteRecord = {
  id: string
  record: Omit<ExpenseRecord, 'attachmentData'>
  receipt_path: string | null
  deleted: boolean
  updated_at: string
}

const nextTimestamp = (previous?: string) => {
  const previousTimestamp = previous ? Date.parse(previous) : 0
  return new Date(Math.max(Date.now(), Number.isFinite(previousTimestamp) ? previousTimestamp + 1 : 0)).toISOString()
}

const openDatabase = () => new Promise<IDBDatabase>((resolve, reject) => {
  const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
  request.onupgradeneeded = () => {
    const database = request.result
    if (!database.objectStoreNames.contains(RECORDS_STORE)) {
      database.createObjectStore(RECORDS_STORE, { keyPath: 'id' })
    }
    if (!database.objectStoreNames.contains(OUTBOX_STORE)) {
      database.createObjectStore(OUTBOX_STORE, { keyPath: 'id' })
    }
  }
  request.onsuccess = () => resolve(request.result)
  request.onerror = () => reject(request.error ?? new Error('Could not open local expense storage'))
  request.onblocked = () => reject(new Error('Local expense storage is blocked by another tab'))
})

const readAll = <T,>(storeName: string) => openDatabase().then((database) => new Promise<T[]>((resolve, reject) => {
  const transaction = database.transaction(storeName, 'readonly')
  const request = transaction.objectStore(storeName).getAll()
  request.onsuccess = () => resolve(request.result as T[])
  request.onerror = () => reject(request.error ?? new Error('Could not read local expense storage'))
  transaction.oncomplete = () => database.close()
  transaction.onerror = () => {
    database.close()
    reject(transaction.error ?? new Error('Could not read local expense storage'))
  }
}))

const updateLocalStores = (
  update: (records: IDBObjectStore, outbox: IDBObjectStore) => void,
) => openDatabase().then((database) => new Promise<void>((resolve, reject) => {
  const transaction = database.transaction([RECORDS_STORE, OUTBOX_STORE], 'readwrite')
  update(transaction.objectStore(RECORDS_STORE), transaction.objectStore(OUTBOX_STORE))
  transaction.oncomplete = () => {
    database.close()
    resolve()
  }
  transaction.onerror = () => {
    database.close()
    reject(transaction.error ?? new Error('Could not save local expenses'))
  }
  transaction.onabort = () => {
    database.close()
    reject(transaction.error ?? new Error('Could not save local expenses'))
  }
}))

export const initializeLocalExpenses = async (legacyExpenses: ExpenseRecord[]) => {
  await updateLocalStores((records, outbox) => {
    const request = records.getAll()
    request.onsuccess = () => {
      const existing = new Set((request.result as LocalRecord[]).map((record) => record.id))
      const now = new Date().toISOString()
      legacyExpenses.forEach((expense) => {
        if (existing.has(expense.id)) return
        const localRecord: LocalRecord = { id: expense.id, expense, updatedAt: now, deleted: false }
        records.put(localRecord)
        outbox.put(localRecord)
      })
    }
  })
  return (await readAll<LocalRecord>(RECORDS_STORE))
    .filter((record) => !record.deleted)
    .map((record) => record.expense)
}

export const saveLocalExpenses = async (nextExpenses: ExpenseRecord[], previousExpenses: ExpenseRecord[]) => {
  await updateLocalStores((records, outbox) => {
    const request = records.getAll()
    request.onsuccess = () => {
      const current = new Map((request.result as LocalRecord[]).map((record) => [record.id, record]))
      const next = new Map(nextExpenses.map((expense) => [expense.id, expense]))

      nextExpenses.forEach((expense) => {
        const saved = current.get(expense.id)
        if (saved && !saved.deleted && JSON.stringify(saved.expense) === JSON.stringify(expense)) return
        const updatedAt = nextTimestamp(saved?.updatedAt)
        const localRecord: LocalRecord = { id: expense.id, expense, updatedAt, deleted: false }
        records.put(localRecord)
        outbox.put(localRecord)
      })

      previousExpenses.forEach((expense) => {
        if (next.has(expense.id)) return
        const saved = current.get(expense.id)
        const localRecord: LocalRecord = {
          id: expense.id,
          expense: saved?.expense ?? expense,
          updatedAt: nextTimestamp(saved?.updatedAt),
          deleted: true,
        }
        records.put(localRecord)
        outbox.put(localRecord)
      })
    }
  })
}

const dataUrlToBlob = (dataUrl: string) => {
  const separator = dataUrl.indexOf(',')
  if (!dataUrl.startsWith('data:') || separator < 0) {
    throw new Error('The saved receipt data is invalid')
  }
  const metadata = dataUrl.slice(0, separator)
  const content = dataUrl.slice(separator + 1)
  const mimeType = metadata.slice(5).split(';')[0] || 'application/octet-stream'
  const binary = metadata.endsWith(';base64')
    ? atob(content)
    : decodeURIComponent(content)
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
  return new Blob([bytes], { type: mimeType })
}

const blobToDataUrl = (blob: Blob) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader()
  reader.onload = () => typeof reader.result === 'string'
    ? resolve(reader.result)
    : reject(new Error('Could not read the downloaded receipt'))
  reader.onerror = () => reject(reader.error ?? new Error('Could not read the downloaded receipt'))
  reader.readAsDataURL(blob)
})

const getRemoteExpenses = async () => {
  const { data, error } = await supabase
    .from(EXPENSES_TABLE)
    .select('id, record, receipt_path, deleted, updated_at')
  if (error) throw error
  return data as unknown as RemoteRecord[]
}

const getReceiptPath = (id: string) => `${id}/receipt`

const storeRemoteRecord = async (remote: RemoteRecord, existing?: LocalRecord) => {
  const expense: ExpenseRecord = {
    ...(existing?.expense ?? {}),
    ...remote.record,
    id: remote.id,
    attachmentData: existing?.expense.attachmentData ?? '',
  }
  if (!remote.deleted && remote.receipt_path && !expense.attachmentData) {
    const { data, error } = await supabase.storage.from(RECEIPTS_BUCKET).download(remote.receipt_path)
    if (error) throw error
    expense.attachmentData = await blobToDataUrl(data)
  }
  await updateLocalStores((records, outbox) => {
    const request = outbox.get(remote.id)
    request.onsuccess = () => {
      const pending = request.result as LocalRecord | undefined
      if (pending && pending.updatedAt >= remote.updated_at) return
      records.put({
        id: remote.id,
        expense,
        updatedAt: remote.updated_at,
        deleted: remote.deleted,
      } satisfies LocalRecord)
      outbox.delete(remote.id)
    }
  })
}

const removeOutboxIfUnchanged = async (sent: LocalRecord) => {
  await updateLocalStores((_records, outbox) => {
    const request = outbox.get(sent.id)
    request.onsuccess = () => {
      const current = request.result as LocalRecord | undefined
      if (
        current?.updatedAt === sent.updatedAt
        && current.deleted === sent.deleted
        && JSON.stringify(current.expense) === JSON.stringify(sent.expense)
      ) {
        outbox.delete(sent.id)
      }
    }
  })
}

const uploadPendingRecord = async (local: LocalRecord) => {
  let receiptPath: string | null = null
  const { attachmentData, ...record } = local.expense
  if (!local.deleted && attachmentData) {
    receiptPath = getReceiptPath(local.id)
    const receipt = dataUrlToBlob(attachmentData)
    const { error: uploadError } = await supabase.storage
      .from(RECEIPTS_BUCKET)
      .upload(receiptPath, receipt, {
        upsert: true,
        contentType: receipt.type,
      })
    if (uploadError) throw uploadError
  }

  const { error } = await supabase.from(EXPENSES_TABLE).upsert({
    id: local.id,
    record,
    receipt_path: receiptPath,
    deleted: local.deleted,
    updated_at: local.updatedAt,
  }, { onConflict: 'id' })
  if (error) throw error
  await removeOutboxIfUnchanged(local)
}

export const synchronizeExpenses = async () => {
  await ensureAnonymousSession()
  const remoteRecords = await getRemoteExpenses()
  const localRecords = await readAll<LocalRecord>(RECORDS_STORE)
  const pendingRecords = await readAll<LocalRecord>(OUTBOX_STORE)
  const localById = new Map(localRecords.map((record) => [record.id, record]))
  const pendingById = new Map(pendingRecords.map((record) => [record.id, record]))
  const remoteById = new Map(remoteRecords.map((record) => [record.id, record]))

  for (const remote of remoteRecords) {
    if (pendingById.has(remote.id)) continue
    const local = localById.get(remote.id)
    if (local && local.updatedAt > remote.updated_at) {
      await updateLocalStores((_records, outbox) => outbox.put(local))
      pendingById.set(local.id, local)
      continue
    }
    await storeRemoteRecord(remote, local)
  }

  for (const local of localRecords) {
    if (remoteById.has(local.id) || local.deleted || pendingById.has(local.id)) continue
    await updateLocalStores((_records, outbox) => outbox.put(local))
    pendingById.set(local.id, local)
  }

  const queuedRecords = await readAll<LocalRecord>(OUTBOX_STORE)
  for (const local of queuedRecords) {
    await uploadPendingRecord(local)
  }

  const latestRemoteRecords = await getRemoteExpenses()
  const latestLocalRecords = await readAll<LocalRecord>(RECORDS_STORE)
  const remainingOutbox = await readAll<LocalRecord>(OUTBOX_STORE)
  const latestLocalById = new Map(latestLocalRecords.map((record) => [record.id, record]))
  const remainingOutboxIds = new Set(remainingOutbox.map((record) => record.id))
  for (const remote of latestRemoteRecords) {
    const local = latestLocalById.get(remote.id)
    if (remainingOutboxIds.has(remote.id) || (local && local.updatedAt > remote.updated_at)) continue
    await storeRemoteRecord(remote, local)
  }

  return (await readAll<LocalRecord>(RECORDS_STORE))
    .filter((record) => !record.deleted)
    .map((record) => record.expense)
}
