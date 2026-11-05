/**
 * The worklog handlers — the IO half of the feature.
 *
 * Each handler takes its dependencies (the document store, the policy, a Jira
 * client) as arguments, so the panel routes, the agent tools and the tests all
 * drive the same rule set. The rules themselves (what is billable, what a
 * regeneration may replace) live in `worklog.ts` as pure functions.
 *
 * Shape of the feature, in one line: bind → record → generate → upload.
 */
import type {
  Activity,
  Draft,
  DraftEntry,
  SessionDoc,
  TurnSpan,
  WorklogPolicy,
} from './types.js'
import { KEY_RE } from './types.js'
import { formatDuration } from './jira-client.js'
import type { JiraResult } from './types.js'
import { readDoc, updateDocAndInvalidate } from './session-store.js'
import {
  deriveSeconds,
  explicitSeconds,
  instantOf,
  localTimestamp,
  activityEnd,
} from './time-policy.js'
import {
  autoEntryForTurn,
  discardDraft,
  generateDraft,
  isSettled,
  nextActivityId,
  nextEntryId,
  pendingEntries,
  summarizeDoc,
  unrecordedActivities,
  uncoveredActivities,
  type ProposedEntry,
  type WorklogSummary,
} from './worklog.js'

/** The Jira face the worklog handlers need. */
export interface WorklogJira {
  issue: (key: string) => Promise<JiraResult<any>>
  addWorklog: (
    key: string,
    opts: { seconds: number; comment?: string; started?: string },
  ) => Promise<JiraResult<any>>
  updateWorklog?: (
    key: string,
    worklogId: string,
    opts: { seconds?: number; comment?: string; started?: string },
  ) => Promise<JiraResult<any>>
}

export interface WorklogDeps {
  storeDir: string
  policy: WorklogPolicy
  jira: WorklogJira
  server: string
}

type Ok<T> = { ok: true } & T
type Fail = { ok: false; error: string }
type Result<T> = Ok<T> | Fail

/** What is left before a round may be closed, phrased for the caller. */
function unfinishedReason(doc: SessionDoc): string {
  const parts: string[] = []
  const pending = pendingEntries(doc)
  if (pending.length > 0) parts.push(`未上传草稿 ${pending.length} 条`)
  // Records no entry covers at all — a draft that covers them is already
  // reported by the line above.
  const unrecorded = unrecordedActivities(doc)
  if (unrecorded.length > 0) parts.push(`未生成的记录 ${unrecorded.length} 条`)
  return parts.join('、')
}

// --- bind / unbind ---------------------------------------------------------

export interface BindArgs {
  sessionId: string
  taskKey: string
}

/**
 * Bind one session to one issue.
 *
 * Binding the same key again is a no-op. Binding a different key starts a new
 * round, and is refused while the current round still has records that never
 * reached Jira — the alternative is losing them silently.
 */
export async function handleBind(deps: WorklogDeps, args: BindArgs): Promise<Result<{ key: string; summary: string }>> {
  const key = args.taskKey.trim().toUpperCase()
  if (!KEY_RE.test(key)) {
    return { ok: false, error: `Invalid taskKey format (expected PROJECT-123): got "${args.taskKey}"` }
  }

  const env = await deps.jira.issue(key)
  if (!env.ok) {
    return { ok: false, error: `Jira rejected ${key} (${env.error})` }
  }
  const fields = env.body?.fields ?? {}
  const summary: string = fields.summary ?? ''
  const statusName: string = fields.status?.name ?? ''

  return updateDocAndInvalidate<Result<{ key: string; summary: string }>>(deps.storeDir, args.sessionId, current => {
    if (current.binding?.key === key) {
      return { next: null, result: { ok: true as const, key, summary: current.binding.summary } }
    }
    if (current.binding !== null && !isSettled(current)) {
      return {
        next: null,
        result: {
          ok: false as const,
          error: `本 session 还绑着 ${current.binding.key}，且还有${unfinishedReason(current)}；先把这些处理完再换绑`,
        },
      }
    }
    // A settled round is complete: its work is on Jira, so the local round is
    // replaced rather than merged into the next ticket's records.
    const next: SessionDoc = {
      schemaVersion: 1,
      sessionId: args.sessionId,
      binding: {
        key,
        summary,
        statusName,
        url: `${deps.server.replace(/\/+$/, '')}/browse/${key}`,
        boundAt: new Date().toISOString(),
      },
      activities: [],
      turns: [],
      draft: null,
    }
    return { next, result: { ok: true as const, key, summary } }
  })
}

