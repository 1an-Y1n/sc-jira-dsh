import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  handleEditWorklog,
  handleListWorklogs,
  handleRepullWorklogs,
  handleUploadWorklogs,
} from '../src/worklog-handlers.js'
import { appendWorklog, readLedger } from '../src/worklog-ledger.js'
import type { ScjiraSettings } from '../src/types.js'
import type { JiraClient } from '../src/jira-client.js'

let tasksDir: string
const KEY = 'DZ300-1'
const T0 = '2026-10-26T09:00:00.000+0800'
const NOW = '2026-10-26T10:00:00.000+0800'

const creds: ScjiraSettings = {
  server: 'https://jiratest.example.com',
  login: 'A003688',
  token: 'fake',
  displayName: 'Ian Yin',
  proxy: '',
}

beforeEach(async () => {
  tasksDir = await mkdtemp(join(tmpdir(), 'scjira-wlhandlers-'))
})

afterEach(async () => {
  await rm(tasksDir, { recursive: true, force: true })
})

/** A fake Jira client that records what it was asked to do. */
function makeJira(over: {
  addWorklog?: (key: string, opts: { seconds: number; comment?: string; started?: string }) => Promise<any>
  updateWorklog?: (key: string, id: string, opts: any) => Promise<any>
  worklogs?: (key: string, opts: any) => Promise<any>
} = {}) {
  const calls: { add: any[]; update: any[]; worklogs: any[] } = { add: [], update: [], worklogs: [] }
  const client = {
    async addWorklog(key: string, opts: any) {
      calls.add.push({ key, opts })
      if (over.addWorklog) return over.addWorklog(key, opts)
      return { ok: true, body: { id: `jira-${calls.add.length}`, timeSpentSeconds: opts.seconds } }
    },
    async updateWorklog(key: string, id: string, opts: any) {
      calls.update.push({ key, id, opts })
      if (over.updateWorklog) return over.updateWorklog(key, id, opts)
      return { ok: true, body: { id } }
    },
    async worklogs(key: string, opts: any) {
      calls.worklogs.push({ key, opts })
      if (over.worklogs) return over.worklogs(key, opts)
      return { ok: true, body: { startAt: 0, maxResults: 1000, total: 0, worklogs: [] } }
    },
  }
  return { client: client as unknown as JiraClient, calls }
}

describe('handleListWorklogs', () => {
  it('reports an empty ledger', async () => {
    const { client } = makeJira()
    const r = await handleListWorklogs({ jira: client, creds, tasksDir }, { key: KEY })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.ledger.entries).toEqual([])
      expect(r.ledger.totalSeconds).toBe(0)
      expect(r.ledger.draftCount).toBe(0)
    }
  })

  it('lists the entries with a human-readable duration', async () => {
    const { client } = makeJira()
    await appendWorklog(tasksDir, KEY, { turn: 3, seconds: 5400, comment: 'x', startedAt: T0, createdAt: NOW })
    const r = await handleListWorklogs({ jira: client, creds, tasksDir }, { key: KEY })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.ledger.entries).toHaveLength(1)
      expect(r.ledger.entries[0]?.duration).toBe('1h 30m')
      expect(r.ledger.entries[0]?.turn).toBe(3)
      expect(r.ledger.totalDuration).toBe('1h 30m')
      expect(r.ledger.draftCount).toBe(1)
    }
  })
})

