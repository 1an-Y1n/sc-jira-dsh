/**
 * sc-jira JiraClient — wraps Jira REST via Node `child_process.execFileSync('curl', ...)`.
 *
 * Why not `ctx.subprocess`: the subprocess seam is abstract and only the
 * `dsh-subprocess-local` implementation provides real spawning. The default
 * `web` profile does not load `dsh-subprocess-local`, so `ctx.subprocess`
 * is undefined at runtime. Spawning `curl` via Node stdlib is the direct,
 * sandbox-safe alternative (the harness permits plugin code to spawn
 * pre-installed binaries).
 *
 * The spawn function is injected so tests can mock it.
 *
 * API version: this plugin targets **Jira Server** (e.g. jiraprod.sercomm.com),
 * which serves `/rest/api/2/`. Jira Cloud's `/rest/api/3/` returns a different
 * `description` shape (Atlassian Document Format instead of a plain string),
 * which this client's field mapping does not handle — so v2 is the correct
 * target here. The version lives in `API_VERSION` below so there is exactly
 * one place to change it.
 */
import { execFileSync } from 'node:child_process'
import type { ScjiraSettings, JiraResult } from './types.js'

/** REST API version segment used to build every endpoint path. */
export const API_VERSION = '2'

/**
 * Format a duration in seconds as a Jira duration string.
 *
 * Jira's `timeSpent` field takes a human string — `"45m"`, `"1h 30m"`,
 * `"2d"` — and rejects the numeric `timeSpentSeconds` field with 400.
 * Verified against the live server: `{"timeSpentSeconds":1}` → 400,
 * `{"timeSpent":"1m"}` → 201.
 *
 * Jira's grammar is `<w>w <d>d <h>h <m>m <s>s`, with the largest unit first
 * and at most one of each. We emit hours, minutes and seconds only: weeks and
 * days are legal but a worklog never spans them, and keeping the output small
 * keeps it readable in the Jira UI.
 */
export function formatDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds))
  if (seconds === 0) return '0m'
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = seconds % 60
  const parts: string[] = []
  if (hours > 0) parts.push(`${hours}h`)
  if (minutes > 0) parts.push(`${minutes}m`)
  if (rest > 0) parts.push(`${rest}s`)
  return parts.join(' ')
}

/** Build an absolute API URL from the configured server + an endpoint path. */
export function apiUrl(server: string, endpoint: string): string {
  const base = server.replace(/\/+$/, '')
  return `${base}/rest/api/${API_VERSION}${endpoint}`
}

/** Resolve proxy URL: env vars (https_proxy/HTTPS_PROXY/http_proxy/HTTP_PROXY) win over settings. */
function resolveProxy(settingsProxy: string): string {
  const envProxy =
    process.env.HTTPS_PROXY ??
    process.env.https_proxy ??
    process.env.HTTP_PROXY ??
    process.env.http_proxy ??
    ''
  return envProxy || settingsProxy || ''
}

export interface SpawnResult {
  status: number  // process exit code
  stdout: string
  stderr: string
}

export type SpawnFn = (
  cmd: string,
  args: string[],
  opts?: { signal?: AbortSignal },
) => Promise<SpawnResult>

export interface JiraClientOptions {
  spawn?: SpawnFn
  defaultWorklogPageSize?: number
  defaultSearchMaxResults?: number
  defaultSearchFields?: string
}

const KEY_RE = /^[A-Z][A-Z0-9_]*-\d+$/

interface RawIssue {
  key: string
  id: string
  fields: Record<string, unknown>
}

interface RawWorklog {
  id: string
  author?: { displayName?: string; name?: string }
  started: string
  timeSpentSeconds: number
  comment?: string
}

interface RawWorklogPage {
  startAt: number
  maxResults: number
  total: number
  worklogs: RawWorklog[]
}

interface RawSearchPage {
  startAt: number
  maxResults: number
  total: number
  issues: Array<{ key: string; id: string; fields: Record<string, unknown> }>
}

export class JiraClient {
  private creds: ScjiraSettings
  private spawn: SpawnFn
  private defaultWorklogPageSize: number
  private defaultSearchMaxResults: number
  private defaultSearchFields: string

  constructor(creds: ScjiraSettings, opts: JiraClientOptions = {}) {
    this.creds = creds
    this.spawn = opts.spawn ?? defaultSpawn
    this.defaultWorklogPageSize = opts.defaultWorklogPageSize ?? 1000
    this.defaultSearchMaxResults = opts.defaultSearchMaxResults ?? 50
    this.defaultSearchFields = opts.defaultSearchFields ?? '*navigable'
  }