/** End the binding, dropping the settled round. Refused while work is open. */
export async function handleUnbind(deps: WorklogDeps, args: { sessionId: string }): Promise<Result<{ key: string }>> {
  return updateDocAndInvalidate<Result<{ key: string }>>(deps.storeDir, args.sessionId, current => {
    if (current.binding === null) {
      return { next: null, result: { ok: false as const, error: '本 session 未绑定 Jira issue' } }
    }
    if (!isSettled(current)) {
      return {
        next: null,
        result: {
          ok: false as const,
          error: `还有${unfinishedReason(current)}；先上传（或丢弃草稿）再解绑`,
        },
      }
    }
    const key = current.binding.key
    const next: SessionDoc = {
      schemaVersion: 1,
      sessionId: args.sessionId,
      binding: null,
      activities: [],
      turns: [],
      draft: null,
    }
    return { next, result: { ok: true as const, key } }
  })
}

// --- recording -------------------------------------------------------------

export interface RecordArgs {
  sessionId: string
  summary: string
  seconds?: number
  startedAt?: string
  /** The turn the record was made in, when the host knows it. */
  turn?: number | null
  /** Now, injectable for tests. */
  now?: number
}

/**
 * Record one piece of work.
 *
 * `seconds` omitted means "measure it": the wall clock since the previous
 * record (or since the binding), clamped by the policy. A measured interval
 * below the floor is refused rather than rounded down to nothing.
 */
export async function handleRecordActivity(
  deps: WorklogDeps,
  args: RecordArgs,
): Promise<Result<{ activity: Activity; totals: WorklogSummary }>> {
  const summary = args.summary.trim()
  if (summary === '') return { ok: false, error: 'summary 不能为空：一句话说明这次做了什么' }
  if (summary.length > 2000) return { ok: false, error: 'summary 太长（上限 2000 字符）' }
  const now = args.now ?? Date.now()

  return updateDocAndInvalidate<Result<{ activity: Activity; totals: WorklogSummary }>>(deps.storeDir, args.sessionId, current => {
    if (current.binding === null) {
      return { next: null, result: { ok: false as const, error: '本 session 未绑定 Jira issue，先绑定再记录' } }
    }

    let seconds: number
    let source: Activity['source']
    if (args.seconds !== undefined) {
      const checked = explicitSeconds(args.seconds, deps.policy)
      if (!checked.ok) return { next: null, result: { ok: false as const, error: checked.error } }
      seconds = checked.seconds
      source = 'agent'
    } else {
      const last = current.activities[current.activities.length - 1]
      const since = last !== undefined ? activityEnd(last) : Date.parse(current.binding.boundAt)
      const derived = deriveSeconds(now - since, deps.policy)
      if (derived === null) {
        return {
          next: null,
          result: {
            ok: false as const,
            error:
              `距上次记录不足 ${formatDuration(deps.policy.minSeconds)}，无法自动测量；` +
              '请给显式 seconds，或再工作一会儿',
          },
        }
      }
      seconds = derived
      source = 'derived'
    }

    let startedAt: string
    if (args.startedAt !== undefined) {
      if (instantOf(args.startedAt) === null) {
        return { next: null, result: { ok: false as const, error: 'startedAt 必须是带偏移量的 ISO 时间（如 2026-11-04T09:00:00.000+0800）' } }
      }
      startedAt = args.startedAt
    } else {
      startedAt = localTimestamp(now - seconds * 1000)
    }

    const activity: Activity = {
      id: nextActivityId(current.activities),
      summary,
      startedAt,
      seconds,
      turn: args.turn ?? null,
      source,
    }
    const next: SessionDoc = { ...current, activities: [...current.activities, activity] }
    return { next, result: { ok: true as const, activity, totals: summarizeDoc(next) } }
  })
}

// --- the end of a turn ------------------------------------------------------

export interface TurnFinishedArgs {
  sessionId: string
  turn: number
  /** Local timestamps, the shape the ledger stores. */
  startedAt: string
  endedAt: string
  /** The measured duration of the turn, in seconds. */
  seconds: number
  /** Now, injectable for tests. */
  now?: number
}

