/**
 * sc-jira local worklog ledger.
 *
 * The ledger is the plugin's own record of time spent, kept beside the
 * binding's `meta.json` as a JSON Lines file:
 *
 *   {tasksDir}/{KEY}/worklog.jsonl
 *
 * One entry per line. The file is append-only for entries (O_APPEND is an
 * atomic append, so no read-modify-write race) and rewritten in place only
 * when an entry is edited — an edit reads the whole file, replaces the one
 * line, and writes it back atomically (temp file + rename) so a crash cannot
 * leave a half-written ledger.
 *
 * Entries stay LOCAL until a human uploads them. `state` records where each
 * one stands:
 *
 *   draft  — recorded locally, never sent to Jira
 *   synced — uploaded; `jiraId` names the Jira worklog
 *   failed — an upload attempt failed; the error is kept for a retry
 *
 * A synced entry is still editable: changing it locally also updates Jira
 * through PUT /worklog/{id}.
 */
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { WorklogEntryState } from './types.js'

/** One row of the ledger. */
export interface WorklogLedgerEntry {
  /** Local identifier, `wl-NN`. Monotonic within one ledger. */
  id: string
  /** Turn that produced the entry; null for a manual entry. */
  turn: number | null
  /** Step that produced the entry; null when unknown. */
  step: number | null
  /** Duration in seconds. Editable. */
  seconds: number
  /** Free-text note. Editable. */
  comment: string
  /** Start timestamp, ISO with a +0800 offset. Editable. */
  startedAt: string
  /** Upload state. */
  state: WorklogEntryState
  /** Jira worklog id once synced; null while local. */
  jiraId: string | null
  /** When the entry was recorded locally. */
  createdAt: string
  /** When the entry was uploaded to Jira. */
  syncedAt: string | null
  /** Failure detail when `state` is `failed`. */
  error: string | null
}

/** Fields a caller may change on an existing entry. */
export interface WorklogEdit {
  seconds?: number
  comment?: string
  startedAt?: string
}

/** Ledger file name inside a task directory. */
export const LEDGER_FILE = 'worklog.jsonl'

/** Absolute path of the ledger for one issue key. */
export function ledgerPath(tasksDir: string, key: string): string {
  return join(tasksDir, key, LEDGER_FILE)
}

/**
 * Parse a ledger file. A malformed line is skipped rather than failing the
 * whole read: a half-written line from an interrupted append must not make
 * the ledger unreadable.
 */
export function parseLedger(text: string): WorklogLedgerEntry[] {
  const out: WorklogLedgerEntry[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      const parsed = JSON.parse(trimmed) as Partial<WorklogLedgerEntry>
      if (typeof parsed.id !== 'string' || typeof parsed.seconds !== 'number') continue
      out.push({
        id: parsed.id,
        turn: typeof parsed.turn === 'number' ? parsed.turn : null,
        step: typeof parsed.step === 'number' ? parsed.step : null,
        seconds: parsed.seconds,
        comment: typeof parsed.comment === 'string' ? parsed.comment : '',
        startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : '',
        state: parsed.state === 'synced' || parsed.state === 'failed' ? parsed.state : 'draft',
        jiraId: typeof parsed.jiraId === 'string' ? parsed.jiraId : null,
        createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : '',
        syncedAt: typeof parsed.syncedAt === 'string' ? parsed.syncedAt : null,
        error: typeof parsed.error === 'string' ? parsed.error : null,
      })
    } catch {
      continue
    }
  }
  return out
}