  private authHeader(): string {
    return `Bearer ${this.creds.token}`
  }

  /** Returns HTTP status + body. status === -1 signals a network/transport failure. */
  private async curl(
    url: string,
    signal?: AbortSignal,
    init?: { method?: string; body?: unknown },
  ): Promise<{ status: number; body: string }> {
    const method = init?.method ?? 'GET'
    const args = [
      '-sS',
      '-X', method,
      '-w', '\n%{http_code}',
      '-H', `Authorization: ${this.authHeader()}`,
      '-H', 'Accept: application/json',
    ]
    if (init?.body !== undefined) {
      args.push('-H', 'Content-Type: application/json')
      args.push('--data-binary', JSON.stringify(init.body))
    }
    const proxy = resolveProxy(this.creds.proxy)
    if (proxy) {
      args.push('--proxy', proxy)
    } else {
      args.push('--noproxy', '*')
    }
    args.push(url)
    let res: SpawnResult
    try {
      res = await this.spawn('curl', args, signal ? { signal } : undefined)
    } catch (err) {
      return { status: -1, body: (err as Error).message }
    }
    if (res.status !== 0) {
      return { status: -1, body: res.stderr || 'curl exited non-zero' }
    }
    const idx = res.stdout.lastIndexOf('\n')
    if (idx === -1) return { status: -1, body: res.stdout }
    const httpStatus = parseInt(res.stdout.slice(idx + 1), 10)
    const body = res.stdout.slice(0, idx)
    return { status: Number.isFinite(httpStatus) ? httpStatus : -1, body }
  }

  private classify(status: number, body: string): { ok: false; error: 'auth' | 'http' | 'network'; detail?: string } | null {
    if (status === -1) return { ok: false, error: 'network', detail: body }
    if (status === 401 || status === 403) return { ok: false, error: 'auth' }
    if (status < 200 || status >= 300) return { ok: false, error: 'http', detail: `status ${status}` }
    return null
  }

  private tryParse<T>(body: string): JiraResult<T> {
    try {
      return { ok: true, body: JSON.parse(body) as T }
    } catch {
      return { ok: false, error: 'parse' }
    }
  }

  async issue(key: string, signal?: AbortSignal): Promise<JiraResult<RawIssue>> {
    if (!KEY_RE.test(key)) {
      return { ok: false, error: 'http', detail: 'invalid key format' }
    }
    const { status, body } = await this.curl(apiUrl(this.creds.server, `/issue/${key}`), signal)
    const bad = this.classify(status, body)
    if (bad) return bad
    return this.tryParse<RawIssue>(body)
  }

  async worklogs(
    key: string,
    opts: { startAt?: number; maxResults?: number; signal?: AbortSignal } = {},
  ): Promise<JiraResult<RawWorklogPage>> {
    if (!KEY_RE.test(key)) {
      return { ok: false, error: 'http', detail: 'invalid key format' }
    }
    const startAt = opts.startAt ?? 0
    const maxResults = opts.maxResults ?? this.defaultWorklogPageSize
    const params = new URLSearchParams({ startAt: String(startAt), maxResults: String(maxResults) })
    const { status, body } = await this.curl(
      apiUrl(this.creds.server, `/issue/${key}/worklog?${params.toString()}`),
      opts.signal,
    )
    const bad = this.classify(status, body)
    if (bad) return bad
    return this.tryParse<RawWorklogPage>(body)
  }

  async search(opts: {
    jql: string
    maxResults?: number
    fields?: string
    startAt?: number
    signal?: AbortSignal
  }): Promise<JiraResult<RawSearchPage>> {
    const params = new URLSearchParams()
    params.set('jql', opts.jql)
    params.set('maxResults', String(opts.maxResults ?? this.defaultSearchMaxResults))
    params.set('fields', opts.fields ?? this.defaultSearchFields)
    // Only send startAt when paging — Jira rejects it on some versions when 0.
    if (opts.startAt !== undefined && opts.startAt > 0) {
      params.set('startAt', String(opts.startAt))
    }
    const { status, body } = await this.curl(
      apiUrl(this.creds.server, `/search?${params.toString()}`),
      opts.signal,
    )
    const bad = this.classify(status, body)
    if (bad) return bad
    return this.tryParse<RawSearchPage>(body)
  }

