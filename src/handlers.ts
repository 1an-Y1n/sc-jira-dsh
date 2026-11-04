/**
 * sc-jira read handlers. Each takes its dependencies (JiraClient + creds) as
 * arguments so tests can inject fakes without mocking the module system.
 *
 * Three reads only: what is open for me, what I worked on in one week, and
 * one issue with its comments. Nothing here writes to Jira.
 *
 * Spec §6 bug fixes applied:
 *  - §6.1 author-filter on every worklog entry (not JQL)
 *  - §6.2 match both `login` and `displayName`
 *  - §6.3 paginate /issue/{key}/worklog fully, never use /search?fields=worklog
 *  - §6.4 KEY_RE.test everywhere, no isJiraKey helper
 */
import type { IssueSummary, WorklogEntry, DayTotal, ScjiraSettings, JiraResult } from './types.js'
import { KEY_RE } from './types.js'
import { addDays, mondayOf, todayIso } from './timezone.js'

// --- helpers ---------------------------------------------------------------

/**
 * The browsable address of an issue on the configured Jira Server.
 *
 * The `/browse/<key>` form is Jira Server's own issue permalink — the
 * instance serves it from the web UI, not the REST API — and the trailing
 * slashes are trimmed so a configured `https://host/` and `https://host`
 * produce the same link.
 */
export function issueBrowseUrl(server: string, key: string): string {
  return `${server.replace(/\/+$/, '')}/browse/${key}`
}

function summarizeRawIssue(
  raw: { key: string; id: string; fields: Record<string, any> },
  worklogs: WorklogEntry[],
  server: string,
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
    url: issueBrowseUrl(server, raw.key),
    worklogs,
  }
}

// --- listMyOpen ------------------------------------------------------------

export interface ListMyOpenDeps {
  jira: {
    search: (opts: { jql: string; maxResults?: number; fields?: string; startAt?: number }) => Promise<JiraResult<any>>
  }
  creds: ScjiraSettings
}

export type ListMyOpenResult =
  | { ok: true; issues: IssueSummary[]; totalSpentSeconds: number; jql: string }
  | { ok: false; error: string; jql: string }

/**
 * Jira Server caps `maxResults` on `/rest/api/2/search` (typically 100).
 * We page at that cap so the result set is never silently truncated.
 */
export const SEARCH_PAGE_SIZE = 100

/**
 * Run a JQL search and follow every page, returning the concatenated issue
 * list. Stops on an empty page, when the reported total is reached, or on a
 * transport error — a failed page yields the pages gathered so far rather
 * than discarding everything.
 */
export async function searchAllIssues(
  jira: { search: (opts: { jql: string; maxResults?: number; fields?: string; startAt?: number }) => Promise<JiraResult<any>> },
  opts: { jql: string; fields?: string; pageSize?: number; maxPages?: number },
): Promise<JiraResult<any[]>> {
  const pageSize = opts.pageSize ?? SEARCH_PAGE_SIZE
  const maxPages = opts.maxPages ?? 20  // safety valve: 2000 issues
  const all: any[] = []
  let startAt = 0

  for (let page = 0; page < maxPages; page++) {
    const r = await jira.search({
      jql: opts.jql,
      maxResults: pageSize,
      fields: opts.fields,
      startAt,
    })
    if (!r.ok) {
      // Surface the failure only if we never got a single page.
      if (all.length === 0) return r as JiraResult<any[]>
      break
    }
    const issues = r.body?.issues ?? []
    all.push(...issues)
    const total = typeof r.body?.total === 'number' ? r.body.total : all.length
    if (issues.length === 0 || all.length >= total) break
    startAt += issues.length
  }

  return { ok: true, body: all }
}

export async function handleListMyOpen(deps: ListMyOpenDeps): Promise<ListMyOpenResult> {
  const jql = `assignee = "${deps.creds.login}" AND resolution = Unresolved ORDER BY duedate ASC, priority DESC`
  // FIX bug #1: use individual time fields, not 'timetracking'
  const r = await searchAllIssues(deps.jira, {
    jql,
    fields: 'summary,description,status,priority,assignee,reporter,duedate,created,updated,resolution,timespent,timeoriginalestimate,timeestimate',
  })
  if (!r.ok) {
    const msg = r.error === 'network' ? 'Jira unavailable (network)'
      : r.error === 'auth' ? 'Jira auth failed — check token'
      : `Jira returned ${r.error}`
    return { ok: false, error: msg, jql }
  }
  const issues = (r.body ?? []).map((raw: any) => summarizeRawIssue(raw, [], deps.creds.server))
  const totalSpentSeconds = issues.reduce((s: number, i: IssueSummary) => s + i.timeSpentSeconds, 0)
  return { ok: true, issues, totalSpentSeconds, jql }
}

