import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeMetaWithBinding, readBindingBySession, listBindings } from '../src/storage.js'

let tasksDir: string

beforeEach(async () => {
  tasksDir = await mkdtemp(join(tmpdir(), 'scjira-storage-'))
})

afterEach(async () => {
  await rm(tasksDir, { recursive: true, force: true })
})

describe('storage', () => {
  it('writeMetaWithBinding creates meta.json with schemaVersion 3', async () => {
    await writeMetaWithBinding(tasksDir, {
      key: 'DZ300-1826',
      sessionId: 'agent-abc',
      issueSummary: { summary: 'Test', statusName: 'Open' },
    })
    const raw = JSON.parse(await readFile(join(tasksDir, 'DZ300-1826/meta.json'), 'utf8'))
    expect(raw.schemaVersion).toBe(3)
    expect(raw.key).toBe('DZ300-1826')
    expect(raw.dshSessionId).toBe('agent-abc')
    expect(raw.status).toBe('active')
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
})