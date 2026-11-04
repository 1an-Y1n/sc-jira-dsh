import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  SessionDocCorruptError,
  docPath,
  emptyDoc,
  invalidateDoc,
  readDoc,
  readDocCached,
  updateDocAndInvalidate,
} from '../src/session-store.js'
import type { SessionDoc } from '../src/types.js'

let dir: string
const SESSION = 'session-aaaa-bbbb'

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'scjira-store-'))
  invalidateDoc(dir, SESSION)
})

afterEach(async () => {
  invalidateDoc(dir, SESSION)
  await rm(dir, { recursive: true, force: true })
})

/** Bind a session, the cheapest way to have a non-empty document. */
async function bind(sessionId = SESSION) {
  await updateDocAndInvalidate(dir, sessionId, current => ({
    next: { ...current, binding: { key: 'DZ300-797', summary: 'x', statusName: 'Open', url: 'u', boundAt: new Date().toISOString() } },
    result: null,
  }))
}

describe('reading', () => {
  it('a missing file is an empty document, not an error', async () => {
    const doc = await readDoc(dir, SESSION)
    expect(doc).toEqual(emptyDoc(SESSION))
  })

  it('round-trips a written document', async () => {
    await bind()
    const doc = await readDoc(dir, SESSION)
    expect(doc.binding?.key).toBe('DZ300-797')
    expect(doc.activities).toEqual([])
  })

  it('encodes the session id into the file name', async () => {
    expect(docPath(dir, 'session/../x')).toBe(join(dir, 'session_.._x.json'))
  })

  it('refuses an unreadable file and leaves it untouched', async () => {
    const path = docPath(dir, SESSION)
    await writeFile(path, '{ not json', 'utf8')
    await expect(readDoc(dir, SESSION)).rejects.toBeInstanceOf(SessionDocCorruptError)
    // The bytes are still there: the only copy of the records
    // must not be overwritten because a parse failed.
    expect(await readFile(path, 'utf8')).toBe('{ not json')
  })

  it('refuses an unsupported schemaVersion instead of guessing', async () => {
    const path = docPath(dir, SESSION)
    await writeFile(path, JSON.stringify({ schemaVersion: 99, sessionId: SESSION }), 'utf8')
    await expect(readDoc(dir, SESSION)).rejects.toBeInstanceOf(SessionDocCorruptError)
  })
})

describe('writing', () => {
  it('serializes concurrent mutations, so neither record is lost', async () => {
    await bind()
    await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        updateDocAndInvalidate(dir, SESSION, current => ({
          next: {
            ...current,
            activities: [
              ...current.activities,
              {
                id: `act-0${index + 1}`,
                summary: `record ${index}`,
                startedAt: '2026-11-04T09:00:00.000+0800',
                seconds: 60,
                turn: 1,
                source: 'agent' as const,
              },
            ],
          },
          result: null,
        })),
      ),
    )
    const doc = await readDoc(dir, SESSION)
    expect(doc.activities).toHaveLength(5)
  })

  it('leaves the file alone when the mutation returns next: null', async () => {
    await bind()
    const before = await readFile(docPath(dir, SESSION), 'utf8')
    await updateDocAndInvalidate(dir, SESSION, () => ({ next: null, result: null }))
    expect(await readFile(docPath(dir, SESSION), 'utf8')).toBe(before)
  })

  it('a failed mutation does not poison the next one', async () => {
    await bind()
    await expect(updateDocAndInvalidate(dir, SESSION, () => { throw new Error('boom') })).rejects.toThrow('boom')
    const doc = await updateDocAndInvalidate(dir, SESSION, current => ({ next: { ...current, turns: [] }, result: current }))
    expect(doc.binding?.key).toBe('DZ300-797')
  })
})

describe('the cached read', () => {
  it('serves the mutation it just made, because a write invalidates', async () => {
    await bind()
    expect((await readDocCached(dir, SESSION)).binding).not.toBeNull()
    await updateDocAndInvalidate(dir, SESSION, () => ({
      next: { ...emptyDoc(SESSION) },
      result: null,
    }))
    expect((await readDocCached(dir, SESSION)).binding).toBeNull()
  })

  it('re-reads the file once the ttl expires', async () => {
    // A different writer (another process, the panel) changes the file behind
    // this process's back; the cache must not hide that forever.
    await bind()
    const path = docPath(dir, SESSION)
    await mkdir(dir, { recursive: true })
    const external: SessionDoc = { ...emptyDoc(SESSION), turns: [] }
    await writeFile(path, `${JSON.stringify(external, null, 2)}\n`, 'utf8')
    expect((await readDocCached(dir, SESSION, 0)).binding).toBeNull()
  })
})