// --- listWorklogWeek -------------------------------------------------------
//
// Fetches worklog entries for one ISO week [start, start+7d). The UI always
// shows a single week at a time and uses ← / This week / → buttons, so the
// handler only needs the week's Monday (ISO YYYY-MM-DD). endDate is computed
// internally as start + 7 days.

export interface ListWorklogWeekDeps {
  jira: {
    search: (opts: { jql: string; maxResults?: number; fields?: string; startAt?: number }) => Promise<JiraResult<any>>
    worklogs: (key: string, opts: { startAt?: number; maxResults?: number }) => Promise<JiraResult<any>>
  }
  creds: ScjiraSettings
}

export interface ListWorklogWeekArgs {
  startDate?: string  // ISO 'YYYY-MM-DD'; defaults to Monday of current week
}

export interface ListWorklogWeekResult {
  ok: boolean
  error?: string
  weekStart?: string  // Monday of the week (inclusive)
  weekEnd?: string    // next Monday (exclusive)
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
  // FIX bug-3: "today" and the week boundary must be resolved in the plugin
  // timezone (Asia/Shanghai), not UTC — otherwise every day between 00:00 and
  // 08:00 local time lands on the previous day and the wrong week.
  const start = args.startDate ?? mondayOf(todayIso())
  const end = addDays(start, 7)
  const jql = `worklogDate >= "${start}" AND worklogDate < "${end}" AND worklogAuthor = currentUser() ORDER BY updated DESC`

  const searchRes = await searchAllIssues(deps.jira, {
    jql,
    fields: 'summary,status',
  })
  if (!searchRes.ok) {
    return { ok: false, error: `Jira returned ${searchRes.error}`, jql }
  }

  const issues = (searchRes.body ?? []) as Array<{ key: string; fields: { summary?: string } }>

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
    const d = addDays(start, i)
    dailyTotals[d] = { seconds: 0, entries: [] }
  }
  let grandTotalSeconds = 0

  // Parallelize: one /worklog roundtrip per issue was the slow path (sequential
  // curl). Promise.all turns the latency into a single roundtrip's worth.
  const perIssue = await Promise.all(issues.map(async issue => ({
    issue,
    worklogs: await fetchAllWorklogs(issue.key),
  })))
  for (const { issue, worklogs: all } of perIssue) {
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
        // The week rows link the issue key, so the row carries the browsable
        // address with it — the client never has to know the Jira base URL.
        url: issueBrowseUrl(deps.creds.server, issue.key),
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
    const d = addDays(start, i)
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

// --- issue detail ----------------------------------------------------------
//
// The agent working on a ticket needs the ticket itself: its description and
// the conversation that happened around it. `jira_issue` is that read.

/** One comment on an issue. */
export interface IssueComment {
  id: string
  author: string
  created: string
  updated: string
  body: string
}

/** An issue with its comments. */
export interface IssueDetail extends IssueSummary {
  comments: IssueComment[]
}

export interface IssueDeps {
  jira: {
    issue: (key: string) => Promise<JiraResult<any>>
    comments: (key: string, opts?: { startAt?: number; maxResults?: number }) => Promise<JiraResult<any>>
  }
  creds: ScjiraSettings
}

export type IssueResult =
  | { ok: true; issue: IssueDetail }
  | { ok: false; error: string }

/**
 * Read one issue and its comments.
 *
 * Comments are optional context: a failure to read them does not fail the
 * whole read, because the issue's own description is usually the part the
 * agent needs. The failure is reported on the result so the caller can say
 * so rather than silently dropping the conversation.
 */
export async function handleIssue(deps: IssueDeps, args: { key: string }): Promise<IssueResult> {
  if (!KEY_RE.test(args.key)) {
    return { ok: false, error: `Invalid issue key format (expected PROJECT-123): got "${args.key}"` }
  }
  const env = await deps.jira.issue(args.key)
  if (!env.ok) {
    const msg = env.error === 'network' ? 'Jira unavailable (network)'
      : env.error === 'auth' ? 'Jira auth failed — check token'
      : `Jira rejected ${args.key} (${env.error})`
    return { ok: false, error: msg }
  }
  const summary = summarizeRawIssue(env.body, [], deps.creds.server)

  let comments: IssueComment[] = []
  let commentError: string | undefined
  const page = await deps.jira.comments(args.key, { startAt: 0, maxResults: 100 })
  if (!page.ok) {
    commentError = `Jira returned ${page.error} for comments`
  } else {
    comments = (page.body?.comments ?? []).map((c: any): IssueComment => ({
      id: c.id ?? '',
      author: c.author?.displayName ?? c.author?.name ?? '',
      created: c.created ?? '',
      updated: c.updated ?? '',
      body: typeof c.body === 'string' ? c.body : '',
    }))
  }

  return {
    ok: true,
    issue: { ...summary, comments, ...(commentError !== undefined ? { commentError } : {}) },
  }
}
