/**
 * sc-jira shared types. Imported by host (`src/index.ts`, `src/handlers.ts`,
 * `src/jira-client.ts`) and by client (`src/client/*.tsx`).
 *
 * The plugin is READ-ONLY: it lists issues, reads one issue, and reports one
 * week of worklogs. It stores nothing of its own, so there is no binding, no
 * ledger, and no local state type here.
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

export const KEY_RE = /^[A-Z][A-Z0-9_]*-\d+$/

export type JiraErrorKind = 'auth' | 'http' | 'network' | 'parse'

export type JiraResult<T> =
  | { ok: true; body: T }
  | { ok: false; error: JiraErrorKind; detail?: string }
