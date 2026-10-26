import { describe, it, expect } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  handleListMyOpen,
  handleListWorklogWeek,
  handleGetBinding,
  handleBind,
  searchAllIssues,
  SEARCH_PAGE_SIZE,
} from '../src/handlers.js'
import type { ScjiraSettings } from '../src/types.js'

const creds: ScjiraSettings = {
  server: 'https://jiratest.example.com',
  login: 'A003688',
  token: 'fake',
  displayName: 'Ian Yin',
}

function makeFakeJiraClient(impl: Partial<{
  issue: any
  worklogs: any
  search: any
}> = {}) {
  return {
    issue: impl.issue ?? (async () => ({ ok: false, error: 'http' })),
    worklogs: impl.worklogs ?? (async () => ({ ok: false, error: 'http' })),
    search: impl.search ?? (async () => ({ ok: false, error: 'http' })),
  } as any
}

describe('handleListMyOpen', () => {
  it('returns empty list when Jira returns no issues', async () => {
    const jira = makeFakeJiraClient({
      search: async () => ({ ok: true, body: { startAt: 0, maxResults: 50, total: 0, issues: [] } }),
    })
    const r = await handleListMyOpen({ jira, creds })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.issues).toEqual([])
      expect(r.totalSpentSeconds).toBe(0)
    }
  })

  it('returns summarized issues from search results', async () => {
    const jira = makeFakeJiraClient({
      search: async () => ({
        ok: true,
        body: {
          startAt: 0, maxResults: 50, total: 1,
          issues: [{
            key: 'DZ300-1', id: '100',
            fields: {
              summary: 'Hello', description: 'world',
              status: { name: 'Open' }, priority: { name: 'High' },
              assignee: { displayName: 'Ian Yin' }, reporter: { displayName: 'PM' },
              duedate: '2026-09-30', created: '2026-09-01T00:00:00.000Z',
              updated: '2026-09-10T00:00:00.000Z', resolution: null,
              // FIX bug #1: use individual time fields, not timetracking
              timespent: 3600, timeoriginalestimate: 7200, timeestimate: 3600,
            },
          }],
        },
      }),
    })
    const r = await handleListMyOpen({ jira, creds })
    expect(r.ok).toBe(true)
    if (r.ok && r.issues[0]) {
      expect(r.issues[0].key).toBe('DZ300-1')
      expect(r.issues[0].statusName).toBe('Open')
      expect(r.issues[0].timeSpentSeconds).toBe(3600)
      expect(r.issues[0].originalEstimateSeconds).toBe(7200)
    }
  })

  it('returns network error message when Jira returns network error', async () => {
    const jira = makeFakeJiraClient({ search: async () => ({ ok: false, error: 'network' }) })
    const r = await handleListMyOpen({ jira, creds })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('Jira unavailable (network)')
  })
})

