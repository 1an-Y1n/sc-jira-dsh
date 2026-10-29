import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockSpawn = vi.fn()

import { JiraClient, API_VERSION, apiUrl, formatDuration } from '../src/jira-client.js'

const creds = {
  server: 'https://jiratest.example.com',
  login: 'A003688',
  token: 'fake-token',
  displayName: 'Ian Yin',
  proxy: '',
}

describe('JiraClient', () => {
  beforeEach(() => {
    mockSpawn.mockReset()
  })

  it('issue() returns ok on 200 JSON', async () => {
    const client = new JiraClient(creds, { spawn: makeSpawnMock({ httpStatus: 200, body: JSON.stringify({ key: 'DZ300-1', id: '100', fields: {} }) }) })
    const r = await client.issue('DZ300-1')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.body.key).toBe('DZ300-1')
  })

  it('issue() sends Bearer auth header on every request', async () => {
    const client = new JiraClient(creds, { spawn: makeSpawnMock({ httpStatus: 200, body: '{}' }) })
    await client.issue('DZ300-1')
    const args = (mockSpawn.mock.calls[0]?.[1] as string[] | undefined) ?? []
    // Find the index of '-H' that precedes an Authorization header.
    const authIdx = args.findIndex(a => /^Authorization: Bearer /.test(a))
    expect(authIdx).toBeGreaterThan(0)
    expect(args[authIdx - 1]).toBe('-H')
    expect(args[authIdx]).toBe(`Authorization: Bearer ${creds.token}`)
  })

  it('issue() never caches — repeat calls always hit Jira', async () => {
    const client = new JiraClient(creds, {
      spawn: makeSpawnMock({ httpStatus: 200, body: JSON.stringify({ key: 'DZ300-1', id: '100', fields: {} }) }),
    })
    await client.issue('DZ300-1')
    await client.issue('DZ300-1')
    await client.issue('DZ300-1')
    expect(mockSpawn).toHaveBeenCalledTimes(3)
  })

  it('issue() adds --noproxy * when no proxy configured', async () => {
    const client = new JiraClient({ ...creds, proxy: '' }, { spawn: makeSpawnMock({ httpStatus: 200, body: '{}' }) })
    await client.issue('DZ300-1')
    const args = (mockSpawn.mock.calls[0]?.[1] as string[] | undefined) ?? []
    const npIdx = args.indexOf('--noproxy')
    expect(npIdx).toBeGreaterThan(0)
    expect(args[npIdx + 1]).toBe('*')
  })

  it('issue() adds --proxy when settings.proxy is non-empty', async () => {
    const client = new JiraClient({ ...creds, proxy: 'http://127.0.0.1:8888' }, { spawn: makeSpawnMock({ httpStatus: 200, body: '{}' }) })
    await client.issue('DZ300-1')
    const args = (mockSpawn.mock.calls[0]?.[1] as string[] | undefined) ?? []
    const pIdx = args.indexOf('--proxy')
    expect(pIdx).toBeGreaterThan(0)
    expect(args[pIdx + 1]).toBe('http://127.0.0.1:8888')
    expect(args).not.toContain('--noproxy')
  })

  it('issue() prefers HTTPS_PROXY env over settings.proxy', async () => {
    const prev = process.env.HTTPS_PROXY
    process.env.HTTPS_PROXY = 'http://env-proxy:9999'
    try {
      const client = new JiraClient({ ...creds, proxy: 'http://settings-proxy:7777' }, { spawn: makeSpawnMock({ httpStatus: 200, body: '{}' }) })
      await client.issue('DZ300-1')
      const args = (mockSpawn.mock.calls[0]?.[1] as string[] | undefined) ?? []
      const pIdx = args.indexOf('--proxy')
      expect(pIdx).toBeGreaterThan(0)
      expect(args[pIdx + 1]).toBe('http://env-proxy:9999')
    } finally {
      if (prev === undefined) delete process.env.HTTPS_PROXY
      else process.env.HTTPS_PROXY = prev
    }
  })

  it('issue() never caches — repeat calls always hit Jira', async () => {
    const client = new JiraClient(creds, {
      spawn: makeSpawnMock({ httpStatus: 200, body: JSON.stringify({ key: 'DZ300-1', id: '100', fields: {} }) }),
    })
    await client.issue('DZ300-1')
    await client.issue('DZ300-1')
    await client.issue('DZ300-1')
    expect(mockSpawn).toHaveBeenCalledTimes(3)
  })

  it('worklogs() never caches — repeat calls always hit Jira', async () => {
    const page = { startAt: 0, maxResults: 1000, total: 0, worklogs: [] }
    const client = new JiraClient(creds, {
      spawn: makeSpawnMock({ httpStatus: 200, body: JSON.stringify(page) }),
    })
    await client.worklogs('DZ300-1')
    await client.worklogs('DZ300-1')
    await client.worklogs('DZ300-1')
    expect(mockSpawn).toHaveBeenCalledTimes(3)
  })

  it('issue() returns auth error on 401', async () => {
    const client = new JiraClient(creds, { spawn: makeSpawnMock({ httpStatus: 401, body: 'Unauthorized' }) })
    const r = await client.issue('DZ300-1')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('auth')
  })

  it('issue() returns network error when curl exits non-zero', async () => {
    const client = new JiraClient(creds, { spawn: makeSpawnMock({ curlExitCode: 6, stderr: 'Could not resolve host' }) })
    const r = await client.issue('DZ300-1')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('network')
  })

  it('issue() rejects invalid key format', async () => {
    const client = new JiraClient(creds, { spawn: makeSpawnMock({ httpStatus: 200, body: '{}' }) })
    const r = await client.issue('not-a-key')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('http')
  })

  it('worklogs() returns parsed page', async () => {
    const page = { startAt: 0, maxResults: 1000, total: 2, worklogs: [{ id: '1', author: { displayName: 'Ian' }, started: '2026-09-14T01:00:00.000+0800', timeSpentSeconds: 3600, comment: 'x' }] }
    const client = new JiraClient(creds, { spawn: makeSpawnMock({ httpStatus: 200, body: JSON.stringify(page) }) })
    const r = await client.worklogs('DZ300-1', { startAt: 0, maxResults: 1000 })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.body.worklogs).toHaveLength(1)
  })

  it('search() passes JQL correctly', async () => {
    const search = { startAt: 0, maxResults: 50, total: 0, issues: [] }
    const client = new JiraClient(creds, { spawn: makeSpawnMock({ httpStatus: 200, body: JSON.stringify(search) }) })
    await client.search({ jql: 'project = DZ300', maxResults: 50, fields: 'summary,status' })
    const args = (mockSpawn.mock.calls[0]?.[1] as string[] | undefined) ?? []
    const jqlArg = args.find(a => a.includes('project'))
    expect(jqlArg).toBeDefined()
  })

  it('returns parse error when response is not JSON', async () => {
    const client = new JiraClient(creds, { spawn: makeSpawnMock({ httpStatus: 200, body: 'not-json' }) })
    const r = await client.issue('DZ300-1')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('parse')
  })

  it('issue() passes AbortSignal through to spawn', async () => {
    const controller = new AbortController()
    // Configure the mock to verify the signal is passed through
    mockSpawn.mockImplementation(async (_cmd, _args, callOpts) => {
      expect(callOpts?.signal).toBe(controller.signal)
      return { status: 0, stdout: '{}\n200', stderr: '' }
    })
    const client = new JiraClient(creds, { spawn: mockSpawn })
    await client.issue('DZ300-1', controller.signal)
  })
})

