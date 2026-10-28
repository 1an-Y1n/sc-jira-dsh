import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TurnTimer, autoComment, localTimestamp, secondsToRecord } from '../src/turn-timer.js'
import {
  appendSessionLog,
  countSummaries,
  describeToolCall,
  logPath,
  readSessionLog,
  readSummaries,
  summaryPath,
  writeSummary,
} from '../src/session-log.js'
import { DEFAULT_AUTO_WORKLOG } from '../src/types.js'
import type { AutoWorklogConfig } from '../src/types.js'

let tasksDir: string
const KEY = 'DZ300-1'

beforeEach(async () => {
  tasksDir = await mkdtemp(join(tmpdir(), 'scjira-turn-'))
})

afterEach(async () => {
  await rm(tasksDir, { recursive: true, force: true })
})

const policy = (over: Partial<AutoWorklogConfig> = {}): AutoWorklogConfig => ({
  ...DEFAULT_AUTO_WORKLOG,
  ...over,
})

describe('secondsToRecord', () => {
  it('records nothing when recording is off', () => {
    expect(secondsToRecord(600_000, policy({ enabled: false }))).toBeNull()
  })

  it('records nothing below the minimum', () => {
    expect(secondsToRecord(59_000, policy({ minSeconds: 60 }))).toBeNull()
  })

  it('records at the minimum', () => {
    expect(secondsToRecord(60_000, policy({ minSeconds: 60 }))).toBe(60)
  })

  it('rounds up to the rounding step', () => {
    expect(secondsToRecord(61_000, policy({ rounding: 60 }))).toBe(120)
    expect(secondsToRecord(119_000, policy({ rounding: 60 }))).toBe(120)
    expect(secondsToRecord(120_000, policy({ rounding: 60 }))).toBe(120)
  })

  it('rounds up to a custom step', () => {
    expect(secondsToRecord(90_000, policy({ rounding: 300 }))).toBe(300)
  })

  it('caps a very long turn', () => {
    expect(secondsToRecord(10 * 3_600_000, policy({ maxSecondsPerTurn: 14_400 }))).toBe(14_400)
  })

  it('rounds the capped value up too', () => {
    // 14001s capped to 14400s, rounded to 14400s
    expect(secondsToRecord(14_401_000, policy({ maxSecondsPerTurn: 14_400, rounding: 60 }))).toBe(14_400)
  })

  it('never records less than one rounding step', () => {
    expect(secondsToRecord(60_000, policy({ minSeconds: 60, rounding: 300 }))).toBe(300)
  })
})

describe('TurnTimer', () => {
  it('opens a turn and measures it', () => {
    const timer = new TurnTimer()
    const span = timer.start('s1', 3)
    expect(span.turn).toBe(3)
    expect(timer.size).toBe(1)
  })

  it('keeps the first start for later steps of the same turn', () => {
    const timer = new TurnTimer()
    const first = timer.start('s1', 3)
    const second = timer.start('s1', 3)
    expect(second.startedAt).toBe(first.startedAt)
  })

  it('opens a new turn when the turn number changes', () => {
    const timer = new TurnTimer()
    const first = timer.start('s1', 3)
    const second = timer.start('s1', 4)
    // The turn number is what distinguishes them; the clock may not have
    // moved between two calls in the same millisecond.
    expect(second.turn).toBe(4)
    expect(first.turn).toBe(3)
    expect(timer.peek('s1')?.turn).toBe(4)
  })

  it('tracks agents separately', () => {
    const timer = new TurnTimer()
    timer.start('s1', 1)
    timer.start('s2', 1)
    expect(timer.size).toBe(2)
  })

  it('ends a turn and reports the elapsed time', () => {
    const timer = new TurnTimer()
    timer.start('s1', 3)
    const span = timer.end('s1', 3)
    expect(span).not.toBeNull()
    expect(span?.turn).toBe(3)
    expect(span?.elapsedMs).toBeGreaterThanOrEqual(0)
    expect(span?.endedAt).toBeGreaterThan(0)
  })

  it('closes the turn, so a second end finds nothing', () => {
    const timer = new TurnTimer()
    timer.start('s1', 3)
    timer.end('s1', 3)
    expect(timer.end('s1', 3)).toBeNull()
    expect(timer.size).toBe(0)
  })

  it('ignores an end for a turn that is not open', () => {
    const timer = new TurnTimer()
    timer.start('s1', 3)
    expect(timer.end('s1', 99)).toBeNull()
    // The open turn survives a mismatched end.
    expect(timer.size).toBe(1)
  })

  it('ignores an end for an agent with no open turn', () => {
    expect(new TurnTimer().end('nobody', 1)).toBeNull()
  })

  it('forgets an agent', () => {
    const timer = new TurnTimer()
    timer.start('s1', 1)
    timer.forget('s1')
    expect(timer.size).toBe(0)
  })

  it('peeks at the open turn', () => {
    const timer = new TurnTimer()
    timer.start('s1', 7)
    expect(timer.peek('s1')?.turn).toBe(7)
    expect(timer.peek('s2')).toBeUndefined()
  })
})

describe('localTimestamp', () => {
  it('renders the instant with a fixed +0800 offset', () => {
    // 2026-10-26T01:00:00Z is 09:00 in +0800.
    expect(localTimestamp(Date.parse('2026-10-26T01:00:00Z'))).toBe('2026-10-26T09:00:00.000+0800')
  })

  it('renders midnight correctly', () => {
    expect(localTimestamp(Date.parse('2026-10-25T16:00:00Z'))).toBe('2026-10-26T00:00:00.000+0800')
  })

  it('always carries the +0800 suffix', () => {
    expect(localTimestamp(Date.now()).endsWith('+0800')).toBe(true)
  })
})

