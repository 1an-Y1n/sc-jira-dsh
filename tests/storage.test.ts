import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  writeMetaWithBinding,
  readBindingBySession,
  readBindingDetailBySession,
  readBindingByKey,
  listBindings,
  listActiveBindings,
  endBinding,
  readIndex,
  buildIndex,
  updateAutoWorklog,
  readMeta,
  INDEX_FILE,
} from '../src/storage.js'

let tasksDir: string

beforeEach(async () => {
  tasksDir = await mkdtemp(join(tmpdir(), 'scjira-storage-'))
})

afterEach(async () => {
  await rm(tasksDir, { recursive: true, force: true })
})

describe('storage', () => {
  it('writeMetaWithBinding creates meta.json with schemaVersion 4', async () => {
    await writeMetaWithBinding(tasksDir, {
      key: 'DZ300-1826',
      sessionId: 'agent-abc',
      issueSummary: { summary: 'Test', statusName: 'Open' },
    })
    const raw = JSON.parse(await readFile(join(tasksDir, 'DZ300-1826/meta.json'), 'utf8'))
    expect(raw.schemaVersion).toBe(4)
    expect(raw.key).toBe('DZ300-1826')
    expect(raw.dshSessionId).toBe('agent-abc')
    expect(raw.status).toBe('active')
  })

  it('a new binding carries the default automatic-worklog policy', async () => {
    await writeMetaWithBinding(tasksDir, { key: 'DZ300-1', sessionId: 's1', issueSummary: {} })
    const meta = await readMeta(tasksDir, 'DZ300-1')
    expect(meta).not.toBeNull()
    expect(meta?.autoWorklog).toEqual({
      enabled: true,
      minSeconds: 60,
      rounding: 60,
      maxSecondsPerTurn: 14400,
      includeSessionId: true,
    })
  })

  it('writeMetaWithBinding throws when re-binding same key to different session', async () => {
    await writeMetaWithBinding(tasksDir, { key: 'DZ300-1', sessionId: 's1', issueSummary: {} })
    await expect(
      writeMetaWithBinding(tasksDir, { key: 'DZ300-1', sessionId: 's2', issueSummary: {} }),
    ).rejects.toThrow(/already bound to another session/)
  })

  it('writeMetaWithBinding is idempotent for same sessionId', async () => {
    await writeMetaWithBinding(tasksDir, { key: 'DZ300-1', sessionId: 's1', issueSummary: {} })
    await expect(
      writeMetaWithBinding(tasksDir, { key: 'DZ300-1', sessionId: 's1', issueSummary: {} }),
    ).resolves.toBeUndefined()
  })

  it('one session cannot hold two bindings at once', async () => {
    await writeMetaWithBinding(tasksDir, { key: 'DZ300-1', sessionId: 's1', issueSummary: {} })
    await expect(
      writeMetaWithBinding(tasksDir, { key: 'DZ300-2', sessionId: 's1', issueSummary: {} }),
    ).rejects.toThrow(/already bound to DZ300-1/)
  })

  it('readBindingBySession returns bound=true when sessionId matches', async () => {
    await writeMetaWithBinding(tasksDir, { key: 'DZ300-2', sessionId: 'sX', issueSummary: { summary: 'Hello' } })
    const r = await readBindingBySession(tasksDir, 'sX')
    expect(r.bound).toBe(true)
    expect(r.key).toBe('DZ300-2')
    expect(r.summary).toBe('Hello')
  })

  it('readBindingBySession returns bound=false when no match', async () => {
    const r = await readBindingBySession(tasksDir, 'nonexistent')
    expect(r.bound).toBe(false)
  })

  it('listBindings returns all keys', async () => {
    await writeMetaWithBinding(tasksDir, { key: 'DZ300-3', sessionId: 's3', issueSummary: {} })
    await writeMetaWithBinding(tasksDir, { key: 'DZ300-4', sessionId: 's4', issueSummary: {} })
    const keys = await listBindings(tasksDir)
    expect(keys.sort()).toEqual(['DZ300-3', 'DZ300-4'])
  })

  it('readBindingBySession rejects schemaVersion mismatch', async () => {
    // write a v2 file manually
    await mkdir(join(tasksDir, 'DZ300-5'), { recursive: true })
    await writeFile(join(tasksDir, 'DZ300-5/meta.json'), JSON.stringify({
      schemaVersion: 2, key: 'DZ300-5', dshSessionId: 'old', status: 'active', startedAt: 'x', endedAt: null, issueSummary: {}, logCount: 0, logBytes: 0, summaryCount: 0,
    }))
    const r = await readBindingBySession(tasksDir, 'old')
    expect(r.bound).toBe(false)  // skipped as unsupported
  })

  it('a v3 file is upgraded in place on read', async () => {
    await mkdir(join(tasksDir, 'DZ300-6'), { recursive: true })
    await writeFile(join(tasksDir, 'DZ300-6/meta.json'), JSON.stringify({
      schemaVersion: 3, key: 'DZ300-6', dshSessionId: 's-v3', status: 'active',
      startedAt: 'x', endedAt: null, issueSummary: { summary: 'Old' },
      logCount: 3, logBytes: 40, summaryCount: 1,
    }))
    const r = await readBindingBySession(tasksDir, 's-v3')
    expect(r.bound).toBe(true)
    expect(r.key).toBe('DZ300-6')

    const meta = await readMeta(tasksDir, 'DZ300-6')
    expect(meta?.schemaVersion).toBe(4)
    // The counters carry over; the new policy takes its defaults.
    expect(meta?.logCount).toBe(3)
    expect(meta?.autoWorklog.enabled).toBe(true)
  })
})

