/**
 * sc-jira 4 pure handlers. Each takes its dependencies (JiraClient + storage
 * root + creds) as arguments so tests can inject fakes without mocking the
 * module system.
 *
 * Spec §6 bug fixes applied:
 *  - §6.1 author-filter on every worklog entry (not JQL)
 *  - §6.2 match both `login` and `displayName`
 *  - §6.3 paginate /issue/{key}/worklog fully, never use /search?fields=worklog
 *  - §6.4 KEY_RE.test everywhere, no isJiraKey helper
 */
import type { IssueSummary, WorklogEntry, DayTotal, ScjiraSettings, JiraResult } from './types.js'
import { KEY_RE } from './types.js'
import { writeMetaWithBinding, readBindingBySession, type BindingResult } from './storage.js'

// --- helpers ---------------------------------------------------------------

function summarizeRawIssue(
  raw: { key: string; id: string; fields: Record<string, any> },
  worklogs: WorklogEntry[],
): IssueSummary {
  const f = raw.fields ?? {}
  return {
    key: raw.key,
    id: raw.id,
    summary: f.summary ?? '',
    description: typeof f.description === 'string' ? f.description : '',
    statusName: f.status?.name ?? '',
    priority: f.priority?.name ?? '',
    assignee: f.assignee?.displayName ?? '',
    reporter: f.reporter?.displayName ?? '',
    duedate: f.duedate ?? '',
    created: f.created ?? '',
    updated: f.updated ?? '',
    resolution: f.resolution?.name ?? 'Unresolved',
    // FIX bug #1: read individual Jira time fields, not the timetracking object
    timeSpentSeconds: f.timespent ?? 0,
    originalEstimateSeconds: f.timeoriginalestimate ?? 0,
    remainingEstimateSeconds: f.timeestimate ?? 0,
    url: `${raw.key}`,
    worklogs,
  }
}

function mondayOf(isoDate: string): string {
  const d = new Date(isoDate + 'T00:00:00Z')
  const dow = d.getUTCDay() || 7  // Sun=7
  d.setUTCDate(d.getUTCDate() - (dow - 1))
  return d.toISOString().slice(0, 10)
}