describe('handleListWorklogWeek', () => {
  // FIX bug #3: use a date that IS Monday (2026-09-14 is Tuesday; 2026-09-07 is Monday).
  // The week of 2026-09-07 is Mon Sept 7 through Sun Sept 13.
  it('aggregates by day, filtering non-matching authors', async () => {
    const jira = makeFakeJiraClient({
      search: async () => ({
        ok: true,
        body: { issues: [{ key: 'DZ300-1', id: '1', fields: { summary: 'Task' } }] },
      }),
      worklogs: async () => ({
        ok: true,
        body: {
          startAt: 0, maxResults: 1000, total: 3,
          worklogs: [
            // Tuesday 2026-09-08 09:00 +0800 (UTC 01:00) → date '2026-09-08'
            { id: '1', author: { displayName: 'Ian Yin' }, started: '2026-09-08T09:00:00.000+0800', timeSpentSeconds: 3600, comment: 'mine' },
            // Same day, other author → must be filtered out
            { id: '2', author: { displayName: 'Joy Yu' }, started: '2026-09-08T10:00:00.000+0800', timeSpentSeconds: 1800, comment: 'other' },
            // Wednesday 2026-09-09 11:00 +0800 → date '2026-09-09'
            { id: '3', author: { displayName: 'Ian Yin' }, started: '2026-09-09T11:00:00.000+0800', timeSpentSeconds: 1800, comment: 'mine2' },
          ],
        },
      }),
    })
    const r = await handleListWorklogWeek({ jira, creds }, { startDate: '2026-09-07' })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.grandTotalSeconds).toBe(5400)
      expect(r.weekStart).toBe('2026-09-07')
      expect(r.weekEnd).toBe('2026-09-14')
      // Only days with entries should have non-zero entries; all 7 days present in dailyTotals
      expect(Object.keys(r.dailyTotals ?? {}).sort()).toEqual([
        '2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11', '2026-09-12', '2026-09-13',
      ])
      expect(r.dailyTotals?.['2026-09-08']?.seconds).toBe(3600)
      expect(r.dailyTotals?.['2026-09-09']?.seconds).toBe(1800)
      expect(r.dailyTotals?.['2026-09-13']?.seconds).toBe(0)
    }
  })

  it('paginates worklogs fully (no silent truncation)', async () => {
    let callCount = 0
    const jira = makeFakeJiraClient({
      search: async () => ({ ok: true, body: { issues: [{ key: 'DZ300-1', id: '1', fields: { summary: 'X' } }] } }),
      worklogs: async (key: string, opts: any) => {
        callCount++
        const offset = opts?.startAt ?? 0
        if (offset === 0) {
          return {
            ok: true,
            body: {
              startAt: 0, maxResults: 1000, total: 1500,
              worklogs: Array.from({ length: 1000 }, (_, i) => ({
                id: `w${i}`, author: { displayName: 'Ian Yin' },
                // Tuesday 2026-09-08 in UTC → date '2026-09-08'
                started: '2026-09-08T00:00:00.000Z', timeSpentSeconds: 60, comment: '',
              })),
            },
          }
        }
        return {
          ok: true,
          body: {
            startAt: 1000, maxResults: 1000, total: 1500,
            worklogs: Array.from({ length: 500 }, (_, i) => ({
              id: `w${1000 + i}`, author: { displayName: 'Ian Yin' },
              started: '2026-09-08T00:00:00.000Z', timeSpentSeconds: 60, comment: '',
            })),
          },
        }
      },
    })
    const r = await handleListWorklogWeek({ jira, creds }, { startDate: '2026-09-07' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.grandTotalSeconds).toBe(1500 * 60)
    expect(callCount).toBeGreaterThanOrEqual(2)
  })
})

