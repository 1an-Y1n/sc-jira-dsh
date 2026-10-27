/**
 * sc-jira binding storage.
 *
 * Layout under the tasks directory:
 *
 *   {tasksDir}/{KEY}/meta.json   — the binding, one directory per issue key
 *   {tasksDir}/{KEY}/worklog.jsonl — the local worklog ledger (v3)
 *   {tasksDir}/.index.json       — derived bidirectional index (v3)
 *
 * `meta.json` is the only source of truth. The index is a convenience file
 * that answers "which issue is this session on" without walking every
 * directory; it is rebuilt from `meta.json` whenever the two disagree.
 *
 * The schema is version 4. A v3 file is upgraded in place on read (the new
 * fields take their defaults); anything older is ignored rather than
 * migrated — the v1 leftovers in a migrated profile are mock data, and
 * importing them would pollute a real ledger.
 */
import { mkdir, readFile, writeFile, readdir, rename, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { BindingIndex, MetaJsonV3, MetaJsonV4 } from './types.js'
import { DEFAULT_AUTO_WORKLOG } from './types.js'

const SUPPORTED_SCHEMA = 4 as const

/** File holding the derived index. */
export const INDEX_FILE = '.index.json'

export interface WriteBindingInput {
  key: string
  sessionId: string
  issueSummary: MetaJsonV4['issueSummary']
}

/** A binding as the rest of the plugin sees it. */
export interface Binding {
  key: string
  sessionId: string
  status: 'active' | 'ended'
  summary: string
  issueSummary: MetaJsonV4['issueSummary']
  startedAt: string
  endedAt: string | null
  autoWorklog: MetaJsonV4['autoWorklog']
}

function metaDir(tasksDir: string, key: string): string {
  return join(tasksDir, key)
}

function metaPath(tasksDir: string, key: string): string {
  return join(metaDir(tasksDir, key), 'meta.json')
}

function indexPath(tasksDir: string): string {
  return join(tasksDir, INDEX_FILE)
}

/**
 * Coerce a parsed meta.json into the v4 shape.
 *
 * A v3 file is accepted and upgraded: the counters stay as they are, the
 * automatic-worklog policy takes its defaults. Anything else — a v1
 * leftover, a file with a different shape — is rejected by the caller.
 */
function coerceMeta(parsed: unknown): MetaJsonV4 | null {
  if (typeof parsed !== 'object' || parsed === null) return null
  const raw = parsed as Partial<MetaJsonV3> & Partial<MetaJsonV4>
  if (raw.schemaVersion !== 3 && raw.schemaVersion !== 4) return null
  if (typeof raw.key !== 'string' || typeof raw.dshSessionId !== 'string') return null
  const issueSummary = raw.issueSummary
  if (typeof issueSummary !== 'object' || issueSummary === null) return null
  return {
    schemaVersion: SUPPORTED_SCHEMA,
    key: raw.key,
    status: raw.status === 'ended' ? 'ended' : 'active',
    startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : '',
    endedAt: typeof raw.endedAt === 'string' ? raw.endedAt : null,
    dshSessionId: raw.dshSessionId,
    issueSummary,
    logCount: typeof raw.logCount === 'number' ? raw.logCount : 0,
    logBytes: typeof raw.logBytes === 'number' ? raw.logBytes : 0,
    summaryCount: typeof raw.summaryCount === 'number' ? raw.summaryCount : 0,
    autoWorklog: { ...DEFAULT_AUTO_WORKLOG, ...raw.autoWorklog },
  }
}

/** Read one meta.json, or null when it is absent or unreadable. */
export async function readMeta(tasksDir: string, key: string): Promise<MetaJsonV4 | null> {
  try {
    const raw = await readFile(metaPath(tasksDir, key), 'utf8')
    return coerceMeta(JSON.parse(raw))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    return null
  }
}

/** Write a meta.json atomically. */
async function writeMeta(tasksDir: string, meta: MetaJsonV4): Promise<void> {
  const dir = metaDir(tasksDir, meta.key)
  await mkdir(dir, { recursive: true })
  const target = metaPath(tasksDir, meta.key)
  const tmp = `${target}.tmp`
  await writeFile(tmp, `${JSON.stringify(meta, null, 2)}\n`, 'utf8')
  await rename(tmp, target)
}

/**
 * Every active binding, read by walking the tasks directory.
 *
 * The index answers the same question faster; this is the truth the index is
 * rebuilt from.
 */
export async function readAllBindings(tasksDir: string): Promise<MetaJsonV4[]> {
  let names: string[]
  try {
    names = await readdir(tasksDir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  const out: MetaJsonV4[] = []
  for (const name of names) {
    // The index and any dotfile are not task directories.
    if (name.startsWith('.')) continue
    const meta = await readMeta(tasksDir, name)
    if (meta !== null) out.push(meta)
  }
  return out
}

/** Build the index from the authoritative meta files. */
export async function buildIndex(tasksDir: string): Promise<BindingIndex> {
  const metas = await readAllBindings(tasksDir)
  const index: BindingIndex = { schemaVersion: 1, bySession: {}, byKey: {} }
  for (const meta of metas) {
    if (meta.status !== 'active') continue
    index.bySession[meta.dshSessionId] = meta.key
    index.byKey[meta.key] = meta.dshSessionId
  }
  return index
}

/** Write the index atomically. */
async function writeIndex(tasksDir: string, index: BindingIndex): Promise<void> {
  await mkdir(tasksDir, { recursive: true })
  const target = indexPath(tasksDir)
  const tmp = `${target}.tmp`
  await writeFile(tmp, `${JSON.stringify(index, null, 2)}\n`, 'utf8')
  await rename(tmp, target)
}

/**
 * Read the index, rebuilding it when it disagrees with the meta files.
 *
 * The stored index is trusted only when it still matches what the metas say;
 * otherwise the metas win and the file is rewritten. That keeps a stale or
 * hand-edited index from answering a binding question wrongly.
 */
export async function readIndex(tasksDir: string): Promise<BindingIndex> {
  const fresh = await buildIndex(tasksDir)
  let stored: BindingIndex | null = null
  try {
    const raw = await readFile(indexPath(tasksDir), 'utf8')
    const parsed = JSON.parse(raw) as Partial<BindingIndex>
    if (parsed && typeof parsed.bySession === 'object' && typeof parsed.byKey === 'object') {
      stored = { schemaVersion: 1, bySession: parsed.bySession, byKey: parsed.byKey }
    }
  } catch {
    stored = null
  }
  if (stored === null) {
    await writeIndex(tasksDir, fresh)
    return fresh
  }
  const same =
    JSON.stringify(stored.bySession) === JSON.stringify(fresh.bySession) &&
    JSON.stringify(stored.byKey) === JSON.stringify(fresh.byKey)
  if (!same) {
    await writeIndex(tasksDir, fresh)
    return fresh
  }
  return stored
}

/** Refresh the index after a binding change. */
export async function syncIndex(tasksDir: string): Promise<BindingIndex> {
  const index = await buildIndex(tasksDir)
  await writeIndex(tasksDir, index)
  return index
}

/** Result of a binding lookup. */
export interface BindingResult {
  bound: boolean
  key?: string
  summary?: string
  sessionId: string
}

/** Convert a meta file into the binding shape. */
function toBinding(meta: MetaJsonV4): Binding {
  return {
    key: meta.key,
    sessionId: meta.dshSessionId,
    status: meta.status,
    summary: meta.issueSummary.summary,
    issueSummary: meta.issueSummary,
    startedAt: meta.startedAt,
    endedAt: meta.endedAt,
    autoWorklog: meta.autoWorklog,
  }
}

/**
 * Find the issue a session is bound to.
 *
 * Uses the index, which is validated against the meta files on read.
 */
export async function readBindingBySession(
  tasksDir: string,
  sessionId: string,
): Promise<BindingResult> {
  const index = await readIndex(tasksDir)
  const key = index.bySession[sessionId]
  if (key === undefined) return { bound: false, sessionId }
  const meta = await readMeta(tasksDir, key)
  if (meta === null || meta.status !== 'active' || meta.dshSessionId !== sessionId) {
    return { bound: false, sessionId }
  }
  return {
    bound: true,
    key: meta.key,
    summary: meta.issueSummary.summary,
    sessionId,
  }
}

/** Read the full binding for a session, or null. */
export async function readBindingDetailBySession(
  tasksDir: string,
  sessionId: string,
): Promise<Binding | null> {
  const index = await readIndex(tasksDir)
  const key = index.bySession[sessionId]
  if (key === undefined) return null
  const meta = await readMeta(tasksDir, key)
  if (meta === null || meta.status !== 'active' || meta.dshSessionId !== sessionId) return null
  return toBinding(meta)
}

/** Read the full binding for an issue key, or null. */
export async function readBindingByKey(tasksDir: string, key: string): Promise<Binding | null> {
  const meta = await readMeta(tasksDir, key)
  if (meta === null || meta.status !== 'active') return null
  return toBinding(meta)
}

/** Every active binding. */
export async function listActiveBindings(tasksDir: string): Promise<Binding[]> {
  const metas = await readAllBindings(tasksDir)
  return metas.filter(m => m.status === 'active').map(toBinding)
}

/**
 * Write a binding.
 *
 * A key already bound to another session is refused — the binding is
 * immutable until it is explicitly ended. A session already bound to another
 * key is refused too, which is what makes the mapping one-to-one in both
 * directions.
 */
export async function writeMetaWithBinding(
  tasksDir: string,
  input: WriteBindingInput,
): Promise<void> {
  const existing = await readMeta(tasksDir, input.key)

  if (existing !== null && existing.status === 'active' && existing.dshSessionId !== input.sessionId) {
    throw new Error(
      `${input.key} already bound to another session (${existing.dshSessionId}); end that binding before rebinding`,
    )
  }

  // One session may hold only one binding at a time.
  const all = await readAllBindings(tasksDir)
  for (const meta of all) {
    if (meta.status !== 'active') continue
    if (meta.dshSessionId === input.sessionId && meta.key !== input.key) {
      throw new Error(
        `session ${input.sessionId} is already bound to ${meta.key}; end that binding before rebinding`,
      )
    }
  }

  const next: MetaJsonV4 = existing !== null
    ? {
        ...existing,
        schemaVersion: SUPPORTED_SCHEMA,
        // An ended binding is being taken over: it becomes active again, and
        // the new owner replaces the old one. The counters and the worklog
        // policy carry over — the history under this key stays.
        status: 'active',
        endedAt: null,
        dshSessionId: existing.status === 'active' ? existing.dshSessionId : input.sessionId,
        issueSummary: input.issueSummary,
        autoWorklog: existing.autoWorklog ?? { ...DEFAULT_AUTO_WORKLOG },
      }
    : {
        schemaVersion: SUPPORTED_SCHEMA,
        key: input.key,
        status: 'active',
        startedAt: new Date().toISOString(),
        endedAt: null,
        dshSessionId: input.sessionId,
        issueSummary: input.issueSummary,
        logCount: 0,
        logBytes: 0,
        summaryCount: 0,
        autoWorklog: { ...DEFAULT_AUTO_WORKLOG },
      }

  await writeMeta(tasksDir, next)
  await syncIndex(tasksDir)
}

/**
 * End a binding, keeping its files.
 *
 * The worklog ledger and the session log stay on disk — the history belongs
 * to the work, not to the binding.
 */
export async function endBinding(tasksDir: string, sessionId: string): Promise<Binding | null> {
  const index = await readIndex(tasksDir)
  const key = index.bySession[sessionId]
  if (key === undefined) return null
  const meta = await readMeta(tasksDir, key)
  if (meta === null) return null
  const ended: MetaJsonV4 = {
    ...meta,
    status: 'ended',
    endedAt: new Date().toISOString(),
  }
  await writeMeta(tasksDir, ended)
  await syncIndex(tasksDir)
  return toBinding(ended)
}

/** Update the automatic-worklog policy of a binding. */
export async function updateAutoWorklog(
  tasksDir: string,
  key: string,
  patch: Partial<MetaJsonV4['autoWorklog']>,
): Promise<MetaJsonV4 | null> {
  const meta = await readMeta(tasksDir, key)
  if (meta === null) return null
  const next: MetaJsonV4 = {
    ...meta,
    autoWorklog: { ...meta.autoWorklog, ...patch },
  }
  await writeMeta(tasksDir, next)
  return next
}

/** List the issue keys that have a task directory. */
export async function listBindings(tasksDir: string): Promise<string[]> {
  try {
    const names = await readdir(tasksDir, { withFileTypes: true })
    const keys: string[] = []
    for (const e of names) {
      if (!e.isDirectory()) continue
      if (e.name.startsWith('.')) continue
      try {
        const raw = await readFile(metaPath(tasksDir, e.name), 'utf8')
        const parsed = coerceMeta(JSON.parse(raw))
        if (parsed !== null) keys.push(parsed.key)
      } catch {
        continue
      }
    }
    return keys.sort()
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
}

/** Size of a file in bytes, or 0 when it does not exist. */
export async function fileSize(path: string): Promise<number> {
  try {
    const s = await stat(path)
    return s.size
  } catch {
    return 0
  }
}
