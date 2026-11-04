import { describe, it, expect } from 'vitest'
import {
  discardDraft,
  generateDraft,
  isSettled,
  nextActivityId,
  nextEntryId,
  pendingEntries,
  summarizeDoc,
  uncoveredActivities,
} from '../src/worklog.js'
import { DEFAULT_WORKLOG_POLICY } from '../src/types.js'
import type { Activity, DraftEntry, SessionDoc } from '../src/types.js'

const policy = DEFAULT_WORKLOG_POLICY
const NOW = Date.UTC(2026, 10, 4, 3, 0, 0)

function activity(id: string, startedAt: string, seconds: number, summary = `work ${id}`): Activity {
  return { id, summary, startedAt, seconds, turn: 3, source: 'agent' }
}

function doc(over: Partial<SessionDoc> = {}): SessionDoc {
  return {
    schemaVersion: 1,
    sessionId: 'session-x',
    binding: { key: 'DZ300-797', summary: 'The issue', statusName: 'Open', url: 'u', boundAt: '2026-11-04T01:00:00.000Z' },
    activities: [],
    turns: [],
    draft: null,
    ...over,
  }
}

function entry(over: Partial<DraftEntry> = {}): DraftEntry {
  return {
    id: 'wl-01',
    startedAt: '2026-11-04T09:00:00.000+0800',
    seconds: 600,
    comment: 'x',
    activityIds: [],
    state: 'draft',
    jiraId: null,
    syncedAt: null,
    error: null,
    ...over,
  }
}

describe('what is left to bill', () => {
  it('an activity covered by a synced entry is not offered again', () => {
    const base = doc({
      activities: [activity('act-01', '2026-11-04T09:00:00.000+0800', 600), activity('act-02', '2026-11-04T10:00:00.000+0800', 900)],
      draft: { generatedAt: 'x', entries: [entry({ state: 'synced', activityIds: ['act-01'] })] },
    })
    expect(uncoveredActivities(base).map(item => item.id)).toEqual(['act-02'])
  })

  it('an activity covered only by a draft entry is still uncovered', () => {
    const base = doc({
      activities: [activity('act-01', '2026-11-04T09:00:00.000+0800', 600)],
      draft: { generatedAt: 'x', entries: [entry({ activityIds: ['act-01'] })] },
    })
    // A draft is regenerable, so its activities stay billable until uploaded.
    expect(uncoveredActivities(base).map(item => item.id)).toEqual(['act-01'])
  })

  it('settled means nothing pending and nothing unbilled', () => {
    expect(isSettled(doc({ activities: [activity('act-01', '2026-11-04T09:00:00.000+0800', 60)] }))).toBe(false)
    expect(isSettled(doc({ draft: { generatedAt: 'x', entries: [entry()] } }))).toBe(false)
    expect(isSettled(doc({ draft: { generatedAt: 'x', entries: [entry({ state: 'synced' })] } }))).toBe(true)
  })

  it('pending counts drafts and failures, not synced entries', () => {
    const base = doc({
      draft: {
        generatedAt: 'x',
        entries: [entry({ id: 'wl-01' }), entry({ id: 'wl-02', state: 'failed' }), entry({ id: 'wl-03', state: 'synced' })],
      },
    })
    expect(pendingEntries(base).map(item => item.id)).toEqual(['wl-01', 'wl-02'])
  })
})

describe('ids', () => {
  it('advance past every id already used', () => {
    expect(nextActivityId([activity('act-01', 'x', 60), activity('act-09', 'x', 60)])).toBe('act-10')
    expect(nextEntryId([entry({ id: 'wl-03' }), entry({ id: 'wl-07' })])).toBe('wl-08')
  })
})

describe('generate, one entry per activity', () => {
  it('is deterministic: one entry per uncovered activity, verbatim', () => {
    const base = doc({
      activities: [
        activity('act-01', '2026-11-04T09:00:00.000+0800', 600, 'read the registers'),
        activity('act-02', '2026-11-04T10:00:00.000+0800', 900, 'locate the panic'),
      ],
    })
    const r = generateDraft(base, null, policy, NOW)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.generated.draft.entries).toHaveLength(2)
    expect(r.generated.draft.entries[0]).toMatchObject({
      id: 'wl-01',
      seconds: 600,
      comment: 'read the registers',
      activityIds: ['act-01'],
      state: 'draft',
    })
    expect(r.generated.draft.entries[1]?.comment).toBe('locate the panic')
    expect(r.generated.recordedSeconds).toBe(1500)
    expect(r.generated.proposedSeconds).toBe(1500)
    expect(r.generated.deltaSeconds).toBe(0)
  })

  it('keeps synced entries and replaces the draft ones', () => {
    const base = doc({
      activities: [
        activity('act-01', '2026-11-04T09:00:00.000+0800', 600),
        activity('act-02', '2026-11-04T10:00:00.000+0800', 900),
      ],
      draft: {
        generatedAt: 'old',
        entries: [
          entry({ id: 'wl-01', state: 'synced', activityIds: ['act-01'] }),
          entry({ id: 'wl-02', activityIds: ['act-02'] }),
        ],
      },
    })
    const r = generateDraft(base, null, policy, NOW)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const ids = r.generated.draft.entries.map(item => item.id)
    expect(ids).toContain('wl-01')          // the synced one stays
    expect(ids).toContain('wl-03')          // the new one continues past wl-02
    expect(ids).not.toContain('wl-02')      // the old draft was replaced
    expect(r.generated.draft.entries.find(item => item.id === 'wl-01')?.state).toBe('synced')
  })

  it('sorts the draft by start time', () => {
    const base = doc({
      activities: [
        activity('act-01', '2026-11-04T11:00:00.000+0800', 600),
        activity('act-02', '2026-11-04T09:00:00.000+0800', 900),
      ],
    })
    const r = generateDraft(base, null, policy, NOW)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.generated.draft.entries.map(item => item.activityIds[0])).toEqual(['act-02', 'act-01'])
  })

  it('refuses when there is nothing new to bill', () => {
    const r = generateDraft(doc({ draft: { generatedAt: 'x', entries: [entry({ state: 'synced', activityIds: [] })] } }), null, policy, NOW)
    expect(r).toEqual({ ok: false, error: expect.stringContaining('没有新的活动') })
  })
})