describe('handleBind', () => {
  it('writes meta.json when key is new', async () => {
    const tasksDir = await mkdtemp(join(tmpdir(), 'scjira-bind-'))
    const jira = makeFakeJiraClient({
      issue: async () => ({
        ok: true,
        body: { key: 'DZ300-99', id: '99', fields: { summary: 'New task', status: { name: 'Open' } } },
      }),
    })
    const r = await handleBind({ jira, creds, tasksDir }, { sessionId: 's1', taskKey: 'DZ300-99' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.key).toBe('DZ300-99')
    await rm(tasksDir, { recursive: true, force: true })
  })

  it('rejects malformed key with English error containing "format"', async () => {
    // FIX bug #2: handler error must be English so the /format/ regex matches
    const jira = makeFakeJiraClient()
    const r = await handleBind({ jira, creds, tasksDir: '/tmp/x' }, { sessionId: 's', taskKey: 'not-a-key' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/format/)
  })

  it('rejects when Jira does not know the key', async () => {
    const jira = makeFakeJiraClient({ issue: async () => ({ ok: false, error: 'http', detail: '404' }) })
    const r = await handleBind({ jira, creds, tasksDir: '/tmp/x' }, { sessionId: 's', taskKey: 'DZ300-404' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/Jira rejected/)
  })
})

describe('handleGetBinding', () => {
  it('returns bound=false when nothing stored', async () => {
    const tasksDir = await mkdtemp(join(tmpdir(), 'scjira-get-'))
    const r = await handleGetBinding({ tasksDir }, { sessionId: 'nope' })
    expect(r.bound).toBe(false)
    await rm(tasksDir, { recursive: true, force: true })
  })

  it('returns bound=true when matching sessionId found', async () => {
    const tasksDir = await mkdtemp(join(tmpdir(), 'scjira-get-'))
    await mkdir(join(tasksDir, 'DZ300-1'), { recursive: true })
    await writeFile(join(tasksDir, 'DZ300-1/meta.json'), JSON.stringify({
      schemaVersion: 3, key: 'DZ300-1', status: 'active', startedAt: 'x', endedAt: null,
      dshSessionId: 's-found', issueSummary: { summary: 'Bound', statusName: 'Open', priority: '', duedate: '', url: '' },
      logCount: 0, logBytes: 0, summaryCount: 0,
    }))
    const r = await handleGetBinding({ tasksDir }, { sessionId: 's-found' })
    expect(r.bound).toBe(true)
    if (r.bound) expect(r.key).toBe('DZ300-1')
    await rm(tasksDir, { recursive: true, force: true })
  })
})

// --- searchAllIssues (pagination) ------------------------------------------

describe('searchAllIssues', () => {
  it('stops after a single page when the total fits', async () => {
    let callCount = 0
    const jira = {
      search: async () => {
        callCount++
        return {
          ok: true,
          body: {
            startAt: 0, maxResults: 100, total: 3,
            issues: [
              { key: 'DZ300-1', id: '1', fields: {} },
              { key: 'DZ300-2', id: '2', fields: {} },
              { key: 'DZ300-3', id: '3', fields: {} },
            ],
          },
        }
      },
    }
    const r = await searchAllIssues(jira, { jql: 'x' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.body).toHaveLength(3)
    expect(callCount).toBe(1)
  })

  it('follows every page until the reported total is reached', async () => {
    const seenStartAt: Array<number | undefined> = []
    const jira = {
      search: async (opts: { startAt?: number }) => {
        seenStartAt.push(opts.startAt)
        const offset = opts.startAt ?? 0
        const total = 250
        const size = Math.min(SEARCH_PAGE_SIZE, total - offset)
        return {
          ok: true,
          body: {
            startAt: offset, maxResults: SEARCH_PAGE_SIZE, total,
            issues: Array.from({ length: size }, (_, i) => ({
              key: `DZ300-${offset + i}`, id: String(offset + i), fields: {},
            })),
          },
        }
      },
    }
    const r = await searchAllIssues(jira, { jql: 'x' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.body).toHaveLength(250)
    // 3 pages: 100 + 100 + 50
    expect(seenStartAt).toEqual([0, 100, 200])
  })

  it('stops on an empty page even when the total claims more', async () => {
    let callCount = 0
    const jira = {
      search: async () => {
        callCount++
        return { ok: true, body: { startAt: 0, maxResults: 100, total: 999, issues: [] } }
      },
    }
    const r = await searchAllIssues(jira, { jql: 'x' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.body).toHaveLength(0)
    expect(callCount).toBe(1)
  })

  it('surfaces the error when the first page fails', async () => {
    const jira = { search: async () => ({ ok: false, error: 'network' }) }
    const r = await searchAllIssues(jira, { jql: 'x' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('network')
  })

  it('keeps the pages already gathered when a later page fails', async () => {
    let callCount = 0
    const jira = {
      search: async () => {
        callCount++
        if (callCount === 1) {
          return {
            ok: true,
            body: {
              startAt: 0, maxResults: 100, total: 200,
              issues: [{ key: 'DZ300-1', id: '1', fields: {} }],
            },
          }
        }
        return { ok: false, error: 'network' }
      },
    }
    const r = await searchAllIssues(jira, { jql: 'x' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.body).toHaveLength(1)
  })
})

// --- listMyOpen pagination -------------------------------------------------

describe('handleListMyOpen pagination', () => {
  it('returns issues beyond the first page (no silent truncation)', async () => {
    let callCount = 0
    const jira = makeFakeJiraClient({
      search: async (opts: any) => {
        callCount++
        const offset = opts?.startAt ?? 0
        const total = 150
        const size = Math.min(SEARCH_PAGE_SIZE, total - offset)
        return {
          ok: true,
          body: {
            startAt: offset, maxResults: SEARCH_PAGE_SIZE, total,
            issues: Array.from({ length: size }, (_, i) => ({
              key: `DZ300-${offset + i}`, id: String(offset + i),
              fields: { summary: `Issue ${offset + i}`, timespent: 60 },
            })),
          },
        }
      },
    })
    const r = await handleListMyOpen({ jira, creds })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.issues).toHaveLength(150)
      expect(r.totalSpentSeconds).toBe(150 * 60)
    }
    expect(callCount).toBe(2)
  })
})

