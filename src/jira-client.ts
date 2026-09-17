/**
 * sc-jira JiraClient — wraps Jira REST via `ctx.subprocess.spawn(['curl', ...])`.
 *
 * DSH Node sandbox disables fetch; this is the proven workaround (see
 * scjira-7 spec §4.1). The spawn function is injected so tests can mock it.
 */
import type { ScjiraSettings, JiraResult } from './types.js'

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
    return 'Basic ' + Buffer.from(`${this.creds.login}:${this.creds.token}`).toString('base64')
  }

  /** Returns HTTP status + body. status === -1 signals a network/transport failure. */
  private async curl(url: string, signal?: AbortSignal): Promise<{ status: number; body: string }> {
    let res: SpawnResult
    try {
      const args = [
        '-sS',
        '-w', '\n%{http_code}',
        '-H', `Authorization: ${this.authHeader()}`,
        '-H', 'Accept: application/json',
        url,
      ]
      res = signal
        ? await this.spawn('curl', args, { signal })
        : await this.spawn('curl', args)
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
    const { status, body } = await this.curl(`${this.creds.server}/rest/api/2/issue/${key}`, signal)
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
      `${this.creds.server}/rest/api/2/issue/${key}/worklog?${params.toString()}`,
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
    signal?: AbortSignal
  }): Promise<JiraResult<RawSearchPage>> {
    const params = new URLSearchParams()
    params.set('jql', opts.jql)
    params.set('maxResults', String(opts.maxResults ?? this.defaultSearchMaxResults))
    params.set('fields', opts.fields ?? this.defaultSearchFields)
    const { status, body } = await this.curl(
      `${this.creds.server}/rest/api/2/search?${params.toString()}`,
      opts.signal,
    )
    const bad = this.classify(status, body)
    if (bad) return bad
    return this.tryParse<RawSearchPage>(body)
  }
}

// Default spawn throws clearly when called outside a real ctx environment.
const defaultSpawn: SpawnFn = async () => {
  throw new Error('JiraClient: no spawn function provided (must be wired via ctx.subprocess.spawn)')
}