describe('generate from a proposal', () => {
  const base = doc({
    activities: [
      activity('act-01', '2026-11-04T09:00:00.000+0800', 1800),
      activity('act-02', '2026-11-04T09:30:00.000+0800', 1800),
      activity('act-03', '2026-11-04T10:30:00.000+0800', 900),
    ],
  })

  it('merges activities into one entry and reports the delta', () => {
    const r = generateDraft(base, [
      { seconds: 3600, comment: '排查并修复 panic', activityIds: ['act-01', 'act-02'] },
      { seconds: 900, comment: '补测试', activityIds: ['act-03'] },
    ], policy, NOW)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.generated.added).toBe(2)
    expect(r.generated.covered).toBe(3)
    expect(r.generated.draft.entries[0]).toMatchObject({
      seconds: 3600,
      comment: '排查并修复 panic',
      activityIds: ['act-01', 'act-02'],
      // The earliest covered activity is when the work began.
      startedAt: '2026-11-04T09:00:00.000+0800',
    })
    expect(r.generated.deltaSeconds).toBe(0)
  })

  it('reports a delta instead of refusing a proposal that claims more', () => {
    const r = generateDraft(base, [
      { seconds: 3600, comment: 'all of it', activityIds: ['act-01', 'act-02', 'act-03'] },
    ], policy, NOW)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.generated.recordedSeconds).toBe(4500)
    expect(r.generated.proposedSeconds).toBe(3600)
    expect(r.generated.deltaSeconds).toBe(-900)
  })

  it('allows an entry with no activityIds as a top-up', () => {
    const r = generateDraft(base, [
      { seconds: 3600, comment: 'debug', activityIds: ['act-01', 'act-02'] },
      { seconds: 900, comment: 'tests', activityIds: ['act-03'] },
      { seconds: 600, comment: 'unrecorded review' },
    ], policy, NOW)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.generated.deltaSeconds).toBe(600)
    expect(r.generated.draft.entries.find(item => item.comment === 'unrecorded review')?.activityIds).toEqual([])
  })

  it('refuses a proposal that leaves an activity unbilled', () => {
    const r = generateDraft(base, [
      { seconds: 3600, comment: 'debug', activityIds: ['act-01', 'act-02'] },
    ], policy, NOW)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain('act-03')
  })

  it('refuses a proposal that bills one activity twice', () => {
    const r = generateDraft(base, [
      { seconds: 3600, comment: 'a', activityIds: ['act-01', 'act-02'] },
      { seconds: 900, comment: 'b', activityIds: ['act-03', 'act-01'] },
    ], policy, NOW)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain('act-01')
  })

  it('refuses an unknown activity id', () => {
    const r = generateDraft(base, [
      { seconds: 4500, comment: 'all', activityIds: ['act-01', 'act-02', 'act-03', 'act-99'] },
    ], policy, NOW)
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain('act-99')
  })

  it('refuses an invalid duration or an empty comment', () => {
    expect(generateDraft(base, [{ seconds: 0, comment: 'x', activityIds: ['act-01', 'act-02', 'act-03'] }], policy, NOW).ok).toBe(false)
    expect(generateDraft(base, [{ seconds: 4500, comment: '  ', activityIds: ['act-01', 'act-02', 'act-03'] }], policy, NOW).ok).toBe(false)
  })

  it('refuses a startedAt without an offset', () => {
    const r = generateDraft(base, [
      { seconds: 4500, comment: 'all', activityIds: ['act-01', 'act-02', 'act-03'], startedAt: '2026-11-04T09:00:00' },
    ], policy, NOW)
    expect(r.ok).toBe(false)
  })
})

describe('discard', () => {
  it('drops drafts and keeps what reached Jira', () => {
    const base = doc({
      draft: {
        generatedAt: 'x',
        entries: [entry({ id: 'wl-01' }), entry({ id: 'wl-02', state: 'synced' })],
      },
    })
    const r = discardDraft(base)
    expect(r).toEqual({ removed: 1, kept: 1 })
    expect(base.draft?.entries.map(item => item.id)).toEqual(['wl-02'])
  })

  it('clears the draft entirely when nothing was synced', () => {
    const base = doc({ draft: { generatedAt: 'x', entries: [entry()] } })
    discardDraft(base)
    expect(base.draft).toBeNull()
  })
})

describe('summarize', () => {
  it('reports the gap between measured and recorded', () => {
    const base = doc({
      activities: [activity('act-01', '2026-11-04T09:00:00.000+0800', 600)],
      turns: [{ turn: 3, startedAt: '2026-11-04T09:00:00.000+0800', endedAt: '2026-11-04T09:20:00.000+0800', seconds: 1200 }],
    })
    const s = summarizeDoc(base)
    expect(s.recordedSeconds).toBe(600)
    expect(s.measuredSeconds).toBe(1200)
    expect(s.gapSeconds).toBe(600)
    expect(s.activityCount).toBe(1)
    expect(s.bound).toBe(true)
  })
})