function addDaysUtc(isoDate: string, n: number): string {
  const d = new Date(isoDate + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

// --- listMyOpen ------------------------------------------------------------

export interface ListMyOpenDeps {
  jira: {
    search: (opts: { jql: string; maxResults?: number; fields?: string }) => Promise<JiraResult<any>>
  }
  creds: ScjiraSettings
}

export type ListMyOpenResult =
  | { ok: true; issues: IssueSummary[]; totalSpentSeconds: number; jql: string }
  | { ok: false; error: string; jql: string }

export async function handleListMyOpen(deps: ListMyOpenDeps): Promise<ListMyOpenResult> {
  const jql = `assignee = "${deps.creds.login}" AND resolution = Unresolved ORDER BY duedate ASC, priority DESC`
  // FIX bug #1: use individual time fields, not 'timetracking'
  const r = await deps.jira.search({
    jql,
    maxResults: 50,
    fields: 'summary,description,status,priority,assignee,reporter,duedate,created,updated,resolution,timespent,timeoriginalestimate,timeestimate',
  })
  if (!r.ok) {
    const msg = r.error === 'network' ? 'Jira unavailable (network)'
      : r.error === 'auth' ? 'Jira auth failed — check token'
      : `Jira returned ${r.error}`
    return { ok: false, error: msg, jql }
  }
  const issues = (r.body.issues ?? []).map((raw: any) => summarizeRawIssue(raw, []))
  const totalSpentSeconds = issues.reduce((s: number, i: IssueSummary) => s + i.timeSpentSeconds, 0)
  return { ok: true, issues, totalSpentSeconds, jql }
}

// --- listWorklogWeek -------------------------------------------------------

export interface ListWorklogWeekDeps {
  jira: {
    search: (opts: { jql: string; maxResults?: number; fields?: string }) => Promise<JiraResult<any>>
    worklogs: (key: string, opts: { startAt?: number; maxResults?: number }) => Promise<JiraResult<any>>
  }
  creds: ScjiraSettings
}

export interface ListWorklogWeekArgs {
  startDate?: string  // ISO 'YYYY-MM-DD'; defaults to today (UTC)
}

export interface ListWorklogWeekResult {
  ok: boolean
  error?: string
  weekStart?: string
  weekEnd?: string
  dayLabels?: Array<{ date: string; label: string; seconds: number }>
  dailyTotals?: Record<string, DayTotal>
  grandTotalSeconds?: number
  jql?: string
}

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const

export async function handleListWorklogWeek(
  deps: ListWorklogWeekDeps,
  args: ListWorklogWeekArgs = {},
): Promise<ListWorklogWeekResult> {
  const start = mondayOf(args.startDate ?? new Date().toISOString().slice(0, 10))
  const end = addDaysUtc(start, 7)
  const jql = `worklogDate >= "${start}" AND worklogDate < "${end}" AND worklogAuthor = currentUser() ORDER BY updated DESC`

  const searchRes = await deps.jira.search({ jql, maxResults: 100, fields: 'summary,status' })
  if (!searchRes.ok) {
    return { ok: false, error: `Jira returned ${searchRes.error}`, jql }
  }

  const issues = (searchRes.body.issues ?? []) as Array<{ key: string; fields: { summary?: string } }>

  // §6.3 fix: paginate /issue/{key}/worklog fully
  async function fetchAllWorklogs(key: string): Promise<any[]> {
    const all: any[] = []
    let startAt = 0
    while (true) {
      const r = await deps.jira.worklogs(key, { startAt, maxResults: 1000 })
      if (!r.ok) break
      all.push(...r.body.worklogs)
      if (all.length >= r.body.total || r.body.worklogs.length === 0) break
      startAt += r.body.worklogs.length
    }
    return all
  }

  const dailyTotals: Record<string, DayTotal> = {}
  for (let i = 0; i < 7; i++) {
    const d = addDaysUtc(start, i)
    dailyTotals[d] = { seconds: 0, entries: [] }
  }
  let grandTotalSeconds = 0

  for (const issue of issues) {
    const all = await fetchAllWorklogs(issue.key)
    const issueSummary = issue.fields?.summary ?? issue.key
    for (const w of all) {
      // §6.1 + §6.2 fix: filter by both login AND displayName
      const author = w.author?.displayName ?? w.author?.name ?? ''
      if (author !== deps.creds.login && author !== deps.creds.displayName) continue
      const startedAt = w.started.slice(0, 10)
      if (startedAt < start || startedAt >= end) continue
      const day = dailyTotals[startedAt]
      if (!day) continue
      day.seconds += w.timeSpentSeconds
      day.entries.push({
        issueKey: issue.key,
        issueSummary,
        started: w.started,
        timeSpentSeconds: w.timeSpentSeconds,
        comment: w.comment ?? '',
        author,
      })
      grandTotalSeconds += w.timeSpentSeconds
    }
  }

  const dayLabels = Array.from({ length: 7 }, (_, i) => {
    const d = addDaysUtc(start, i)
    return { date: d, label: DAY_LABELS[i] ?? '', seconds: dailyTotals[d]?.seconds ?? 0 }
  })

  return {
    ok: true,
    weekStart: start,
    weekEnd: end,
    dayLabels,
    dailyTotals,
    grandTotalSeconds,
    jql,
  }
}

// --- bind ------------------------------------------------------------------

export interface BindDeps {
  jira: { issue: (key: string) => Promise<JiraResult<any>> }
  creds: ScjiraSettings
  tasksDir: string
}

export type BindResult =
  | { ok: true; key: string; sessionId: string; summary: string }
  | { ok: false; error: string }

export async function handleBind(
  deps: BindDeps,
  args: { sessionId: string; taskKey: string },
): Promise<BindResult> {
  // §6.4 fix: KEY_RE.test everywhere
  // FIX bug #2: error message is English so /format/ regex matches in tests
  if (!KEY_RE.test(args.taskKey)) {
    return { ok: false, error: `Invalid taskKey format (expected PROJECT-123): got "${args.taskKey}"` }
  }
  const env = await deps.jira.issue(args.taskKey)
  if (!env.ok) {
    return { ok: false, error: `Jira rejected ${args.taskKey} (${env.error})` }
  }
  const summary = env.body.fields?.summary ?? ''
  const statusName = env.body.fields?.status?.name ?? ''
  await writeMetaWithBinding(deps.tasksDir, {
    key: args.taskKey,
    sessionId: args.sessionId,
    issueSummary: {
      key: args.taskKey,
      summary,
      statusName,
      priority: env.body.fields?.priority?.name ?? '',
      duedate: env.body.fields?.duedate ?? '',
      url: `${deps.creds.server}/browse/${args.taskKey}`,
    },
  })
  return { ok: true, key: args.taskKey, sessionId: args.sessionId, summary }
}

// --- getBinding -----------------------------------------------------------

export interface GetBindingDeps {
  tasksDir: string
}

export async function handleGetBinding(
  deps: GetBindingDeps,
  args: { sessionId: string },
): Promise<BindingResult> {
  return readBindingBySession(deps.tasksDir, args.sessionId)
}