// --- API version ------------------------------------------------------------

describe('apiUrl', () => {
  it('builds a /rest/api/<version> URL', () => {
    expect(apiUrl('https://jira.example.com', '/issue/DZ300-1'))
      .toBe(`https://jira.example.com/rest/api/${API_VERSION}/issue/DZ300-1`)
  })

  it('strips trailing slashes from the server', () => {
    expect(apiUrl('https://jira.example.com///', '/search'))
      .toBe(`https://jira.example.com/rest/api/${API_VERSION}/search`)
  })

  it('targets Jira Server API v2', () => {
    // Jira Server (not Cloud) is the deployment target; Cloud's v3 returns a
    // different description shape this client does not map.
    expect(API_VERSION).toBe('2')
  })
})

describe('JiraClient API version consistency', () => {
  beforeEach(() => {
    // This block sits outside the first describe, so it needs its own reset —
    // otherwise mock.calls keeps accumulating across these cases.
    mockSpawn.mockReset()
  })

  it('issue() requests the shared API version', async () => {
    const client = new JiraClient(creds, { spawn: makeSpawnMock({ httpStatus: 200, body: '{}' }) })
    await client.issue('DZ300-1')
    const args = (mockSpawn.mock.calls[0]?.[1] as string[] | undefined) ?? []
    const url = args[args.length - 1] ?? ''
    expect(url).toBe(`https://jiratest.example.com/rest/api/${API_VERSION}/issue/DZ300-1`)
  })

  it('worklogs() requests the shared API version', async () => {
    const client = new JiraClient(creds, { spawn: makeSpawnMock({ httpStatus: 200, body: '{}' }) })
    await client.worklogs('DZ300-1')
    const args = (mockSpawn.mock.calls[0]?.[1] as string[] | undefined) ?? []
    const url = args[args.length - 1] ?? ''
    expect(url).toContain(`/rest/api/${API_VERSION}/issue/DZ300-1/worklog`)
  })

  it('search() requests the shared API version', async () => {
    const client = new JiraClient(creds, { spawn: makeSpawnMock({ httpStatus: 200, body: '{}' }) })
    await client.search({ jql: 'x' })
    const args = (mockSpawn.mock.calls[0]?.[1] as string[] | undefined) ?? []
    const url = args[args.length - 1] ?? ''
    expect(url).toContain(`/rest/api/${API_VERSION}/search`)
  })

  it('search() sends startAt only when paging', async () => {
    const client = new JiraClient(creds, { spawn: makeSpawnMock({ httpStatus: 200, body: '{}' }) })

    await client.search({ jql: 'x' })
    let args = (mockSpawn.mock.calls[0]?.[1] as string[] | undefined) ?? []
    expect(args.join(' ')).not.toContain('startAt')

    await client.search({ jql: 'x', startAt: 100 })
    args = (mockSpawn.mock.calls[1]?.[1] as string[] | undefined) ?? []
    expect(args.join(' ')).toContain('startAt=100')
  })
})