/** Read the ledger for one issue key. A missing ledger reads as empty. */
export async function readLedger(tasksDir: string, key: string): Promise<WorklogLedgerEntry[]> {
  try {
    const raw = await readFile(ledgerPath(tasksDir, key), 'utf8')
    return parseLedger(raw)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
}

/**
 * Write the whole ledger back atomically.
 *
 * Entries are one JSON object per line so the file stays readable and
 * appendable; the write itself goes through a temp file and a rename so a
 * crash mid-write cannot truncate the ledger.
 */
async function writeLedger(tasksDir: string, key: string, entries: WorklogLedgerEntry[]): Promise<void> {
  const dir = join(tasksDir, key)
  await mkdir(dir, { recursive: true })
  const target = ledgerPath(tasksDir, key)
  const tmp = `${target}.tmp`
  const body = entries.length === 0 ? '' : `${entries.map(e => JSON.stringify(e)).join('\n')}\n`
  await writeFile(tmp, body, 'utf8')
  await rename(tmp, target)
}

/** Next local id for a ledger, `wl-01`, `wl-02`, … */
function nextId(entries: WorklogLedgerEntry[]): string {
  let max = 0
  for (const e of entries) {
    const m = /^wl-(\d+)$/.exec(e.id)
    if (m?.[1] !== undefined) {
      const n = Number.parseInt(m[1], 10)
      if (Number.isFinite(n) && n > max) max = n
    }
  }
  return `wl-${String(max + 1).padStart(2, '0')}`
}

/** Input for appending one entry. */
export interface AppendWorklogInput {
  turn?: number | null
  step?: number | null
  seconds: number
  comment?: string
  startedAt: string
  createdAt: string
}

/**
 * Append one entry to the ledger.
 *
 * The file is appended to rather than rewritten, so two concurrent appends
 * cannot lose each other's entry. The id is derived from the current ledger
 * contents, which a concurrent append could race — the consequence is two
 * entries sharing an id, not a lost entry, and the id is a local label
 * rather than a key into anything.
 */
export async function appendWorklog(
  tasksDir: string,
  key: string,
  input: AppendWorklogInput,
): Promise<WorklogLedgerEntry> {
  const existing = await readLedger(tasksDir, key)
  const entry: WorklogLedgerEntry = {
    id: nextId(existing),
    turn: input.turn ?? null,
    step: input.step ?? null,
    seconds: Math.max(0, Math.round(input.seconds)),
    comment: input.comment ?? '',
    startedAt: input.startedAt,
    state: 'draft',
    jiraId: null,
    createdAt: input.createdAt,
    syncedAt: null,
    error: null,
  }
  const dir = join(tasksDir, key)
  await mkdir(dir, { recursive: true })
  await appendFile(ledgerPath(tasksDir, key), `${JSON.stringify(entry)}\n`, 'utf8')
  return entry
}

/**
 * Edit one entry in place.
 *
 * @returns the updated entry, or null when no entry carries that id.
 */
export async function editWorklog(
  tasksDir: string,
  key: string,
  id: string,
  edit: WorklogEdit,
): Promise<WorklogLedgerEntry | null> {
  const entries = await readLedger(tasksDir, key)
  const idx = entries.findIndex(e => e.id === id)
  if (idx === -1) return null
  const current = entries[idx]!
  const updated: WorklogLedgerEntry = {
    ...current,
    seconds: edit.seconds !== undefined ? Math.max(0, Math.round(edit.seconds)) : current.seconds,
    comment: edit.comment !== undefined ? edit.comment : current.comment,
    startedAt: edit.startedAt !== undefined ? edit.startedAt : current.startedAt,
  }
  entries[idx] = updated
  await writeLedger(tasksDir, key, entries)
  return updated
}

/**
 * Mark an entry as uploaded.
 *
 * @param jiraId - the id Jira assigned to the worklog.
 */
export async function markSynced(
  tasksDir: string,
  key: string,
  id: string,
  jiraId: string,
  syncedAt: string,
): Promise<WorklogLedgerEntry | null> {
  const entries = await readLedger(tasksDir, key)
  const idx = entries.findIndex(e => e.id === id)
  if (idx === -1) return null
  const updated: WorklogLedgerEntry = {
    ...entries[idx]!,
    state: 'synced',
    jiraId,
    syncedAt,
    error: null,
  }
  entries[idx] = updated
  await writeLedger(tasksDir, key, entries)
  return updated
}

/**
 * Mark an entry as failed, keeping the error for a retry.
 */
export async function markFailed(
  tasksDir: string,
  key: string,
  id: string,
  error: string,
): Promise<WorklogLedgerEntry | null> {
  const entries = await readLedger(tasksDir, key)
  const idx = entries.findIndex(e => e.id === id)
  if (idx === -1) return null
  const updated: WorklogLedgerEntry = {
    ...entries[idx]!,
    state: 'failed',
    error,
  }
  entries[idx] = updated
  await writeLedger(tasksDir, key, entries)
  return updated
}

/** Totals for one ledger. */
export interface LedgerTotals {
  count: number
  totalSeconds: number
  draftCount: number
  syncedCount: number
  failedCount: number
}

/** Summarize a ledger. */
export function summarizeLedger(entries: WorklogLedgerEntry[]): LedgerTotals {
  let totalSeconds = 0
  let draftCount = 0
  let syncedCount = 0
  let failedCount = 0
  for (const e of entries) {
    totalSeconds += e.seconds
    if (e.state === 'synced') syncedCount += 1
    else if (e.state === 'failed') failedCount += 1
    else draftCount += 1
  }
  return { count: entries.length, totalSeconds, draftCount, syncedCount, failedCount }
}