describe('binding index', () => {
  it('writeMetaWithBinding writes a bidirectional index', async () => {
    await writeMetaWithBinding(tasksDir, { key: 'DZ300-1', sessionId: 's1', issueSummary: {} })
    const index = await readIndex(tasksDir)
    expect(index.bySession.s1).toBe('DZ300-1')
    expect(index.byKey['DZ300-1']).toBe('s1')
  })

  it('the index file exists on disk', async () => {
    await writeMetaWithBinding(tasksDir, { key: 'DZ300-1', sessionId: 's1', issueSummary: {} })
    const raw = JSON.parse(await readFile(join(tasksDir, INDEX_FILE), 'utf8'))
    expect(raw.bySession.s1).toBe('DZ300-1')
  })

  it('a stale index is rebuilt from the meta files', async () => {
    await writeMetaWithBinding(tasksDir, { key: 'DZ300-1', sessionId: 's1', issueSummary: {} })
    // Corrupt the index by hand — the metas must win.
    await writeFile(join(tasksDir, INDEX_FILE), JSON.stringify({
      schemaVersion: 1, bySession: { s1: 'WRONG-1' }, byKey: { 'WRONG-1': 's1' },
    }))
    const index = await readIndex(tasksDir)
    expect(index.bySession.s1).toBe('DZ300-1')
    expect(index.byKey['WRONG-1']).toBeUndefined()
  })

  it('a missing index is created on read', async () => {
    await writeMetaWithBinding(tasksDir, { key: 'DZ300-1', sessionId: 's1', issueSummary: {} })
    await rm(join(tasksDir, INDEX_FILE), { force: true })
    const index = await readIndex(tasksDir)
    expect(index.bySession.s1).toBe('DZ300-1')
    // and it is written back
    const raw = JSON.parse(await readFile(join(tasksDir, INDEX_FILE), 'utf8'))
    expect(raw.bySession.s1).toBe('DZ300-1')
  })

  it('buildIndex ignores ended bindings', async () => {
    await writeMetaWithBinding(tasksDir, { key: 'DZ300-1', sessionId: 's1', issueSummary: {} })
    await endBinding(tasksDir, 's1')
    const index = await buildIndex(tasksDir)
    expect(index.bySession.s1).toBeUndefined()
    expect(index.byKey['DZ300-1']).toBeUndefined()
  })
})

