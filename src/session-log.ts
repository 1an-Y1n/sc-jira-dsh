/**
 * sc-jira session activity log and turn summaries.
 *
 * Two files beside the binding's `meta.json`, both in the shape the v2
 * leftovers used:
 *
 *   {tasksDir}/{KEY}/log.jsonl        — what happened, one line per event
 *   {tasksDir}/{KEY}/summary/{n}.json — what the agent made of it
 *
 * The activity log is written by the HOST: it observes the durable session
 * events and records the tool calls that actually ran. The summary is
 * written by the AGENT, which calls the `jira_summarize` tool — only the
 * agent knows what it was trying to do and whether it got there. A turn with
 * no summary simply has no file, which is more honest than a host-written
 * summary that only knows a tool ran.
 */
import { appendFile, mkdir, readFile, readdir, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import type { SessionLogEntry, SessionSummary } from './types.js'

/** File holding the activity log. */
export const LOG_FILE = 'log.jsonl'

/** Directory holding the per-turn summaries. */
export const SUMMARY_DIR = 'summary'

/** Absolute path of the activity log for one issue key. */
export function logPath(tasksDir: string, key: string): string {
  return join(tasksDir, key, LOG_FILE)
}

/** Absolute path of one summary file. */
export function summaryPath(tasksDir: string, key: string, turn: number): string {
  return join(tasksDir, key, SUMMARY_DIR, `${turn}.json`)
}

/**
 * Append one activity line.
 *
 * The file is appended to rather than rewritten, so a burst of tool calls
 * cannot lose entries to an interleaved write.
 */
export async function appendSessionLog(
  tasksDir: string,
  key: string,
  entry: SessionLogEntry,
): Promise<void> {
  await mkdir(join(tasksDir, key), { recursive: true })
  await appendFile(logPath(tasksDir, key), `${JSON.stringify(entry)}\n`, 'utf8')
}

/**
 * Write one turn's summary.
 *
 * The file is named after the turn, so a second summary for the same turn
 * replaces the first — the agent refining its understanding of a turn should
 * not leave two files behind. The write goes through a temp file and a
 * rename so a reader never sees a partial summary.
 */
export async function writeSummary(
  tasksDir: string,
  key: string,
  summary: Omit<SessionSummary, 'schemaVersion' | 'key'>,
): Promise<SessionSummary> {
  const full: SessionSummary = {
    schemaVersion: 1,
    key,
    turnSeq: summary.turnSeq,
    writtenAt: summary.writtenAt,
    body: summary.body,
  }
  const dir = join(tasksDir, key, SUMMARY_DIR)
  await mkdir(dir, { recursive: true })
  const target = summaryPath(tasksDir, key, summary.turnSeq)
  const tmp = `${target}.tmp`
  await writeFile(tmp, `${JSON.stringify(full, null, 2)}\n`, 'utf8')
  await rename(tmp, target)
  return full
}

/** Read every summary for an issue, ordered by turn. */
export async function readSummaries(tasksDir: string, key: string): Promise<SessionSummary[]> {
  const dir = join(tasksDir, key, SUMMARY_DIR)
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  const out: SessionSummary[] = []
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue
    try {
      const raw = await readFile(join(dir, name), 'utf8')
      const parsed = JSON.parse(raw) as SessionSummary
      if (typeof parsed?.turnSeq === 'number') out.push(parsed)
    } catch {
      continue
    }
  }
  return out.sort((a, b) => a.turnSeq - b.turnSeq)
}

/** How many summaries an issue has. */
export async function countSummaries(tasksDir: string, key: string): Promise<number> {
  return (await readSummaries(tasksDir, key)).length
}

/**
 * Read the activity log.
 *
 * A malformed line is skipped rather than failing the read, matching the
 * ledger's behaviour.
 */
export async function readSessionLog(tasksDir: string, key: string): Promise<SessionLogEntry[]> {
  let raw: string
  try {
    raw = await readFile(logPath(tasksDir, key), 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  const out: SessionLogEntry[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      const parsed = JSON.parse(trimmed) as Partial<SessionLogEntry>
      if (typeof parsed.ts !== 'string' || typeof parsed.text !== 'string') continue
      out.push({
        ts: parsed.ts,
        text: parsed.text,
        source: typeof parsed.source === 'string' ? parsed.source : 'unknown',
      })
    } catch {
      continue
    }
  }
  return out
}

/**
 * A one-line account of a tool call, for the activity log.
 *
 * The arguments are truncated: the log is a record that something ran, not a
 * copy of every payload.
 */
export function describeToolCall(name: string, args: string): string {
  const trimmed = args.trim()
  if (trimmed === '') return name
  const short = trimmed.length > 120 ? `${trimmed.slice(0, 120)}…` : trimmed
  return `${name} ${short}`
}
