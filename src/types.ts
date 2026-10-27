/**
 * sc-jira shared types. Imported by host (`src/index.ts`, `src/handlers.ts`,
 * `src/jira-client.ts`) and by client (`src/client/*.tsx`).
 */

export interface IssueSummary {
  key: string
  id: string
  summary: string
  description: string
  statusName: string
  priority: string
  assignee: string
  reporter: string
  duedate: string
  created: string
  updated: string
  resolution: string
  timeSpentSeconds: number
  originalEstimateSeconds: number
  remainingEstimateSeconds: number
  url: string
  worklogs: WorklogEntry[]
}

export interface WorklogEntry {
  id: string
  author: string
  started: string
  timeSpentSeconds: number
  comment: string
}

export interface DayTotal {
  seconds: number
  entries: Array<{
    issueKey: string
    issueSummary: string
    started: string
    timeSpentSeconds: number
    comment: string
    author: string
  }>
}

export interface ScjiraSettings {
  server: string
  login: string
  token: string
  displayName: string
  proxy: string  // optional; env var HTTPS_PROXY/HTTP_PROXY takes precedence
  /**
   * How a bound session's Jira scope is enforced.
   *
   * `advisory` — the model is told which issue the session is on and is
   * warned when it reaches for another one; nothing is blocked. This is the
   * default: a hard stop can trap an agent that legitimately needs to look
   * at a neighbouring issue to finish the work.
   *
   * `narrow` — a tool call that names another issue is refused with a reason.
   */
  scopeMode: ScopeMode
}

/**
 * How strongly a session's Jira scope is enforced.
 *
 * `advisory` warns; `narrow` refuses.
 */
export type ScopeMode = 'advisory' | 'narrow'

/** Default scope mode. */
export const DEFAULT_SCOPE_MODE: ScopeMode = 'advisory'

export interface MetaJsonV3 {
  schemaVersion: 3
  key: string
  status: 'active' | 'ended'
  startedAt: string
  endedAt: string | null
  dshSessionId: string
  issueSummary: {
    key: string
    summary: string
    statusName: string
    priority: string
    duedate: string
    url: string
  }
  logCount: number
  logBytes: number
  summaryCount: number
}

/**
 * Where a local worklog entry stands.
 *
 * `draft` — recorded locally, never sent to Jira.
 * `synced` — uploaded; `jiraId` names the Jira worklog.
 * `failed` — an upload attempt failed; the error is kept for a retry.
 */
export type WorklogEntryState = 'draft' | 'synced' | 'failed'

/**
 * Automatic worklog recording policy.
 *
 * The defaults match the reviewed decisions: recording is on, and the mode
 * is one turn (one user question and its answer) rather than one step.
 */
export interface AutoWorklogConfig {
  /** Record automatically at turn end. */
  enabled: boolean
  /** Ignore a turn shorter than this many seconds. */
  minSeconds: number
  /** Round the recorded duration up to a multiple of this many seconds. */
  rounding: number
  /** Cap one turn's recorded duration; a longer turn records this much. */
  maxSecondsPerTurn: number
  /** Put the session id in the worklog comment. */
  includeSessionId: boolean
}

/**
 * meta.json schema v4.
 *
 * v4 adds the automatic-worklog policy and makes the three counters real:
 * `logCount` / `logBytes` / `summaryCount` were placeholders in v3 that
 * nothing ever updated.
 */
export interface MetaJsonV4 extends Omit<MetaJsonV3, 'schemaVersion'> {
  schemaVersion: 4
  /** Rows in `log.jsonl`. */
  logCount: number
  /** Bytes of `log.jsonl`. */
  logBytes: number
  /** Files under `summary/`. */
  summaryCount: number
  /** Automatic worklog recording policy. */
  autoWorklog: AutoWorklogConfig
}

/** Default automatic-worklog policy. */
export const DEFAULT_AUTO_WORKLOG: AutoWorklogConfig = {
  enabled: true,
  minSeconds: 60,
  rounding: 60,
  maxSecondsPerTurn: 14400,
  includeSessionId: true,
}

/** A session's turn summary, mirroring the v2 leftover format. */
export interface SessionSummary {
  schemaVersion: 1
  key: string
  turnSeq: number
  writtenAt: string
  body: {
    text: string
    highlights: string[]
    blockers: string[]
  }
}

/** One row of `log.jsonl`, mirroring the v2 leftover format. */
export interface SessionLogEntry {
  ts: string
  text: string
  source: string
}

/**
 * The derived bidirectional binding index.
 *
 * A convenience file, never a source of truth: `meta.json` decides, and the
 * index is rebuilt when the two disagree.
 */
export interface BindingIndex {
  schemaVersion: 1
  /** sessionId → issue key. */
  bySession: Record<string, string>
  /** issue key → sessionId. */
  byKey: Record<string, string>
}

export const KEY_RE = /^[A-Z][A-Z0-9_]*-\d+$/

export type JiraErrorKind = 'auth' | 'http' | 'network' | 'parse'

export type JiraResult<T> =
  | { ok: true; body: T }
  | { ok: false; error: JiraErrorKind; detail?: string }