describe('ending a binding', () => {
  it('endBinding clears the index but keeps the files', async () => {
    await writeMetaWithBinding(tasksDir, { key: 'DZ300-1', sessionId: 's1', issueSummary: { summary: 'x' } })
    await mkdir(join(tasksDir, 'DZ300-1'), { recursive: true })
    await writeFile(join(tasksDir, 'DZ300-1/worklog.jsonl'), '{"id":"wl-01"}\n')

    const ended = await endBinding(tasksDir, 's1')
    expect(ended?.status).toBe('ended')

    const r = await readBindingBySession(tasksDir, 's1')
    expect(r.bound).toBe(false)

    // The history stays on disk.
    const raw = await readFile(join(tasksDir, 'DZ300-1/worklog.jsonl'), 'utf8')
    expect(raw).toContain('wl-01')
  })

  it('a session may bind again after ending its binding', async () => {
    await writeMetaWithBinding(tasksDir, { key: 'DZ300-1', sessionId: 's1', issueSummary: {} })
    await endBinding(tasksDir, 's1')
    await expect(
      writeMetaWithBinding(tasksDir, { key: 'DZ300-2', sessionId: 's1', issueSummary: {} }),
    ).resolves.toBeUndefined()
    const r = await readBindingBySession(tasksDir, 's1')
    expect(r.key).toBe('DZ300-2')
  })

  it('a key may be bound to another session after ending', async () => {
    await writeMetaWithBinding(tasksDir, { key: 'DZ300-1', sessionId: 's1', issueSummary: {} })
    await endBinding(tasksDir, 's1')
    await expect(
      writeMetaWithBinding(tasksDir, { key: 'DZ300-1', sessionId: 's2', issueSummary: {} }),
    ).resolves.toBeUndefined()
    const r = await readBindingBySession(tasksDir, 's2')
    expect(r.key).toBe('DZ300-1')
  })
})

describe('binding details', () => {
  it('readBindingDetailBySession returns the full binding', async () => {
    await writeMetaWithBinding(tasksDir, {
      key: 'DZ300-1', sessionId: 's1',
      issueSummary: { summary: 'Detail', statusName: 'Open', priority: 'High', duedate: '', url: 'u' },
    })
    const b = await readBindingDetailBySession(tasksDir, 's1')
    expect(b?.key).toBe('DZ300-1')
    expect(b?.summary).toBe('Detail')
    expect(b?.issueSummary.priority).toBe('High')
  })

  it('readBindingByKey resolves the owning session', async () => {
    await writeMetaWithBinding(tasksDir, { key: 'DZ300-1', sessionId: 's1', issueSummary: { summary: 'ByKey' } })
    const b = await readBindingByKey(tasksDir, 'DZ300-1')
    expect(b?.sessionId).toBe('s1')
    expect(b?.summary).toBe('ByKey')
  })

  it('listActiveBindings excludes ended bindings', async () => {
    await writeMetaWithBinding(tasksDir, { key: 'DZ300-1', sessionId: 's1', issueSummary: {} })
    await writeMetaWithBinding(tasksDir, { key: 'DZ300-2', sessionId: 's2', issueSummary: {} })
    await endBinding(tasksDir, 's1')
    const active = await listActiveBindings(tasksDir)
    expect(active.map(b => b.key)).toEqual(['DZ300-2'])
  })
})

describe('auto worklog policy', () => {
  it('updateAutoWorklog changes the policy', async () => {
    await writeMetaWithBinding(tasksDir, { key: 'DZ300-1', sessionId: 's1', issueSummary: {} })
    const meta = await updateAutoWorklog(tasksDir, 'DZ300-1', { enabled: false, minSeconds: 300 })
    expect(meta?.autoWorklog.enabled).toBe(false)
    expect(meta?.autoWorklog.minSeconds).toBe(300)
    // Untouched fields keep their values.
    expect(meta?.autoWorklog.rounding).toBe(60)

    const reread = await readMeta(tasksDir, 'DZ300-1')
    expect(reread?.autoWorklog.enabled).toBe(false)
  })
})