export interface TurnFinishedOutcome {
  /** The span was written: the session is bound and the turn was new. */
  measured: boolean
  /** The entry the turn produced, when it produced one. */
  entry: DraftEntry | null
}

/**
 * Close a turn: measure it, and turn it into a worklog line.
 *
 * Both halves happen in ONE write, so a turn is never half-recorded: either
 * the span and its line are both on disk, or neither is.
 *
 * The line needs no model and no conversation. The duration is a clock
 * reading, and the comment was written by the agent while it was still doing
 * the work — which is the only moment it could be written honestly. That is
 * what makes it safe to do this at the end of every turn instead of at the end
 * of the session, where the conversation may have been compacted away.
 */
export async function handleTurnFinished(
  deps: WorklogDeps,
  args: TurnFinishedArgs,
): Promise<TurnFinishedOutcome> {
  const now = args.now ?? Date.now()
  return updateDocAndInvalidate<TurnFinishedOutcome>(deps.storeDir, args.sessionId, current => {
    // Nothing is measured for an unbound session: there is no ticket to bill.
    if (current.binding === null) return { next: null, result: { measured: false, entry: null } }
    // A turn is measured once. A repeated stop signal must not bill it twice.
    if (current.turns.some(turn => turn.turn === args.turn)) {
      return { next: null, result: { measured: false, entry: null } }
    }

    const span: TurnSpan = {
      turn: args.turn,
      startedAt: args.startedAt,
      endedAt: args.endedAt,
      seconds: args.seconds,
    }
    const turns = [...current.turns, span]

    const proposal = deps.policy.autoGenerate
      ? autoEntryForTurn({ ...current, turns }, args.turn, span, deps.policy)
      : null
    if (proposal === null) {
      return { next: { ...current, turns }, result: { measured: true, entry: null } }
    }

    const entries = current.draft?.entries ?? []
    const entry: DraftEntry = {
      id: nextEntryId(entries),
      startedAt: proposal.startedAt ?? span.startedAt,
      seconds: proposal.seconds,
      comment: proposal.comment,
      activityIds: proposal.activityIds ?? [],
      state: 'draft',
      jiraId: null,
      syncedAt: null,
      error: null,
      auto: true,
    }
    const draft: Draft = {
      generatedAt: new Date(now).toISOString(),
      entries: [...entries, entry],
    }
    return {
      next: { ...current, turns, draft },
      result: { measured: true, entry },
    }
  })
}

// --- state -----------------------------------------------------------------

export interface ActivityState extends Activity {
  /** The entry that already accounts for this record, or null. */
  coveredBy: string | null
  /** Editable only while no entry covers it. */
  editable: boolean
}

export interface WorklogState extends WorklogSummary {
  activities: ActivityState[]
  /** The measured turns, oldest first. */
  turns: TurnSpan[]
  draft: DraftEntry[]
  uncoveredIds: string[]
  generatedAt: string | null
}

/** Read the whole picture of one session's round. */
export async function handleWorklogState(deps: WorklogDeps, args: { sessionId: string }): Promise<WorklogState> {
  const doc = await readDoc(deps.storeDir, args.sessionId)
  const coverOf = new Map<string, string>()
  for (const entry of doc.draft?.entries ?? []) {
    for (const id of entry.activityIds) if (!coverOf.has(id)) coverOf.set(id, entry.id)
  }
  return {
    ...summarizeDoc(doc),
    activities: doc.activities.map(activity => {
      const coveredBy = coverOf.get(activity.id) ?? null
      return { ...activity, coveredBy, editable: coveredBy === null }
    }),
    turns: doc.turns,
    draft: doc.draft?.entries ?? [],
    uncoveredIds: uncoveredActivities(doc).map(activity => activity.id),
    generatedAt: doc.draft?.generatedAt ?? null,
  }
}

// --- generation ------------------------------------------------------------

export interface GenerateArgs {
  sessionId: string
  /** null: one entry per uncovered activity, verbatim. */
  entries: ProposedEntry[] | null
  now?: number
}