describe('autoComment', () => {
  it('names the turn', () => {
    expect(autoComment(3, 'session-abc', false)).toBe('auto: turn 3')
  })

  it('includes a short session id when asked', () => {
    expect(autoComment(3, 'session-abc', true)).toContain('session-abc')
  })

  it('truncates a long session id', () => {
    const comment = autoComment(3, 'x'.repeat(40), true)
    expect(comment.length).toBeLessThan(60)
    expect(comment).toContain('…')
  })
})

describe('session activity log', () => {
  it('a missing log reads as empty', async () => {
    expect(await readSessionLog(tasksDir, KEY)).toEqual([])
  })

  it('appends an entry', async () => {
    await appendSessionLog(tasksDir, KEY, {
      ts: '2026-10-26T03:35:00.000Z',
      text: 'read the register dump',
      source: 'command',
    })
    const entries = await readSessionLog(tasksDir, KEY)
    expect(entries).toHaveLength(1)
    expect(entries[0]?.text).toBe('read the register dump')
    expect(entries[0]?.source).toBe('command')
  })

  it('appends rather than replacing', async () => {
    await appendSessionLog(tasksDir, KEY, { ts: 'a', text: 'one', source: 'command' })
    await appendSessionLog(tasksDir, KEY, { ts: 'b', text: 'two', source: 'command' })
    const entries = await readSessionLog(tasksDir, KEY)
    expect(entries.map(e => e.text)).toEqual(['one', 'two'])
  })

  it('writes one JSON object per line', async () => {
    await appendSessionLog(tasksDir, KEY, { ts: 'a', text: 'one', source: 'command' })
    const raw = await readFile(logPath(tasksDir, KEY), 'utf8')
    expect(raw.trimEnd().split('\n')).toHaveLength(1)
    expect(JSON.parse(raw.trim())).toMatchObject({ text: 'one' })
  })

  it('skips a malformed line', async () => {
    await mkdir(join(tasksDir, KEY), { recursive: true })
    await appendSessionLog(tasksDir, KEY, { ts: 'a', text: 'one', source: 'command' })
    const raw = await readFile(logPath(tasksDir, KEY), 'utf8')
    await (await import('node:fs/promises')).writeFile(
      logPath(tasksDir, KEY),
      `${raw}not json\n{"ts":"c","text":"three","source":"command"}\n`,
    )
    const entries = await readSessionLog(tasksDir, KEY)
    expect(entries.map(e => e.text)).toEqual(['one', 'three'])
  })
})

describe('turn summaries', () => {
  it('writes a summary for a turn', async () => {
    const s = await writeSummary(tasksDir, KEY, {
      turnSeq: 0,
      writtenAt: '2026-10-26T04:00:00.000Z',
      body: { text: 'found the root cause', highlights: ['xen/balloon.c'], blockers: [] },
    })
    expect(s.schemaVersion).toBe(1)
    expect(s.key).toBe(KEY)
    expect(s.turnSeq).toBe(0)
  })

  it('the file is named after the turn', async () => {
    await writeSummary(tasksDir, KEY, {
      turnSeq: 7,
      writtenAt: 'x',
      body: { text: 't', highlights: [], blockers: [] },
    })
    const raw = JSON.parse(await readFile(summaryPath(tasksDir, KEY, 7), 'utf8'))
    expect(raw.turnSeq).toBe(7)
  })

  it('a second summary for the same turn replaces the first', async () => {
    await writeSummary(tasksDir, KEY, {
      turnSeq: 0, writtenAt: 'x', body: { text: 'first', highlights: [], blockers: [] },
    })
    await writeSummary(tasksDir, KEY, {
      turnSeq: 0, writtenAt: 'y', body: { text: 'second', highlights: [], blockers: [] },
    })
    const summaries = await readSummaries(tasksDir, KEY)
    expect(summaries).toHaveLength(1)
    expect(summaries[0]?.body.text).toBe('second')
  })

  it('reads summaries in turn order', async () => {
    await writeSummary(tasksDir, KEY, { turnSeq: 2, writtenAt: 'x', body: { text: 'c', highlights: [], blockers: [] } })
    await writeSummary(tasksDir, KEY, { turnSeq: 0, writtenAt: 'x', body: { text: 'a', highlights: [], blockers: [] } })
    await writeSummary(tasksDir, KEY, { turnSeq: 1, writtenAt: 'x', body: { text: 'b', highlights: [], blockers: [] } })
    const summaries = await readSummaries(tasksDir, KEY)
    expect(summaries.map(s => s.turnSeq)).toEqual([0, 1, 2])
  })

  it('no summaries reads as empty', async () => {
    expect(await readSummaries(tasksDir, KEY)).toEqual([])
    expect(await countSummaries(tasksDir, KEY)).toBe(0)
  })

  it('counts summaries', async () => {
    await writeSummary(tasksDir, KEY, { turnSeq: 0, writtenAt: 'x', body: { text: 'a', highlights: [], blockers: [] } })
    await writeSummary(tasksDir, KEY, { turnSeq: 1, writtenAt: 'x', body: { text: 'b', highlights: [], blockers: [] } })
    expect(await countSummaries(tasksDir, KEY)).toBe(2)
  })
})

describe('describeToolCall', () => {
  it('names the tool when there are no arguments', () => {
    expect(describeToolCall('read', '')).toBe('read')
  })

  it('includes a short argument list', () => {
    expect(describeToolCall('read', '{"path":"a.ts"}')).toContain('read')
    expect(describeToolCall('read', '{"path":"a.ts"}')).toContain('a.ts')
  })

  it('truncates a long argument list', () => {
    const text = describeToolCall('run', 'x'.repeat(500))
    expect(text.length).toBeLessThan(140)
    expect(text).toContain('…')
  })
})
