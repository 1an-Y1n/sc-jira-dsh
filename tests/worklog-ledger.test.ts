import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendWorklog,
  readLedger,
  editWorklog,
  markSynced,
  markFailed,
  parseLedger,
  summarizeLedger,
  ledgerPath,
  LEDGER_FILE,
} from '../src/worklog-ledger.js'

let tasksDir: string
const KEY = 'DZ300-1'

beforeEach(async () => {
  tasksDir = await mkdtemp(join(tmpdir(), 'scjira-ledger-'))
})

afterEach(async () => {
  await rm(tasksDir, { recursive: true, force: true })
})

const T0 = '2026-10-26T09:00:00.000+0800'
const NOW = '2026-10-26T10:00:00.000+0800'

describe('parseLedger', () => {
  it('reads well-formed lines', () => {
    const entries = parseLedger(
      '{"id":"wl-01","turn":3,"seconds":1800,"comment":"x","startedAt":"2026-10-26T09:00:00.000+0800","state":"draft"}\n',
    )
    expect(entries).toHaveLength(1)
    expect(entries[0]?.id).toBe('wl-01')
    expect(entries[0]?.seconds).toBe(1800)
    expect(entries[0]?.state).toBe('draft')
  })

  it('skips a malformed line without failing the whole file', () => {
    const entries = parseLedger(
      '{"id":"wl-01","seconds":60}\n' +
      'not json at all\n' +
      '{"id":"wl-02","seconds":120}\n',
    )
    expect(entries.map(e => e.id)).toEqual(['wl-01', 'wl-02'])
  })

  it('skips a line missing required fields', () => {
    const entries = parseLedger('{"turn":1}\n{"id":"wl-02","seconds":120}\n')
    expect(entries.map(e => e.id)).toEqual(['wl-02'])
  })

  it('ignores blank lines', () => {
    expect(parseLedger('\n\n   \n')).toEqual([])
  })

  it('defaults an unknown state to draft', () => {
    const entries = parseLedger('{"id":"wl-01","seconds":60,"state":"weird"}\n')
    expect(entries[0]?.state).toBe('draft')
  })
})

describe('ledger files', () => {
  it('a missing ledger reads as empty', async () => {
    expect(await readLedger(tasksDir, KEY)).toEqual([])
  })

  it('appendWorklog creates the ledger file', async () => {
    await appendWorklog(tasksDir, KEY, { seconds: 1800, startedAt: T0, createdAt: NOW })
    const raw = await readFile(ledgerPath(tasksDir, KEY), 'utf8')
    expect(raw).toContain('"id":"wl-01"')
    expect(raw.trimEnd().split('\n')).toHaveLength(1)
  })

  it('the ledger file is named worklog.jsonl inside the task directory', async () => {
    expect(ledgerPath(tasksDir, KEY)).toBe(join(tasksDir, KEY, LEDGER_FILE))
  })
})

describe('appendWorklog', () => {
  it('assigns increasing ids', async () => {
    const a = await appendWorklog(tasksDir, KEY, { seconds: 60, startedAt: T0, createdAt: NOW })
    const b = await appendWorklog(tasksDir, KEY, { seconds: 60, startedAt: T0, createdAt: NOW })
    const c = await appendWorklog(tasksDir, KEY, { seconds: 60, startedAt: T0, createdAt: NOW })
    expect(a.id).toBe('wl-01')
    expect(b.id).toBe('wl-02')
    expect(c.id).toBe('wl-03')
  })

  it('records the entry as a draft with no jira id', async () => {
    const e = await appendWorklog(tasksDir, KEY, { seconds: 1800, startedAt: T0, createdAt: NOW })
    expect(e.state).toBe('draft')
    expect(e.jiraId).toBeNull()
    expect(e.syncedAt).toBeNull()
  })

  it('keeps the turn and step it came from', async () => {
    const e = await appendWorklog(tasksDir, KEY, { turn: 3, step: 2, seconds: 60, startedAt: T0, createdAt: NOW })
    expect(e.turn).toBe(3)
    expect(e.step).toBe(2)
  })

  it('defaults turn and step to null', async () => {
    const e = await appendWorklog(tasksDir, KEY, { seconds: 60, startedAt: T0, createdAt: NOW })
    expect(e.turn).toBeNull()
    expect(e.step).toBeNull()
  })

  it('clamps a negative duration to zero', async () => {
    const e = await appendWorklog(tasksDir, KEY, { seconds: -100, startedAt: T0, createdAt: NOW })
    expect(e.seconds).toBe(0)
  })

  it('appends rather than rewriting, so earlier entries survive', async () => {
    await appendWorklog(tasksDir, KEY, { turn: 1, seconds: 60, startedAt: T0, createdAt: NOW })
    await appendWorklog(tasksDir, KEY, { turn: 2, seconds: 120, startedAt: T0, createdAt: NOW })
    const entries = await readLedger(tasksDir, KEY)
    expect(entries).toHaveLength(2)
    expect(entries[0]?.turn).toBe(1)
    expect(entries[1]?.turn).toBe(2)
  })
})