/** Turn the recorded work into a draft. */
export async function handleGenerateWorklog(
  deps: WorklogDeps,
  args: GenerateArgs,
): Promise<Result<{ draft: DraftEntry[]; added: number; covered: number; recordedSeconds: number; proposedSeconds: number; deltaSeconds: number }>> {
  const now = args.now ?? Date.now()
  return updateDocAndInvalidate<Result<{ draft: DraftEntry[]; added: number; covered: number; recordedSeconds: number; proposedSeconds: number; deltaSeconds: number }>>(deps.storeDir, args.sessionId, current => {
    if (current.binding === null) {
      return { next: null, result: { ok: false as const, error: '本 session 未绑定 Jira issue' } }
    }
    const generated = generateDraft(current, args.entries, deps.policy, now)
    if (!generated.ok) return { next: null, result: { ok: false as const, error: generated.error } }
    const next: SessionDoc = { ...current, draft: generated.generated.draft }
    return {
      next,
      result: {
        ok: true as const,
        draft: generated.generated.draft.entries,
        added: generated.generated.added,
        covered: generated.generated.covered,
        recordedSeconds: generated.generated.recordedSeconds,
        proposedSeconds: generated.generated.proposedSeconds,
        deltaSeconds: generated.generated.deltaSeconds,
      },
    }
  })
}

// --- upload ----------------------------------------------------------------

export interface UploadArgs {
  sessionId: string
  /** Entry ids to upload; empty means "show me what is pending". */
  ids: string[]
}

export interface UploadOutcome {
  id: string
  ok: boolean
  jiraId?: string
  error?: string
}

/**
 * Upload the selected entries.
 *
 * An empty selection uploads nothing and reports what is pending — the caller
 * has to name what it is sending, which is the point.
 */
export async function handleUploadWorklog(
  deps: WorklogDeps,
  args: UploadArgs,
): Promise<Result<{ uploaded: UploadOutcome[]; pending: DraftEntry[]; state: WorklogSummary }>> {
  const doc = await readDoc(deps.storeDir, args.sessionId)
  if (doc.binding === null) return { ok: false, error: '本 session 未绑定 Jira issue' }

  const wanted = args.ids.map(String).filter(id => id !== '')
  if (wanted.length === 0) {
    return {
      ok: false,
      error:
        `未指定要上传的条目；当前待传：${pendingEntries(doc).map(entry => entry.id).join(', ') || '（无）'}`,
    }
  }

  const byId = new Map((doc.draft?.entries ?? []).map(entry => [entry.id, entry]))
  const unknown = wanted.filter(id => !byId.has(id))
  if (unknown.length > 0) return { ok: false, error: `未知条目：${unknown.join(', ')}` }
  const synced = wanted.filter(id => byId.get(id)!.state === 'synced')
  if (synced.length > 0) return { ok: false, error: `已上传过的条目不能重复上传：${synced.join(', ')}` }

  const binding = doc.binding
  const uploaded: UploadOutcome[] = []
  for (const id of wanted) {
    const entry = byId.get(id)!
    const created = await deps.jira.addWorklog(binding.key, {
      seconds: entry.seconds,
      comment: entry.comment,
      started: entry.startedAt,
    })
    const jiraId = created.ok ? String(created.body?.id ?? '') : ''
    const failed = !created.ok
      ? `Jira rejected (${created.error}${created.detail !== undefined ? `: ${created.detail}` : ''})`
      : jiraId === ''
        ? 'Jira created the worklog but returned no id'
        : null

    await updateDocAndInvalidate<null>(deps.storeDir, args.sessionId, current => {
      const draft = current.draft
      if (draft === null) return { next: null, result: null }
      const entries = draft.entries.map(item => item.id !== id ? item : {
        ...item,
        state: failed === null ? 'synced' as const : 'failed' as const,
        jiraId: failed === null ? jiraId : item.jiraId,
        syncedAt: failed === null ? new Date().toISOString() : item.syncedAt,
        error: failed,
      })
      return { next: { ...current, draft: { ...draft, entries } }, result: null }
    })
    uploaded.push(
      failed === null
        ? { id, ok: true, jiraId }
        : { id, ok: false, error: failed },
    )
  }

  const after = await readDoc(deps.storeDir, args.sessionId)
  return {
    ok: true,
    uploaded,
    pending: pendingEntries(after),
    state: summarizeDoc(after),
  }
}

// --- panel-side edits ------------------------------------------------------

export interface EditArgs {
  sessionId: string
  id: string
  seconds?: number
  comment?: string
  startedAt?: string
}

