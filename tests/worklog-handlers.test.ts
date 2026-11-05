import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  handleBind,
  handleDeleteActivity,
  handleDiscardWorklog,
  handleEditActivity,
  handleEditDraft,
  handleGenerateWorklog,
  handleRecordActivity,
  handleUnbind,
  handleUploadWorklog,
  handleWorklogState,
  type WorklogDeps,
  type WorklogJira,
} from '../src/worklog-handlers.js'
import { readDoc } from '../src/session-store.js'
import { DEFAULT_WORKLOG_POLICY } from '../src/types.js'

let dir: string
const SESSION = 'session-test'

/** A Jira that records what it was asked to do. */
function makeJira(over: Partial<WorklogJira> & { addWorklogResult?: any; updateWorklogResult?: any } = {}) {
  const calls: Array<{ key: string; opts: any }> = []
  const updates: Array<{ key: string; id: string; opts: any }> = []
  const jira: WorklogJira = {
    issue: over.issue ?? (async (key: string) => ({
      ok: true as const,
      body: { key, fields: { summary: 'The issue', status: { name: 'RD Develop' } } },
    })),
    addWorklog: over.addWorklog ?? (async (key: string, opts: any) => {
      calls.push({ key, opts })
      return over.addWorklogResult ?? { ok: true as const, body: { id: `jira-${calls.length}` } }
    }),
    updateWorklog: over.updateWorklog ?? (async (key: string, id: string, opts: any) => {
      updates.push({ key, id, opts })
      return over.updateWorklogResult ?? { ok: true as const, body: { id } }
    }),
  }
  return { jira, calls, updates }
}

function deps(jira: WorklogJira): WorklogDeps {
  return { storeDir: dir, policy: DEFAULT_WORKLOG_POLICY, jira, server: 'https://jiratest.example.com' }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'scjira-wl-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function bound() {
  const { jira } = makeJira()
  const r = await handleBind(deps(jira), { sessionId: SESSION, taskKey: 'DZ300-797' })
  expect(r.ok).toBe(true)
  return deps(jira)
}

