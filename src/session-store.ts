/**
 * The worklog document, on disk.
 *
 * One file per session:
 *
 *   {storeDir}/{sessionId}.json
 *
 * The session is the key because the session is the unit of work: one
 * conversation produces one worklog, and every write comes from the host that
 * is serving that conversation (tool calls, panel routes, the turn clock).
 * Two sessions working on the same ticket write two files and both land on
 * Jira, which is the source of truth for what was tracked.
 *
 * Writes are read-modify-write into a temporary file and renamed into place,
 * serialized per session: two tool calls in the same turn cannot lose each
 * other's record.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SessionDoc } from './types.js'

/** The document schema this build writes. */
export const SCHEMA_VERSION = 1 as const

/** A session document no record has been made in yet. */
export function emptyDoc(sessionId: string): SessionDoc {
  return {
    schemaVersion: SCHEMA_VERSION,
    sessionId,
    binding: null,
    activities: [],
    turns: [],
    draft: null,
  }
}

/**
 * Encode a session id for use as a file name.
 *
 * A SessionId is an unvalidated branded string, so it is encoded rather than
 * trusted: no path separator, no traversal, no collision with the dotfiles
 * that sit beside it.
 */
function encodeSessionId(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9._-]/g, '_')
}

/** Absolute path of one session's document. */
export function docPath(storeDir: string, sessionId: string): string {
  return join(storeDir, `${encodeSessionId(sessionId)}.json`)
}

/** A document that exists but cannot be read as one. */
export class SessionDocCorruptError extends Error {
  constructor(readonly path: string, readonly reason: string) {
    super(`worklog document at "${path}" is unreadable (${reason}); it was left untouched`)
    this.name = 'SessionDocCorruptError'
  }
}

/** Coerce a parsed document into shape, ignoring what this build does not know. */
function coerce(parsed: unknown, sessionId: string): SessionDoc {
  const raw = (parsed ?? {}) as Partial<SessionDoc>
  if (raw.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`unsupported schemaVersion ${String(raw.schemaVersion)}`)
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    sessionId: typeof raw.sessionId === 'string' ? raw.sessionId : sessionId,
    binding: raw.binding ?? null,
    activities: Array.isArray(raw.activities) ? raw.activities : [],
    turns: Array.isArray(raw.turns) ? raw.turns : [],
    draft: raw.draft ?? null,
  }
}

/**
 * Read one session's document.
 *
 * A missing file is an empty document, not an error. A file that is present
 * but unreadable throws: overwriting it would destroy the only copy of records
 * that may still be recoverable by hand.
 */
export async function readDoc(storeDir: string, sessionId: string): Promise<SessionDoc> {
  const path = docPath(storeDir, sessionId)
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyDoc(sessionId)
    throw err
  }
  try {
    return coerce(JSON.parse(text), sessionId)
  } catch (err) {
    throw new SessionDocCorruptError(path, (err as Error).message)
  }
}

/** Write one document atomically. */
async function writeDoc(storeDir: string, doc: SessionDoc): Promise<void> {
  await mkdir(storeDir, { recursive: true })
  const target = docPath(storeDir, doc.sessionId)
  const tmp = `${target}.tmp`
  await writeFile(tmp, `${JSON.stringify(doc, null, 2)}\n`, 'utf8')
  await rename(tmp, target)
}

// --- per-session serialization --------------------------------------------

/** One tail promise per session: the next mutation waits for the previous. */
const tails = new Map<string, Promise<unknown>>()

function keyOf(storeDir: string, sessionId: string): string {
  return `${storeDir}\u0000${sessionId}`
}

/**
 * Run one mutation against a session's document, serialized per session.
 *
 * @param storeDir - directory holding the documents.
 * @param sessionId - the session whose document is mutated.
 * @param mutate - receives the current document; returns the next one and an
 *   optional result for the caller. Returning `null` leaves the file alone.
 */
export async function updateDoc<T>(
  storeDir: string,
  sessionId: string,
  mutate: (current: SessionDoc) => { next: SessionDoc; result: T } | { next: null; result: T },
): Promise<T> {
  const key = keyOf(storeDir, sessionId)
  const previous = tails.get(key) ?? Promise.resolve()
  const run = previous.then(async () => {
    const current = await readDoc(storeDir, sessionId)
    const outcome = mutate(current)
    if (outcome.next !== null) await writeDoc(storeDir, outcome.next)
    return outcome.result
  })
  // The tail never rejects: a failed mutation must not poison the next one.
  tails.set(key, run.then(() => undefined, () => undefined))
  try {
    return await run
  } finally {
    if (tails.get(key) === run) tails.delete(key)
  }
}

// --- a short-lived read for the per-step reminder --------------------------

interface CachedDoc {
  at: number
  doc: SessionDoc
}

const cache = new Map<string, CachedDoc>()

/**
 * Read a document, reusing a very recent read.
 *
 * The `agent/pre-step` reminder runs on every step of every session, so it
 * reads through this cache; mutations in this process go through
 * {@link updateDoc}, which invalidates the entry, so a bind or a record is
 * visible to the very next step.
 */
export async function readDocCached(
  storeDir: string,
  sessionId: string,
  ttlMs = 2000,
): Promise<SessionDoc> {
  const key = keyOf(storeDir, sessionId)
  const hit = cache.get(key)
  if (hit !== undefined && Date.now() - hit.at < ttlMs) return hit.doc
  const doc = await readDoc(storeDir, sessionId)
  cache.set(key, { at: Date.now(), doc })
  return doc
}

/** Drop one session's cached read — called after every mutation. */
export function invalidateDoc(storeDir: string, sessionId: string): void {
  cache.delete(keyOf(storeDir, sessionId))
}

/** Mutate and invalidate in one step, so callers cannot forget the second half. */
export async function updateDocAndInvalidate<T>(
  storeDir: string,
  sessionId: string,
  mutate: (current: SessionDoc) => { next: SessionDoc; result: T } | { next: null; result: T },
): Promise<T> {
  const result = await updateDoc(storeDir, sessionId, mutate)
  invalidateDoc(storeDir, sessionId)
  return result
}