describe('handleEditWorklog', () => {
  it('changes a draft entry locally', async () => {
    const { client, calls } = makeJira()
    const e = await appendWorklog(tasksDir, KEY, { seconds: 1800, startedAt: T0, createdAt: NOW })
    const r = await handleEditWorklog({ jira: client, creds, tasksDir }, {
      key: KEY, id: e.id, edit: { seconds: 3600 },
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.entry.seconds).toBe(3600)
    // A draft entry never reaches Jira.
    expect(calls.update).toHaveLength(0)
  })

  it('pushes the change to Jira for a synced entry', async () => {
    const { client, calls } = makeJira()
    const e = await appendWorklog(tasksDir, KEY, { seconds: 1800, startedAt: T0, createdAt: NOW })
    // Pretend it was uploaded.
    await appendWorklog(tasksDir, KEY, { seconds: 60, startedAt: T0, createdAt: NOW })
    const entries = await readLedger(tasksDir, KEY)
    expect(entries).toHaveLength(2)

    // Mark the first as synced through the upload path so jiraId is set.
    const { client: c2 } = makeJira()
    const up = await handleUploadWorklogs({ jira: c2, creds, tasksDir }, { key: KEY, ids: [entries[0]!.id] })
    expect(up.ok).toBe(true)
    const synced = (await readLedger(tasksDir, KEY)).find(x => x.id === entries[0]!.id)
    expect(synced?.state).toBe('synced')

    const r = await handleEditWorklog({ jira: client, creds, tasksDir }, {
      key: KEY, id: entries[0]!.id, edit: { seconds: 7200 },
    })
    expect(r.ok).toBe(true)
    expect(calls.update).toHaveLength(1)
    expect(calls.update[0]?.opts.seconds).toBe(7200)
    expect(calls.update[0]?.opts.started).toBe(T0)
  })

  it('reports a missing entry', async () => {
    const { client } = makeJira()
    const r = await handleEditWorklog({ jira: client, creds, tasksDir }, {
      key: KEY, id: 'wl-99', edit: { seconds: 60 },
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('wl-99')
  })

  it('reports a Jira rejection for a synced entry', async () => {
    const { client } = makeJira({
      updateWorklog: async () => ({ ok: false, error: 'http', detail: 'status 400' }),
    })
    const e = await appendWorklog(tasksDir, KEY, { seconds: 1800, startedAt: T0, createdAt: NOW })
    await handleUploadWorklogs({ jira: makeJira().client, creds, tasksDir }, { key: KEY, ids: [e.id] })
    const r = await handleEditWorklog({ jira: client, creds, tasksDir }, {
      key: KEY, id: e.id, edit: { seconds: 7200 },
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('Jira rejected')
  })
})

describe('handleUploadWorklogs', () => {
  it('uploads nothing when no entry is selected', async () => {
    const { client, calls } = makeJira()
    await appendWorklog(tasksDir, KEY, { seconds: 1800, startedAt: T0, createdAt: NOW })
    const r = await handleUploadWorklogs({ jira: client, creds, tasksDir }, { key: KEY, ids: [] })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.uploaded).toHaveLength(0)
    expect(calls.add).toHaveLength(0)
  })

  it('uploads only the selected entries', async () => {
    const { client, calls } = makeJira()
    const a = await appendWorklog(tasksDir, KEY, { seconds: 1800, startedAt: T0, createdAt: NOW })
    const b = await appendWorklog(tasksDir, KEY, { seconds: 3600, startedAt: T0, createdAt: NOW })
    const r = await handleUploadWorklogs({ jira: client, creds, tasksDir }, { key: KEY, ids: [a.id] })
    expect(r.ok).toBe(true)
    expect(calls.add).toHaveLength(1)
    expect(calls.add[0]?.opts.seconds).toBe(1800)
    // The unselected entry stays a draft.
    const entries = await readLedger(tasksDir, KEY)
    expect(entries.find(e => e.id === b.id)?.state).toBe('draft')
    expect(entries.find(e => e.id === a.id)?.state).toBe('synced')
  })

  it('records the Jira id on a synced entry', async () => {
    const { client } = makeJira()
    const a = await appendWorklog(tasksDir, KEY, { seconds: 1800, startedAt: T0, createdAt: NOW })
    await handleUploadWorklogs({ jira: client, creds, tasksDir }, { key: KEY, ids: [a.id] })
    const entry = (await readLedger(tasksDir, KEY))[0]
    expect(entry?.state).toBe('synced')
    expect(entry?.jiraId).toBe('jira-1')
    expect(entry?.syncedAt).not.toBeNull()
  })

  it('marks a rejected entry as failed and keeps the error', async () => {
    const { client } = makeJira({
      addWorklog: async () => ({ ok: false, error: 'auth' }),
    })
    const a = await appendWorklog(tasksDir, KEY, { seconds: 1800, startedAt: T0, createdAt: NOW })
    const r = await handleUploadWorklogs({ jira: client, creds, tasksDir }, { key: KEY, ids: [a.id] })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.uploaded[0]?.ok).toBe(false)
      expect(r.uploaded[0]?.error).toContain('Jira rejected')
    }
    const entry = (await readLedger(tasksDir, KEY))[0]
    expect(entry?.state).toBe('failed')
    expect(entry?.error).toContain('Jira rejected')
  })

  it('skips an entry that is already synced', async () => {
    const { client, calls } = makeJira()
    const a = await appendWorklog(tasksDir, KEY, { seconds: 1800, startedAt: T0, createdAt: NOW })
    await handleUploadWorklogs({ jira: client, creds, tasksDir }, { key: KEY, ids: [a.id] })
    calls.add.length = 0
    const r = await handleUploadWorklogs({ jira: client, creds, tasksDir }, { key: KEY, ids: [a.id] })
    expect(calls.add).toHaveLength(0)
    if (r.ok) expect(r.syncedCount).toBe(1)
  })
})

describe('handleRepullWorklogs', () => {
  it('adds a Jira worklog the ledger does not know about', async () => {
    const { client } = makeJira({
      worklogs: async () => ({
        ok: true,
        body: {
          startAt: 0, maxResults: 1000, total: 1,
          worklogs: [{
            id: '102839', started: '2026-10-26T09:00:00.000+0800',
            timeSpentSeconds: 3600, comment: 'made in Jira',
          }],
        },
      }),
    })
    const r = await handleRepullWorklogs({ jira: client, creds, tasksDir }, { key: KEY })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.added).toBe(1)
      expect(r.ledger.entries).toHaveLength(1)
      expect(r.ledger.entries[0]?.state).toBe('synced')
      expect(r.ledger.entries[0]?.jiraId).toBe('102839')
      expect(r.ledger.entries[0]?.comment).toBe('made in Jira')
    }
  })

  it('refreshes a synced entry whose duration changed in Jira', async () => {
    const { client } = makeJira()
    const a = await appendWorklog(tasksDir, KEY, { seconds: 1800, comment: 'old', startedAt: T0, createdAt: NOW })
    await handleUploadWorklogs({ jira: client, creds, tasksDir }, { key: KEY, ids: [a.id] })
    const jiraId = (await readLedger(tasksDir, KEY))[0]?.jiraId

    const { client: c2 } = makeJira({
      worklogs: async () => ({
        ok: true,
        body: {
          startAt: 0, maxResults: 1000, total: 1,
          worklogs: [{
            id: jiraId, started: T0, timeSpentSeconds: 5400, comment: 'new comment',
          }],
        },
      }),
    })
    const r = await handleRepullWorklogs({ jira: c2, creds, tasksDir }, { key: KEY })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.updated).toBe(1)
      expect(r.added).toBe(0)
      const entry = r.ledger.entries[0]
      expect(entry?.seconds).toBe(5400)
      expect(entry?.comment).toBe('new comment')
    }
  })

  it('reports a Jira failure', async () => {
    const { client } = makeJira({
      worklogs: async () => ({ ok: false, error: 'network' }),
    })
    const r = await handleRepullWorklogs({ jira: client, creds, tasksDir }, { key: KEY })
    expect(r.ok).toBe(false)
  })
})