describe('bind', () => {
  it('captures the issue facts', async () => {
    const d = await bound()
    const state = await handleWorklogState(d, { sessionId: SESSION })
    expect(state.bound).toBe(true)
    expect(state.key).toBe('DZ300-797')
    expect(state.summary).toBe('The issue')
    expect(state.statusName).toBe('RD Develop')
    expect(state.url).toContain('/browse/DZ300-797')
  })

  it('is idempotent for the same key', async () => {
    const d = await bound()
    const again = await handleBind(d, { sessionId: SESSION, taskKey: 'DZ300-797' })
    expect(again.ok).toBe(true)
  })

  it('refuses a malformed key before calling Jira', async () => {
    const { jira, calls } = makeJira()
    const r = await handleBind(deps(jira), { sessionId: SESSION, taskKey: 'not-a-key' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain('format')
    expect(calls).toHaveLength(0)
  })

  it('reports a Jira rejection', async () => {
    const { jira } = makeJira({ issue: async () => ({ ok: false as const, error: 'http' as const }) })
    const r = await handleBind(deps(jira), { sessionId: SESSION, taskKey: 'DZ300-999' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain('rejected')
  })

  it('refuses to switch tickets while records are unbilled', async () => {
    const d = await bound()
    await handleRecordActivity(d, { sessionId: SESSION, summary: 'did a thing', seconds: 600 })
    const r = await handleBind(d, { sessionId: SESSION, taskKey: 'DZ300-1234' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain('未生成')
  })

  it('switches tickets once the round is settled, starting a clean round', async () => {
    const d = await bound()
    await handleRecordActivity(d, { sessionId: SESSION, summary: 'did a thing', seconds: 600 })
    await handleGenerateWorklog(d, { sessionId: SESSION, entries: null })
    await handleUploadWorklog(d, { sessionId: SESSION, ids: ['wl-01'] })

    const r = await handleBind(d, { sessionId: SESSION, taskKey: 'DZ300-1234' })
    expect(r.ok).toBe(true)
    const doc = await readDoc(dir, SESSION)
    expect(doc.binding?.key).toBe('DZ300-1234')
    expect(doc.activities).toEqual([])
    expect(doc.draft).toBeNull()
  })
})

describe('unbind', () => {
  it('refuses an unbound session', async () => {
    const { jira } = makeJira()
    const r = await handleUnbind(deps(jira), { sessionId: SESSION })
    expect(r.ok).toBe(false)
  })

  it('refuses while a draft is pending', async () => {
    const d = await bound()
    await handleRecordActivity(d, { sessionId: SESSION, summary: 'x', seconds: 600 })
    await handleGenerateWorklog(d, { sessionId: SESSION, entries: null })
    const r = await handleUnbind(d, { sessionId: SESSION })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain('未上传')
  })

  it('names the pending draft, not the activities it already covers', async () => {
    const d = await bound()
    await handleRecordActivity(d, { sessionId: SESSION, summary: 'x', seconds: 600 })
    await handleGenerateWorklog(d, { sessionId: SESSION, entries: null })
    const r = await handleUnbind(d, { sessionId: SESSION })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain('未上传草稿 1 条')
    expect(r.error).not.toContain('未生成的记录')
  })

  it('refuses while a record was never generated', async () => {
    const d = await bound()
    await handleRecordActivity(d, { sessionId: SESSION, summary: 'x', seconds: 600 })
    const r = await handleUnbind(d, { sessionId: SESSION })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain('未生成')
  })

  it('ends a settled round and clears the document', async () => {
    const d = await bound()
    await handleRecordActivity(d, { sessionId: SESSION, summary: 'x', seconds: 600 })
    await handleGenerateWorklog(d, { sessionId: SESSION, entries: null })
    await handleUploadWorklog(d, { sessionId: SESSION, ids: ['wl-01'] })
    const r = await handleUnbind(d, { sessionId: SESSION })
    expect(r.ok).toBe(true)
    const state = await handleWorklogState(d, { sessionId: SESSION })
    expect(state.bound).toBe(false)
    expect(state.activityCount).toBe(0)
  })
})

describe('record', () => {
  it('refuses when unbound', async () => {
    const { jira } = makeJira()
    const r = await handleRecordActivity(deps(jira), { sessionId: SESSION, summary: 'x', seconds: 60 })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain('未绑定')
  })

  it('keeps an explicit duration without rounding it', async () => {
    const d = await bound()
    const r = await handleRecordActivity(d, { sessionId: SESSION, summary: 'did a thing', seconds: 61 })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.activity.seconds).toBe(61)
    expect(r.activity.source).toBe('agent')
    expect(r.activity.id).toBe('act-01')
  })

  it('measures from the previous record when no duration is given', async () => {
    const d = await bound()
    const first = await handleRecordActivity(d, {
      sessionId: SESSION,
      summary: 'first',
      seconds: 600,
      startedAt: '2026-11-04T09:00:00.000+0800',
      now: Date.UTC(2026, 10, 4, 1, 10, 0),
    })
    expect(first.ok).toBe(true)
    // Ten minutes after the first record ended: derived and rounded up.
    const start = Date.parse('2026-11-04T09:00:00.000+0800')
    const second = await handleRecordActivity(d, {
      sessionId: SESSION,
      summary: 'second',
      now: start + 600_000 + 61_000,
    })
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.activity.source).toBe('derived')
    expect(second.activity.seconds).toBe(120)
  })

  it('refuses a measured interval below the floor, with a usable message', async () => {
    const d = await bound()
    const start = Date.parse('2026-11-04T09:00:00.000+0800')
    await handleRecordActivity(d, { sessionId: SESSION, summary: 'first', seconds: 600, startedAt: '2026-11-04T09:00:00.000+0800' })
    const r = await handleRecordActivity(d, { sessionId: SESSION, summary: 'too soon', now: start + 600_000 + 5_000 })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain('1m')
    expect(r.error).toContain('seconds')
  })

  it('derives startedAt from the duration when omitted', async () => {
    const d = await bound()
    const now = Date.parse('2026-11-04T10:00:00.000+0800')
    const r = await handleRecordActivity(d, { sessionId: SESSION, summary: 'x', seconds: 600, now })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.activity.startedAt).toBe('2026-11-04T09:50:00.000+0800')
  })

  it('refuses a startedAt with no offset', async () => {
    const d = await bound()
    const r = await handleRecordActivity(d, { sessionId: SESSION, summary: 'x', seconds: 60, startedAt: '2026-11-04T09:00:00' })
    expect(r.ok).toBe(false)
  })

  it('refuses an empty summary', async () => {
    const d = await bound()
    const r = await handleRecordActivity(d, { sessionId: SESSION, summary: '   ', seconds: 60 })
    expect(r.ok).toBe(false)
  })

  it('carries the turn it was made in', async () => {
    const d = await bound()
    const r = await handleRecordActivity(d, { sessionId: SESSION, summary: 'x', seconds: 60, turn: 7 })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.activity.turn).toBe(7)
  })
})

describe('generate and upload', () => {
  async function recorded() {
    const d = await bound()
    await handleRecordActivity(d, { sessionId: SESSION, summary: 'read the registers', seconds: 600, startedAt: '2026-11-04T09:00:00.000+0800' })
    await handleRecordActivity(d, { sessionId: SESSION, summary: 'find the panic', seconds: 900, startedAt: '2026-11-04T10:00:00.000+0800' })
    return d
  }

  it('uploads only the selected entries and records the Jira id', async () => {
    const { jira, calls } = makeJira()
    const d = deps(jira)
    await handleBind(d, { sessionId: SESSION, taskKey: 'DZ300-797' })
    await handleRecordActivity(d, { sessionId: SESSION, summary: 'a', seconds: 600, startedAt: '2026-11-04T09:00:00.000+0800' })
    await handleGenerateWorklog(d, { sessionId: SESSION, entries: null })
    const r = await handleUploadWorklog(d, { sessionId: SESSION, ids: ['wl-01'] })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(calls).toHaveLength(1)
    expect(calls[0]?.key).toBe('DZ300-797')
    expect(calls[0]?.opts).toEqual({ seconds: 600, comment: 'a', started: '2026-11-04T09:00:00.000+0800' })

    const state = await handleWorklogState(d, { sessionId: SESSION })
    expect(state.syncedCount).toBe(1)
    expect(state.draft[0]?.state).toBe('synced')
    expect(state.draft[0]?.jiraId).toBe('jira-1')
  })

  it('an empty selection uploads nothing and reports what is pending', async () => {
    const d = await recorded()
    await handleGenerateWorklog(d, { sessionId: SESSION, entries: null })
    const { jira, calls } = makeJira()
    const r = await handleUploadWorklog(deps(jira), { sessionId: SESSION, ids: [] })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain('wl-01')
    expect(calls).toHaveLength(0)
  })

  it('marks a rejected upload as failed and keeps it retryable', async () => {
    const d = await bound()
    await handleRecordActivity(d, { sessionId: SESSION, summary: 'a', seconds: 600 })
    await handleGenerateWorklog(d, { sessionId: SESSION, entries: null })
    const { jira } = makeJira({ addWorklog: async () => ({ ok: false as const, error: 'http' as const, detail: 'boom' }) })
    const r = await handleUploadWorklog(deps(jira), { sessionId: SESSION, ids: ['wl-01'] })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.uploaded[0]).toMatchObject({ id: 'wl-01', ok: false })
    const state = await handleWorklogState(d, { sessionId: SESSION })
    expect(state.failedCount).toBe(1)
    expect(state.draft[0]?.error).toContain('boom')
  })

  it('refuses to upload a synced entry twice', async () => {
    const d = await recorded()
    await handleGenerateWorklog(d, { sessionId: SESSION, entries: null })
    await handleUploadWorklog(d, { sessionId: SESSION, ids: ['wl-01'] })
    const r = await handleUploadWorklog(d, { sessionId: SESSION, ids: ['wl-01'] })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain('已上传')
  })

  it('refuses an unknown id', async () => {
    const d = await recorded()
    await handleGenerateWorklog(d, { sessionId: SESSION, entries: null })
    const r = await handleUploadWorklog(d, { sessionId: SESSION, ids: ['wl-99'] })
    expect(r.ok).toBe(false)
  })

  it('does not offer an activity again after its entry reached Jira', async () => {
    const d = await recorded()
    await handleGenerateWorklog(d, { sessionId: SESSION, entries: null })
    await handleUploadWorklog(d, { sessionId: SESSION, ids: ['wl-01', 'wl-02'] })
    const again = await handleGenerateWorklog(d, { sessionId: SESSION, entries: null })
    expect(again.ok).toBe(false)
    if (again.ok) return
    expect(again.error).toContain('没有新的活动')
  })
})

describe('raw record edits', () => {
  it('corrects an uncovered record', async () => {
    const d = await bound()
    await handleRecordActivity(d, { sessionId: SESSION, summary: 'wrong', seconds: 600, startedAt: '2026-11-04T09:00:00.000+0800' })
    const r = await handleEditActivity(d, { sessionId: SESSION, id: 'act-01', summary: 'right', seconds: 900, startedAt: '2026-11-04T08:30:00.000+0800' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.activity).toMatchObject({ summary: 'right', seconds: 900, startedAt: '2026-11-04T08:30:00.000+0800' })
    const state = await handleWorklogState(d, { sessionId: SESSION })
    expect(state.activities[0]).toMatchObject({ editable: true, coveredBy: null })
  })

  it('refuses once an entry covers the record, and points at the entry', async () => {
    const d = await bound()
    await handleRecordActivity(d, { sessionId: SESSION, summary: 'a', seconds: 600 })
    await handleGenerateWorklog(d, { sessionId: SESSION, entries: null })
    const r = await handleEditActivity(d, { sessionId: SESSION, id: 'act-01', seconds: 900 })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain('wl-01')
    const state = await handleWorklogState(d, { sessionId: SESSION })
    expect(state.activities[0]).toMatchObject({ editable: false, coveredBy: 'wl-01' })
  })

  it('deletes an uncovered record and keeps a covered one', async () => {
    const d = await bound()
    await handleRecordActivity(d, { sessionId: SESSION, summary: 'a', seconds: 600, startedAt: '2026-11-04T09:00:00.000+0800' })
    await handleRecordActivity(d, { sessionId: SESSION, summary: 'b', seconds: 900, startedAt: '2026-11-04T10:00:00.000+0800' })
    const merged = await handleGenerateWorklog(d, {
      sessionId: SESSION,
      entries: [{ seconds: 600, comment: 'only a', activityIds: ['act-01'] }],
    })
    // The proposal leaves act-02 unbilled, so it is refused: generate covers
    // everything before anything is considered deletable.
    expect(merged.ok).toBe(false)

    const del = await handleDeleteActivity(d, { sessionId: SESSION, id: 'act-02' })
    expect(del.ok).toBe(true)
    const state = await handleWorklogState(d, { sessionId: SESSION })
    expect(state.activities.map(item => item.id)).toEqual(['act-01'])
  })

  it('refuses to delete a record a draft already counts', async () => {
    const d = await bound()
    await handleRecordActivity(d, { sessionId: SESSION, summary: 'a', seconds: 600 })
    await handleGenerateWorklog(d, { sessionId: SESSION, entries: null })
    const r = await handleDeleteActivity(d, { sessionId: SESSION, id: 'act-01' })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain('草稿')
  })

  it('rejects an invalid duration or an empty summary', async () => {
    const d = await bound()
    await handleRecordActivity(d, { sessionId: SESSION, summary: 'a', seconds: 600 })
    expect((await handleEditActivity(d, { sessionId: SESSION, id: 'act-01', seconds: 0 })).ok).toBe(false)
    expect((await handleEditActivity(d, { sessionId: SESSION, id: 'act-01', summary: '  ' })).ok).toBe(false)
    expect((await handleEditActivity(d, { sessionId: SESSION, id: 'act-01', startedAt: '2026-11-04T09:00:00' })).ok).toBe(false)
  })
})

describe('panel-side edits', () => {
  it('edits a draft entry', async () => {
    const d = await bound()
    await handleRecordActivity(d, { sessionId: SESSION, summary: 'a', seconds: 600 })
    await handleGenerateWorklog(d, { sessionId: SESSION, entries: null })
    const r = await handleEditDraft(d, { sessionId: SESSION, id: 'wl-01', seconds: 1200, comment: 'rewritten' })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.entry.seconds).toBe(1200)
    expect(r.entry.comment).toBe('rewritten')
  })

  it('pushes an edit of a synced entry to Jira, then applies it', async () => {
    const { jira, updates } = makeJira()
    const d = deps(jira)
    await handleBind(d, { sessionId: SESSION, taskKey: 'DZ300-797' })
    await handleRecordActivity(d, { sessionId: SESSION, summary: 'a', seconds: 600 })
    await handleGenerateWorklog(d, { sessionId: SESSION, entries: null })
    await handleUploadWorklog(d, { sessionId: SESSION, ids: ['wl-01'] })

    const r = await handleEditDraft(d, { sessionId: SESSION, id: 'wl-01', seconds: 1800, comment: 'rewritten' })
    expect(r.ok).toBe(true)
    expect(updates).toHaveLength(1)
    expect(updates[0]).toMatchObject({ key: 'DZ300-797', id: 'jira-1', opts: { seconds: 1800, comment: 'rewritten' } })
    const state = await handleWorklogState(d, { sessionId: SESSION })
    expect(state.draft[0]?.seconds).toBe(1800)
    expect(state.draft[0]?.comment).toBe('rewritten')
  })

  it('leaves the local entry alone when Jira rejects the edit', async () => {
    const { jira } = makeJira({ updateWorklog: async () => ({ ok: false as const, error: 'http' as const, detail: 'nope' }) })
    const d = deps(jira)
    await handleBind(d, { sessionId: SESSION, taskKey: 'DZ300-797' })
    await handleRecordActivity(d, { sessionId: SESSION, summary: 'a', seconds: 600 })
    await handleGenerateWorklog(d, { sessionId: SESSION, entries: null })
    await handleUploadWorklog(d, { sessionId: SESSION, ids: ['wl-01'] })

    const r = await handleEditDraft(d, { sessionId: SESSION, id: 'wl-01', seconds: 1800 })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.error).toContain('本地未改动')
    const state = await handleWorklogState(d, { sessionId: SESSION })
    expect(state.draft[0]?.seconds).toBe(600)
  })

  it('discards the drafts and keeps the synced entries', async () => {
    const d = await bound()
    await handleRecordActivity(d, { sessionId: SESSION, summary: 'a', seconds: 600, startedAt: '2026-11-04T09:00:00.000+0800' })
    await handleRecordActivity(d, { sessionId: SESSION, summary: 'b', seconds: 900, startedAt: '2026-11-04T10:00:00.000+0800' })
    await handleGenerateWorklog(d, { sessionId: SESSION, entries: null })
    await handleUploadWorklog(d, { sessionId: SESSION, ids: ['wl-01'] })
    const r = await handleDiscardWorklog(d, { sessionId: SESSION })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.removed).toBe(1)
    expect(r.kept).toBe(1)
    const state = await handleWorklogState(d, { sessionId: SESSION })
    expect(state.draft.map(entry => entry.id)).toEqual(['wl-01'])
    expect(state.uncoveredCount).toBe(1)
  })
})