describe('editWorklog', () => {
  it('changes the duration', async () => {
    const e = await appendWorklog(tasksDir, KEY, { seconds: 1800, startedAt: T0, createdAt: NOW })
    const updated = await editWorklog(tasksDir, KEY, e.id, { seconds: 5400 })
    expect(updated?.seconds).toBe(5400)
    const reread = await readLedger(tasksDir, KEY)
    expect(reread[0]?.seconds).toBe(5400)
  })

  it('changes the comment and the start time', async () => {
    const e = await appendWorklog(tasksDir, KEY, { seconds: 60, startedAt: T0, createdAt: NOW })
    const updated = await editWorklog(tasksDir, KEY, e.id, {
      comment: 'edited',
      startedAt: '2026-10-26T14:30:00.000+0800',
    })
    expect(updated?.comment).toBe('edited')
    expect(updated?.startedAt).toBe('2026-10-26T14:30:00.000+0800')
    // The duration is untouched.
    expect(updated?.seconds).toBe(60)
  })

  it('leaves other fields alone', async () => {
    const e = await appendWorklog(tasksDir, KEY, { turn: 5, seconds: 60, startedAt: T0, createdAt: NOW })
    const updated = await editWorklog(tasksDir, KEY, e.id, { seconds: 120 })
    expect(updated?.turn).toBe(5)
    expect(updated?.createdAt).toBe(NOW)
  })

  it('returns null for an unknown id', async () => {
    await appendWorklog(tasksDir, KEY, { seconds: 60, startedAt: T0, createdAt: NOW })
    expect(await editWorklog(tasksDir, KEY, 'wl-99', { seconds: 60 })).toBeNull()
  })

  it('preserves the other entries', async () => {
    const a = await appendWorklog(tasksDir, KEY, { seconds: 60, startedAt: T0, createdAt: NOW })
    await appendWorklog(tasksDir, KEY, { seconds: 120, startedAt: T0, createdAt: NOW })
    await editWorklog(tasksDir, KEY, a.id, { seconds: 999 })
    const entries = await readLedger(tasksDir, KEY)
    expect(entries).toHaveLength(2)
    expect(entries.find(e => e.id === a.id)?.seconds).toBe(999)
    expect(entries.find(e => e.id !== a.id)?.seconds).toBe(120)
  })
})

describe('sync state', () => {
  it('markSynced records the jira id', async () => {
    const e = await appendWorklog(tasksDir, KEY, { seconds: 60, startedAt: T0, createdAt: NOW })
    const synced = await markSynced(tasksDir, KEY, e.id, '102839', NOW)
    expect(synced?.state).toBe('synced')
    expect(synced?.jiraId).toBe('102839')
    expect(synced?.syncedAt).toBe(NOW)
  })

  it('markFailed records the error and keeps it for a retry', async () => {
    const e = await appendWorklog(tasksDir, KEY, { seconds: 60, startedAt: T0, createdAt: NOW })
    const failed = await markFailed(tasksDir, KEY, e.id, 'HTTP 500')
    expect(failed?.state).toBe('failed')
    expect(failed?.error).toBe('HTTP 500')
    // Still local — no jira id was assigned.
    expect(failed?.jiraId).toBeNull()
  })

  it('a failed entry can be synced later, clearing the error', async () => {
    const e = await appendWorklog(tasksDir, KEY, { seconds: 60, startedAt: T0, createdAt: NOW })
    await markFailed(tasksDir, KEY, e.id, 'HTTP 500')
    const synced = await markSynced(tasksDir, KEY, e.id, '102839', NOW)
    expect(synced?.state).toBe('synced')
    expect(synced?.error).toBeNull()
  })
})

describe('summarizeLedger', () => {
  it('counts and totals the entries', async () => {
    await appendWorklog(tasksDir, KEY, { seconds: 1800, startedAt: T0, createdAt: NOW })
    await appendWorklog(tasksDir, KEY, { seconds: 3600, startedAt: T0, createdAt: NOW })
    const entries = await readLedger(tasksDir, KEY)
    const totals = summarizeLedger(entries)
    expect(totals.count).toBe(2)
    expect(totals.totalSeconds).toBe(5400)
    expect(totals.draftCount).toBe(2)
    expect(totals.syncedCount).toBe(0)
    expect(totals.failedCount).toBe(0)
  })

  it('separates drafts, synced and failed', async () => {
    const a = await appendWorklog(tasksDir, KEY, { seconds: 60, startedAt: T0, createdAt: NOW })
    const b = await appendWorklog(tasksDir, KEY, { seconds: 60, startedAt: T0, createdAt: NOW })
    const c = await appendWorklog(tasksDir, KEY, { seconds: 60, startedAt: T0, createdAt: NOW })
    await markSynced(tasksDir, KEY, a.id, '1', NOW)
    await markFailed(tasksDir, KEY, b.id, 'boom')
    const totals = summarizeLedger(await readLedger(tasksDir, KEY))
    expect(totals.draftCount).toBe(1)
    expect(totals.syncedCount).toBe(1)
    expect(totals.failedCount).toBe(1)
    expect(c.id).toBe('wl-03')
  })

  it('an empty ledger totals to zero', () => {
    expect(summarizeLedger([])).toEqual({
      count: 0, totalSeconds: 0, draftCount: 0, syncedCount: 0, failedCount: 0,
    })
  })
})
