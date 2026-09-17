import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockSpawn = vi.fn()

import { JiraClient } from '../src/jira-client.js'

const creds = {
  server: 'https://jiratest.example.com',
  login: 'A003688',
  token: 'fake-token',
  displayName: 'Ian Yin',
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

  it('issue() sends Basic auth header on every request', async () => {
    const client = new JiraClient(creds, { spawn: makeSpawnMock({ httpStatus: 200, body: '{}' }) })
    await client.issue('DZ300-1')
    expect(mockSpawn).toHaveBeenCalledWith(
      'curl',
      expect.arrayContaining([
        expect.stringMatching(/^-H$/),
        expect.stringMatching(/^Authorization: Basic /),
      ]),
    )
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