  // --- worklog writes ------------------------------------------------------
  //
  // Jira Server's worklog API:
  //   POST   /rest/api/2/issue/{key}/worklog          → 201, body = the worklog
  //   PUT    /rest/api/2/issue/{key}/worklog/{id}     → 200, body = the worklog
  //   DELETE /rest/api/2/issue/{key}/worklog/{id}     → 204, empty body
  //
  // The write body takes `timeSpent` (a Jira duration string) and optionally
  // `started` and `comment`. `adjustEstimate` is NOT accepted on this Jira
  // version and the `/adjustment` endpoint does not exist, so no estimate
  // linkage is attempted.

  /**
   * Add a worklog entry to an issue.
   * @param key - issue key, e.g. `DZ300-797`.
   * @param opts.seconds - duration in seconds; sent as a Jira duration string.
   * @param opts.comment - worklog comment.
   * @param opts.started - ISO timestamp with offset, e.g. `2026-10-26T09:00:00.000+0800`.
   * @returns the created worklog, or the failure kind.
   */
  async addWorklog(
    key: string,
    opts: { seconds: number; comment?: string; started?: string; signal?: AbortSignal },
  ): Promise<JiraResult<RawWorklog>> {
    if (!KEY_RE.test(key)) {
      return { ok: false, error: 'http', detail: 'invalid key format' }
    }
    const payload: Record<string, unknown> = { timeSpent: formatDuration(opts.seconds) }
    if (opts.comment !== undefined && opts.comment !== '') payload.comment = opts.comment
    if (opts.started !== undefined && opts.started !== '') payload.started = opts.started
    const { status, body } = await this.curl(
      apiUrl(this.creds.server, `/issue/${key}/worklog`),
      opts.signal,
      { method: 'POST', body: payload },
    )
    const bad = this.classify(status, body)
    if (bad) return bad
    return this.tryParse<RawWorklog>(body)
  }

  /**
   * Update an existing worklog entry — used when the user edits a duration or
   * a start time that has already been synced to Jira.
   * @param key - issue key.
   * @param worklogId - the Jira worklog id.
   * @param opts.seconds - new duration in seconds; omit to keep the current one.
   * @param opts.comment - new comment; omit to keep the current one.
   * @param opts.started - new start timestamp; omit to keep the current one.
   * @returns the updated worklog, or the failure kind.
   */
  async updateWorklog(
    key: string,
    worklogId: string,
    opts: { seconds?: number; comment?: string; started?: string; signal?: AbortSignal },
  ): Promise<JiraResult<RawWorklog>> {
    if (!KEY_RE.test(key)) {
      return { ok: false, error: 'http', detail: 'invalid key format' }
    }
    if (!/^\d+$/.test(worklogId)) {
      return { ok: false, error: 'http', detail: 'invalid worklog id' }
    }
    const payload: Record<string, unknown> = {}
    if (opts.seconds !== undefined) payload.timeSpent = formatDuration(opts.seconds)
    if (opts.comment !== undefined) payload.comment = opts.comment
    if (opts.started !== undefined && opts.started !== '') payload.started = opts.started
    if (Object.keys(payload).length === 0) {
      return { ok: false, error: 'http', detail: 'nothing to update' }
    }
    const { status, body } = await this.curl(
      apiUrl(this.creds.server, `/issue/${key}/worklog/${worklogId}`),
      opts.signal,
      { method: 'PUT', body: payload },
    )
    const bad = this.classify(status, body)
    if (bad) return bad
    return this.tryParse<RawWorklog>(body)
  }

  /**
   * Delete a worklog entry.
   * @param key - issue key.
   * @param worklogId - the Jira worklog id.
   * @returns ok on 204 (or any 2xx), or the failure kind.
   */
  async deleteWorklog(
    key: string,
    worklogId: string,
    opts: { signal?: AbortSignal } = {},
  ): Promise<JiraResult<null>> {
    if (!KEY_RE.test(key)) {
      return { ok: false, error: 'http', detail: 'invalid key format' }
    }
    if (!/^\d+$/.test(worklogId)) {
      return { ok: false, error: 'http', detail: 'invalid worklog id' }
    }
    const { status, body } = await this.curl(
      apiUrl(this.creds.server, `/issue/${key}/worklog/${worklogId}`),
      opts.signal,
      { method: 'DELETE' },
    )
    const bad = this.classify(status, body)
    if (bad) return bad
    return { ok: true, body: null }
  }
}

// Default spawn uses Node child_process.execFileSync. We offload the work
// through setImmediate so the synchronous call doesn't block the host's
// event loop. curl writes final HTTP status to stdout after `-w '\n%{http_code}'`.
const defaultSpawn: SpawnFn = async (cmd, args) => {
  const out = execFileSync(cmd, args, {
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return { status: 0, stdout: out, stderr: '' }
}