/** Edit one entry that has not reached Jira yet. */
export async function handleEditDraft(
  deps: WorklogDeps,
  args: EditArgs,
): Promise<Result<{ entry: DraftEntry }>> {
  const doc = await readDoc(deps.storeDir, args.sessionId)
  const target = (doc.draft?.entries ?? []).find(item => item.id === args.id)
  if (target === undefined) {
    return { ok: false, error: doc.draft === null ? '还没有生成 worklog 草稿' : `未知条目 ${args.id}` }
  }
  if (args.seconds !== undefined) {
    const checked = explicitSeconds(args.seconds, deps.policy)
    if (!checked.ok) return { ok: false, error: checked.error }
  }
  if (args.startedAt !== undefined && instantOf(args.startedAt) === null) {
    return { ok: false, error: 'startedAt 必须是带偏移量的 ISO 时间' }
  }

  // A synced entry lives on the tracker. Push the edit there FIRST, and apply
  // it locally only when Jira accepted it — the panel must never show a value
  // the tracker does not have.
  if (target.state === 'synced') {
    if (doc.binding === null) return { ok: false, error: '本 session 未绑定 Jira issue' }
    if (target.jiraId === null) return { ok: false, error: `条目 ${target.id} 没有 Jira id，无法同步修改` }
    if (deps.jira.updateWorklog === undefined) {
      return { ok: false, error: '这个 Jira 客户端不支持修改已上传的工时' }
    }
    const pushed = await deps.jira.updateWorklog(doc.binding.key, target.jiraId, {
      ...(args.seconds !== undefined ? { seconds: Math.round(args.seconds) } : {}),
      ...(args.comment !== undefined && args.comment.trim() !== '' ? { comment: args.comment.trim() } : {}),
      ...(args.startedAt !== undefined ? { started: args.startedAt } : {}),
    })
    if (!pushed.ok) {
      return { ok: false, error: `Jira 拒绝了这次修改（${pushed.error}${pushed.detail !== undefined ? `: ${pushed.detail}` : ''}），本地未改动` }
    }
  }

  return updateDocAndInvalidate<Result<{ entry: DraftEntry }>>(deps.storeDir, args.sessionId, current => {
    if (current.draft === null) return { next: null, result: { ok: false as const, error: '还没有生成 worklog 草稿' } }
    const entry = current.draft.entries.find(item => item.id === args.id)
    if (entry === undefined) return { next: null, result: { ok: false as const, error: `未知条目 ${args.id}` } }
    if (args.seconds !== undefined) {
      const checked = explicitSeconds(args.seconds, deps.policy)
      if (!checked.ok) return { next: null, result: { ok: false as const, error: checked.error } }
    }
    if (args.startedAt !== undefined && instantOf(args.startedAt) === null) {
      return { next: null, result: { ok: false as const, error: 'startedAt 必须是带偏移量的 ISO 时间' } }
    }
    const entries = current.draft.entries.map(item => item.id !== args.id ? item : {
      ...item,
      seconds: args.seconds !== undefined ? Math.round(args.seconds) : item.seconds,
      comment: args.comment !== undefined ? args.comment.trim() || item.comment : item.comment,
      startedAt: args.startedAt !== undefined ? args.startedAt : item.startedAt,
    })
    const edited = entries.find(item => item.id === args.id)!
    return {
      next: { ...current, draft: { ...current.draft, entries } },
      result: { ok: true as const, entry: edited },
    }
  })
}

export interface EditActivityArgs {
  sessionId: string
  id: string
  summary?: string
  seconds?: number
  startedAt?: string
}

/**
 * Correct one recorded activity.
 *
 * Only while nothing accounts for it yet: once an entry covers the record, the
 * draft is the thing to edit — changing the record under a generated entry
 * would leave the two disagreeing with no way to tell which is right.
 */
