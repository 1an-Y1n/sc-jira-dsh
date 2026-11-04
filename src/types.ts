/**
 * sc-jira shared types. Imported by host (`src/index.ts`, `src/handlers.ts`,
 * `src/worklog-handlers.ts`, `src/jira-client.ts`) and by the client.
 *
 * Two halves live here: the Jira shapes the read side returns, and the
 * worklog document a session accumulates (see docs/design/v4-worklog-redesign.md).
 */

// --- Jira read shapes ------------------------------------------------------

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
    /** The issue's browsable address on the configured Jira Server. */
    url: string
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
}

// --- worklog document ------------------------------------------------------

/**
 * One recorded piece of work.
 *
 * The agent writes these: only it knows what it was doing. `seconds` may be
 * derived by the host from the wall clock since the previous record — that is
 * the one measurement the host contributes, and `source` says which happened.
 */
export interface Activity {
  /** Local id, `act-NN`, monotonic within one session document. */
  id: string
  summary: string
  /** ISO instant with the +0800 offset the ledger has always used. */
  startedAt: string
  seconds: number
  /** The turn the record was made in, or null outside a turn. */
  turn: number | null
  /** `agent` when the caller gave the duration; `derived` when the host measured it. */
  source: 'agent' | 'derived'
}

/**
 * One turn's measured span.
 *
 * Pure measurement: it never becomes a worklog entry by itself. It gives a
 * recorded activity its default duration, and it tells the reader how much
 * measured time the records do not account for.
 */
export interface TurnSpan {
  turn: number
  startedAt: string
  endedAt: string
  seconds: number
}

/** Where one draft entry stands. */
export type DraftState = 'draft' | 'synced' | 'failed'

/** One Jira-shaped worklog entry, before or after upload. */
export interface DraftEntry {
  /** Local id, `wl-NN`. */
  id: string
  /** ISO instant with +0800; Jira's `started`. */
  startedAt: string
  seconds: number
  /** Jira's worklog comment. */
  comment: string
  /** The activities this entry accounts for; empty for an unbacked extra. */
  activityIds: string[]
  state: DraftState
  /** The Jira worklog id once synced. */
  jiraId: string | null
  syncedAt: string | null
  /** Failure detail while `state` is `failed`. */
  error: string | null
}

/** The issue a session is bound to. */
export interface Binding {
  key: string
  summary: string
  statusName: string
  url: string
  /** When the binding was made, ISO. */
  boundAt: string
}

/** The generated worklog of one session. */
export interface Draft {
  generatedAt: string
  entries: DraftEntry[]
}

/**
 * One session's worklog document — the plugin's only local state.
 *
 * A round is one binding: binding + its activities + its measured turns + the
 * draft generated from them. A session that switches to another issue starts a
 * new round (see `session-store.ts`).
 */
export interface SessionDoc {
  schemaVersion: 1
  sessionId: string
  binding: Binding | null
  activities: Activity[]
  turns: TurnSpan[]
  draft: Draft | null
}

/**
 * How a recorded duration is derived and clamped.
 *
 * Configuration, not per-binding state: v3 stored the policy inside every
 * binding and then offered no way to change it.
 */
export interface WorklogPolicy {
  /** A derived duration shorter than this is refused rather than recorded. */
  minSeconds: number
  /** Derived durations round UP to a multiple of this. */
  rounding: number
  /** One activity may not claim more than this, however long the gap. */
  maxSecondsPerActivity: number
}

export const DEFAULT_WORKLOG_POLICY: WorklogPolicy = {
  minSeconds: 60,
  rounding: 60,
  maxSecondsPerActivity: 14400,
}

export const KEY_RE = /^[A-Z][A-Z0-9_]*-\d+$/

export type JiraErrorKind = 'auth' | 'http' | 'network' | 'parse'

export type JiraResult<T> =
  | { ok: true; body: T }
  | { ok: false; error: JiraErrorKind; detail?: string }