// --- duration formatting ---------------------------------------------------

describe('formatDuration', () => {
  it('formats minutes', () => {
    expect(formatDuration(60)).toBe('1m')
  })

  it('formats hours and minutes', () => {
    expect(formatDuration(5400)).toBe('1h 30m')
  })

  it('formats hours alone', () => {
    expect(formatDuration(7200)).toBe('2h')
  })

  it('formats seconds when under a minute', () => {
    expect(formatDuration(45)).toBe('45s')
  })

  it('formats zero as 0m', () => {
    expect(formatDuration(0)).toBe('0m')
  })

  it('clamps negatives to zero', () => {
    expect(formatDuration(-100)).toBe('0m')
  })

  it('rounds fractional seconds', () => {
    expect(formatDuration(59.6)).toBe('1m')
  })

  it('combines all three units', () => {
    expect(formatDuration(3661)).toBe('1h 1m 1s')
  })
})

// --- worklog writes --------------------------------------------------------

describe('JiraClient worklog writes', () => {
  beforeEach(() => {
    mockSpawn.mockReset()
  })

  /** Pull the JSON body curl was told to send. */
  function sentBody(callIndex = 0): any {
    const args = (mockSpawn.mock.calls[callIndex]?.[1] as string[] | undefined) ?? []
    const idx = args.indexOf('--data-binary')
    expect(idx).toBeGreaterThan(-1)
    return JSON.parse(args[idx + 1] ?? '{}')
  }

  function sentMethod(callIndex = 0): string {
    const args = (mockSpawn.mock.calls[callIndex]?.[1] as string[] | undefined) ?? []
    const idx = args.indexOf('-X')
    return args[idx + 1] ?? ''
  }

  it('addWorklog() POSTs to the worklog endpoint with a Jira duration string', async () => {
    const created = { id: '102839', started: '2026-10-26T09:00:00.000+0800', timeSpent: '1h 30m', timeSpentSeconds: 5400 }
    const client = new JiraClient(creds, { spawn: makeSpawnMock({ httpStatus: 201, body: JSON.stringify(created) }) })

    const r = await client.addWorklog('DZ300-797', {
      seconds: 5400,
      comment: 'auto: turn 3',
      started: '2026-10-26T09:00:00.000+0800',
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.body.id).toBe('102839')

    expect(sentMethod()).toBe('POST')
    const args = (mockSpawn.mock.calls[0]?.[1] as string[] | undefined) ?? []
    expect(args[args.length - 1]).toBe(
      `https://jiratest.example.com/rest/api/${API_VERSION}/issue/DZ300-797/worklog`,
    )
    // The field Jira accepts is timeSpent, NOT timeSpentSeconds.
    const body = sentBody()
    expect(body.timeSpent).toBe('1h 30m')
    expect(body.timeSpentSeconds).toBeUndefined()
    expect(body.comment).toBe('auto: turn 3')
    expect(body.started).toBe('2026-10-26T09:00:00.000+0800')
  })

  it('addWorklog() omits an empty comment', async () => {
    const client = new JiraClient(creds, { spawn: makeSpawnMock({ httpStatus: 201, body: '{"id":"1"}' }) })
    await client.addWorklog('DZ300-797', { seconds: 60, comment: '' })
    expect(sentBody().comment).toBeUndefined()
  })

  it('addWorklog() rejects an invalid key before spawning', async () => {
    const client = new JiraClient(creds, { spawn: makeSpawnMock({ httpStatus: 201, body: '{}' }) })
    const r = await client.addWorklog('not-a-key', { seconds: 60 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('http')
    expect(mockSpawn).not.toHaveBeenCalled()
  })

  it('updateWorklog() PUTs the changed duration and start time', async () => {
    const updated = { id: '102839', started: '2026-10-26T14:30:00.000+0800', timeSpent: '1h 30m', timeSpentSeconds: 5400 }
    const client = new JiraClient(creds, { spawn: makeSpawnMock({ httpStatus: 200, body: JSON.stringify(updated) }) })

    const r = await client.updateWorklog('DZ300-797', '102839', {
      seconds: 5400,
      started: '2026-10-26T14:30:00.000+0800',
    })
    expect(r.ok).toBe(true)

    expect(sentMethod()).toBe('PUT')
    const args = (mockSpawn.mock.calls[0]?.[1] as string[] | undefined) ?? []
    expect(args[args.length - 1]).toBe(
      `https://jiratest.example.com/rest/api/${API_VERSION}/issue/DZ300-797/worklog/102839`,
    )
    const body = sentBody()
    expect(body.timeSpent).toBe('1h 30m')
    expect(body.started).toBe('2026-10-26T14:30:00.000+0800')
  })

  it('updateWorklog() sends only the fields that changed', async () => {
    const client = new JiraClient(creds, { spawn: makeSpawnMock({ httpStatus: 200, body: '{"id":"1"}' }) })
    await client.updateWorklog('DZ300-797', '102839', { seconds: 1800 })
    const body = sentBody()
    expect(body.timeSpent).toBe('30m')
    expect(body.started).toBeUndefined()
    expect(body.comment).toBeUndefined()
  })

  it('updateWorklog() rejects a non-numeric worklog id', async () => {
    const client = new JiraClient(creds, { spawn: makeSpawnMock({ httpStatus: 200, body: '{}' }) })
    const r = await client.updateWorklog('DZ300-797', 'abc', { seconds: 60 })
    expect(r.ok).toBe(false)
    expect(mockSpawn).not.toHaveBeenCalled()
  })

  it('updateWorklog() refuses an empty update', async () => {
    const client = new JiraClient(creds, { spawn: makeSpawnMock({ httpStatus: 200, body: '{}' }) })
    const r = await client.updateWorklog('DZ300-797', '102839', {})
    expect(r.ok).toBe(false)
    expect(mockSpawn).not.toHaveBeenCalled()
  })

  it('deleteWorklog() DELETEs and accepts an empty 204 body', async () => {
    const client = new JiraClient(creds, { spawn: makeSpawnMock({ httpStatus: 204, body: '' }) })
    const r = await client.deleteWorklog('DZ300-797', '102839')
    expect(r.ok).toBe(true)
    expect(sentMethod()).toBe('DELETE')
    const args = (mockSpawn.mock.calls[0]?.[1] as string[] | undefined) ?? []
    expect(args[args.length - 1]).toBe(
      `https://jiratest.example.com/rest/api/${API_VERSION}/issue/DZ300-797/worklog/102839`,
    )
  })

  it('deleteWorklog() rejects an invalid key', async () => {
    const client = new JiraClient(creds, { spawn: makeSpawnMock({ httpStatus: 204, body: '' }) })
    const r = await client.deleteWorklog('nope', '102839')
    expect(r.ok).toBe(false)
    expect(mockSpawn).not.toHaveBeenCalled()
  })

  it('addWorklog() surfaces an auth failure', async () => {
    const client = new JiraClient(creds, { spawn: makeSpawnMock({ httpStatus: 401, body: 'Unauthorized' }) })
    const r = await client.addWorklog('DZ300-797', { seconds: 60 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('auth')
  })

  it('addWorklog() sends a Content-Type header with the body', async () => {
    const client = new JiraClient(creds, { spawn: makeSpawnMock({ httpStatus: 201, body: '{"id":"1"}' }) })
    await client.addWorklog('DZ300-797', { seconds: 60 })
    const args = (mockSpawn.mock.calls[0]?.[1] as string[] | undefined) ?? []
    const idx = args.indexOf('Content-Type: application/json')
    expect(idx).toBeGreaterThan(-1)
    expect(args[idx - 1]).toBe('-H')
  })

  it('comments() returns the page on 200 JSON', async () => {
    const body = JSON.stringify({
      startAt: 0,
      maxResults: 50,
      total: 1,
      comments: [{ id: '10', author: { displayName: 'Ian Yin' }, created: '2026-10-26T09:00:00.000+0800', updated: '2026-10-26T09:00:00.000+0800', body: 'hello' }],
    })
    const client = new JiraClient(creds, { spawn: makeSpawnMock({ httpStatus: 200, body }) })
    const r = await client.comments('DZ300-797')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.body.comments[0]?.body).toBe('hello')
  })

  it('comments() requests the issue comment endpoint', async () => {
    const client = new JiraClient(creds, { spawn: makeSpawnMock({ httpStatus: 200, body: '{}' }) })
    await client.comments('DZ300-797')
    const args = (mockSpawn.mock.calls[0]?.[1] as string[] | undefined) ?? []
    const url = args[args.length - 1] ?? ''
    expect(url).toContain(`/rest/api/${API_VERSION}/issue/DZ300-797/comment`)
  })

  it('comments() rejects an invalid key without calling Jira', async () => {
    const client = new JiraClient(creds, { spawn: makeSpawnMock({ httpStatus: 200, body: '{}' }) })
    const r = await client.comments('nope')
    expect(r.ok).toBe(false)
    expect(mockSpawn).not.toHaveBeenCalled()
  })

  it('addComment() POSTs the comment body', async () => {
    const client = new JiraClient(creds, { spawn: makeSpawnMock({ httpStatus: 201, body: '{"id":"10","body":"done"}' }) })
    const r = await client.addComment('DZ300-797', 'done')
    expect(r.ok).toBe(true)
    const args = (mockSpawn.mock.calls[0]?.[1] as string[] | undefined) ?? []
    expect(args).toContain('POST')
    const url = args[args.length - 1] ?? ''
    expect(url).toContain(`/rest/api/${API_VERSION}/issue/DZ300-797/comment`)
    const payload = args[args.indexOf('--data-binary') + 1] ?? ''
    expect(JSON.parse(payload)).toEqual({ body: 'done' })
  })

  it('addComment() rejects an empty body without calling Jira', async () => {
    const client = new JiraClient(creds, { spawn: makeSpawnMock({ httpStatus: 201, body: '{}' }) })
    const r = await client.addComment('DZ300-797', '   ')
    expect(r.ok).toBe(false)
    expect(mockSpawn).not.toHaveBeenCalled()
  })

  it('addComment() surfaces an auth failure', async () => {
    const client = new JiraClient(creds, { spawn: makeSpawnMock({ httpStatus: 401, body: 'Unauthorized' }) })
    const r = await client.addComment('DZ300-797', 'done')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('auth')
  })
})

// Helper: returns the mockSpawn fn, configured to resolve to a fake curl result.
// stdout format must mirror curl `-w '\n%{http_code}'`: body then `\n${status}`
function makeSpawnMock(opts: { httpStatus?: number; body?: string; curlExitCode?: number; stderr?: string }) {
  const httpStatus = opts.httpStatus ?? 200
  const body = opts.body ?? ''
  const curlExitCode = opts.curlExitCode ?? 0
  mockSpawn.mockResolvedValue({
    status: curlExitCode,
    stdout: curlExitCode === 0 ? `${body}\n${httpStatus}` : '',
    stderr: opts.stderr ?? '',
  })
  return mockSpawn
}