export async function handleEditActivity(
  deps: WorklogDeps,
  args: EditActivityArgs,
): Promise<Result<{ activity: Activity }>> {
  if (args.summary !== undefined && args.summary.trim() === '') {
    return { ok: false, error: 'summary 不能为空' }
  }
  if (args.seconds !== undefined) {
    const checked = explicitSeconds(args.seconds, deps.policy)
    if (!checked.ok) return { ok: false, error: checked.error }
  }
  if (args.startedAt !== undefined && instantOf(args.startedAt) === null) {
    return { ok: false, error: 'startedAt 必须是带偏移量的 ISO 时间' }
  }
  return updateDocAndInvalidate<Result<{ activity: Activity }>>(deps.storeDir, args.sessionId, current => {
    const activity = current.activities.find(item => item.id === args.id)
    if (activity === undefined) return { next: null, result: { ok: false as const, error: `未知记录 ${args.id}` } }
    const cover = (current.draft?.entries ?? []).find(entry => entry.activityIds.includes(args.id))
    if (cover !== undefined) {
      return {
        next: null,
        result: {
          ok: false as const,
          error: `这条记录已经生成到草稿 ${cover.id}${cover.state === 'synced' ? '（且已上传 Jira）' : ''}，请直接改草稿条目`,
        },
      }
    }
    const edited: Activity = {
      ...activity,
      summary: args.summary !== undefined ? args.summary.trim() : activity.summary,
      seconds: args.seconds !== undefined ? Math.round(args.seconds) : activity.seconds,
      startedAt: args.startedAt !== undefined ? args.startedAt : activity.startedAt,
      // A corrected duration is the caller's number now, not a measurement.
      source: args.seconds !== undefined ? 'agent' : activity.source,
    }
    return {
      next: {
        ...current,
        activities: current.activities.map(item => item.id === args.id ? edited : item),
      },
      result: { ok: true as const, activity: edited },
    }
  })
}

/**
 * Drop one draft entry.
 *
 * Only while it is still a draft: a synced entry lives on the tracker, and
 * the way to remove that is Jira, not here. This exists because the automatic
 * line makes one entry per turn, and a reader who disagrees with one of them
 * should not have to discard the whole round.
 */
export async function handleDeleteDraftEntry(
  deps: WorklogDeps,
  args: { sessionId: string; id: string },
): Promise<Result<{ removed: DraftEntry }>> {
  return updateDocAndInvalidate<Result<{ removed: DraftEntry }>>(deps.storeDir, args.sessionId, current => {
    if (current.draft === null) return { next: null, result: { ok: false as const, error: '还没有生成 worklog 草稿' } }
    const entry = current.draft.entries.find(item => item.id === args.id)
    if (entry === undefined) return { next: null, result: { ok: false as const, error: `未知条目 ${args.id}` } }
    if (entry.state === 'synced') {
      return { next: null, result: { ok: false as const, error: '该条已上传 Jira，本地不能删；要删请到 Jira 侧处理' } }
    }
    const entries = current.draft.entries.filter(item => item.id !== args.id)
    const draft = entries.length === 0 ? null : { ...current.draft, entries }
    return {
      next: { ...current, draft },
      result: { ok: true as const, removed: entry },
    }
  })
}

/** Remove one recorded activity, under the same rule as editing it. */
export async function handleDeleteActivity(
  deps: WorklogDeps,
  args: { sessionId: string; id: string },
): Promise<Result<{ removed: Activity }>> {
  return updateDocAndInvalidate<Result<{ removed: Activity }>>(deps.storeDir, args.sessionId, current => {
    const activity = current.activities.find(item => item.id === args.id)
    if (activity === undefined) return { next: null, result: { ok: false as const, error: `未知记录 ${args.id}` } }
    const cover = (current.draft?.entries ?? []).find(entry => entry.activityIds.includes(args.id))
    if (cover !== undefined) {
      return {
        next: null,
        result: {
          ok: false as const,
          error: `这条记录已经生成到草稿 ${cover.id}，请先在草稿里丢弃它`,
        },
      }
    }
    return {
      next: { ...current, activities: current.activities.filter(item => item.id !== args.id) },
      result: { ok: true as const, removed: activity },
    }
  })
}

/** Throw away the drafts; what already reached Jira stays. */
export async function handleDiscardWorklog(
  deps: WorklogDeps,
  args: { sessionId: string },
): Promise<Result<{ removed: number; kept: number }>> {
  return updateDocAndInvalidate<Result<{ removed: number; kept: number }>>(deps.storeDir, args.sessionId, current => {
    if (current.draft === null) return { next: null, result: { ok: true as const, removed: 0, kept: 0 } }
    const next: SessionDoc = { ...current, draft: current.draft }
    const { removed, kept } = discardDraft(next)
    return { next, result: { ok: true as const, removed, kept } }
  })
}
