/**
 * Turning records into a worklog draft — the pure half.
 *
 * Everything here is a function of the session document and a proposal, so
 * the rules that matter (what is already billed, what a regeneration may
 * replace, how the totals are checked) are testable without a file or a Jira
 * server.
 *
 * The one rule that shapes all the others: **a synced entry is final**.
 * Regeneration replaces drafts, never uploads; activities already accounted
 * for by a synced entry are never offered again, so the same hour cannot be
 * billed twice.
 */
import type {
  Activity,
  Draft,
  DraftEntry,
  SessionDoc,
  TurnSpan,
  WorklogPolicy,
} from './types.js'
import { deriveSeconds, explicitSeconds, instantOf, localTimestamp } from './time-policy.js'

/** Activities no synced entry accounts for. */
export function uncoveredActivities(doc: SessionDoc): Activity[] {
  const covered = new Set<string>()
  for (const entry of doc.draft?.entries ?? []) {
    if (entry.state !== 'synced') continue
    for (const id of entry.activityIds) covered.add(id)
  }
  return doc.activities.filter(activity => !covered.has(activity.id))
}

/**
 * Activities no entry at all accounts for — not even a draft.
 *
 * Different from {@link uncoveredActivities}: an activity covered by a draft
 * still has to be billed, but it has already been turned into an entry, so a
 * message about it belongs to the pending-draft sentence rather than the
 * not-yet-generated one.
 */
export function unrecordedActivities(doc: SessionDoc): Activity[] {
  const covered = new Set<string>()
  for (const entry of doc.draft?.entries ?? []) {
    for (const id of entry.activityIds) covered.add(id)
  }
  return doc.activities.filter(activity => !covered.has(activity.id))
}

/** Draft entries that have not reached Jira. */
export function pendingEntries(doc: SessionDoc): DraftEntry[] {
  return (doc.draft?.entries ?? []).filter(entry => entry.state !== 'synced')
}

/**
 * Whether the round is finished: everything recorded has been billed, and
 * nothing is waiting to be uploaded.
 *
 * Unbinding and rebinding are refused while this is false, so a session
 * cannot walk away from records that never reached the tracker.
 */
export function isSettled(doc: SessionDoc): boolean {
  return pendingEntries(doc).length === 0 && uncoveredActivities(doc).length === 0
}

/** Next `act-NN` id, monotonic within one document. */
export function nextActivityId(activities: readonly Activity[]): string {
  let max = 0
  for (const activity of activities) {
    const m = /^act-(\d+)$/.exec(activity.id)
    if (m?.[1] !== undefined) max = Math.max(max, Number.parseInt(m[1], 10))
  }
  return `act-${String(max + 1).padStart(2, '0')}`
}

/** Next `wl-NN` id, counting synced entries so ids are never reused. */
export function nextEntryId(entries: readonly DraftEntry[]): string {
  let max = 0
  for (const entry of entries) {
    const m = /^wl-(\d+)$/.exec(entry.id)
    if (m?.[1] !== undefined) max = Math.max(max, Number.parseInt(m[1], 10))
  }
  return `wl-${String(max + 1).padStart(2, '0')}`
}

/** One entry the agent proposed, before it is given an id and a state. */
export interface ProposedEntry {
  seconds: number
  comment: string
  startedAt?: string
  activityIds?: string[]
}

/** What one generation did, for the caller to report and check. */
export interface GeneratedDraft {
  draft: Draft
  /** Entries created by this call. */
  added: number
  /** Activities turned into entries. */
  covered: number
  /** Seconds the covered activities recorded. */
  recordedSeconds: number
  /** Seconds the new entries claim. */
  proposedSeconds: number
  /** `proposedSeconds - recordedSeconds`; non-zero means the two disagree. */
  deltaSeconds: number
}

export type GenerateResult =
  | { ok: true; generated: GeneratedDraft }
  | { ok: false; error: string }

/**
 * Build the draft for the activities that are not billed yet.
 *
 * Without a proposal every uncovered activity becomes one entry, verbatim:
 * deterministic, and it cannot invent a duration. With a proposal the agent
 * groups and words the work — the numbers are then checked, and a mismatch is
 * reported rather than silently accepted or silently refused.
 */
export function generateDraft(
  doc: SessionDoc,
  proposal: readonly ProposedEntry[] | null,
  policy: WorklogPolicy,
  now: number,
): GenerateResult {
  const uncovered = uncoveredActivities(doc)
  const unrecorded = unrecordedActivities(doc)
  const synced = (doc.draft?.entries ?? []).filter(entry => entry.state === 'synced')

  if (uncovered.length === 0 && (proposal === null || proposal.length === 0)) {
    return { ok: false, error: '没有新的活动需要生成；先记录工作，或给出一条补录条目' }
  }

  const known = new Map(uncovered.map(activity => [activity.id, activity]))
  const covers = new Map<string, number>()

  const created: Omit<DraftEntry, 'id'>[] = []

  if (proposal === null) {
    for (const activity of uncovered) {
      created.push({
        startedAt: activity.startedAt,
        seconds: activity.seconds,
        comment: activity.summary,
        activityIds: [activity.id],
        state: 'draft',
        jiraId: null,
        syncedAt: null,
        error: null,
      })
      covers.set(activity.id, (covers.get(activity.id) ?? 0) + 1)
    }
  } else {
    if (proposal.length === 0) {
      return { ok: false, error: 'entries 为空；不传该参数表示按活动逐条生成' }
    }
    for (const [index, raw] of proposal.entries()) {
      const where = `entries[${index}]`
      const checked = explicitSeconds(raw.seconds, policy)
      if (!checked.ok) return { ok: false, error: `${where}.seconds: ${checked.error}` }
      const comment = typeof raw.comment === 'string' ? raw.comment.trim() : ''
      if (comment === '') return { ok: false, error: `${where}.comment is empty` }

      const ids = Array.isArray(raw.activityIds) ? raw.activityIds.map(String) : []
      for (const id of ids) {
        if (!known.has(id)) {
          return {
            ok: false,
            error: `${where}.activityIds names "${id}", which is not an uncovered activity of this session`,
          }
        }
        covers.set(id, (covers.get(id) ?? 0) + 1)
      }

      let startedAt: string
      if (raw.startedAt !== undefined) {
        if (instantOf(raw.startedAt) === null) {
          return { ok: false, error: `${where}.startedAt is not an ISO instant with an offset` }
        }
        startedAt = raw.startedAt
      } else if (ids.length > 0) {
        // The earliest activity this entry accounts for is when the work began.
        const starts = ids.map(id => instantOf(known.get(id)!.startedAt) ?? now)
        startedAt = localTimestamp(Math.min(...starts))
      } else {
        startedAt = localTimestamp(now - checked.seconds * 1000)
      }

      created.push({
        startedAt,
        seconds: checked.seconds,
        comment,
        activityIds: ids,
        state: 'draft',
        jiraId: null,
        syncedAt: null,
        error: null,
      })
    }

    const missing = uncovered.filter(activity => (covers.get(activity.id) ?? 0) === 0)
    if (missing.length > 0) {
      return {
        ok: false,
        error:
          'proposal leaves activities unbilled: ' +
          missing.map(activity => `${activity.id} (${activity.summary})`).join(', ') +
          '; every uncovered activity must be covered exactly once',
      }
    }
  }

  const duplicated = [...covers.entries()].filter(([, count]) => count > 1)
  if (duplicated.length > 0) {
    return {
      ok: false,
      error:
        'proposal bills the same activity more than once: ' +
        duplicated.map(([id]) => id).join(', '),
    }
  }

  // Ids continue past every entry this document has ever had, so a synced id
  // is never reused by a regenerated draft.
  const allEntries = doc.draft?.entries ?? []
  const firstId = Number.parseInt(nextEntryId(allEntries).slice(3), 10)
  const entries: DraftEntry[] = created.map((entry, index) => ({
    ...entry,
    id: `wl-${String(firstId + index).padStart(2, '0')}`,
  }))
  entries.sort((left, right) => (instantOf(left.startedAt) ?? 0) - (instantOf(right.startedAt) ?? 0))

  const recordedSeconds = uncovered.reduce((sum, activity) => sum + activity.seconds, 0)
  const proposedSeconds = entries.reduce((sum, entry) => sum + entry.seconds, 0)

  return {
    ok: true,
    generated: {
      draft: { generatedAt: new Date(now).toISOString(), entries: [...synced, ...entries] },
      added: entries.length,
      covered: uncovered.length,
      recordedSeconds,
      proposedSeconds,
      deltaSeconds: proposedSeconds - recordedSeconds,
    },
  }
}

/**
 * The entry one finished turn contributes.
 *
 * A turn becomes ONE line: the host measured how long it ran, the agent wrote
 * down what it did while it was doing it. Neither half needs a model here —
 * the comment was written while the work was still in context, which is the
 * only moment it could be written honestly, and the duration is a clock
 * reading. That is why this can run at the end of every turn instead of at
 * the end of the session, where the conversation may have been compacted away.
 *
 * Two turns produce nothing:
 *
 *   - a turn shorter than the policy floor is chatter, and a Jira line for
 *     chatter is noise;
 *   - a turn the agent recorded nothing in has no description, and a Jira
 *     line without a description is a line nobody wants to read. The panel
 *     shows the unaccounted time instead.
 */
export function autoEntryForTurn(
  doc: SessionDoc,
  turn: number,
  span: TurnSpan,
  policy: WorklogPolicy,
): ProposedEntry | null {
  // The turn's own measured time, rounded and clamped like any derived
  // duration; null means the turn was too short to bill.
  const seconds = deriveSeconds(span.seconds * 1000, policy)
  if (seconds === null) return null

  const covered = new Set<string>()
  for (const entry of doc.draft?.entries ?? []) {
    for (const id of entry.activityIds) covered.add(id)
  }
  const activities = doc.activities.filter(
    activity => activity.turn === turn && !covered.has(activity.id),
  )
  if (activities.length === 0) return null

  return {
    seconds,
    comment: activities.map(activity => activity.summary).join('；'),
    startedAt: span.startedAt,
    activityIds: activities.map(activity => activity.id),
  }
}

/** Everything the state tool and the panel report about one session. */
export interface WorklogSummary {
  bound: boolean
  key: string | null
  summary: string | null
  statusName: string | null
  url: string | null
  activityCount: number
  recordedSeconds: number
  measuredSeconds: number
  /** Measured minus recorded; what the records do not account for. */
  gapSeconds: number
  uncoveredCount: number
  /** Records no entry covers at all (a draft that covers them does not count). */
  unrecordedCount: number
  draftCount: number
  pendingCount: number
  syncedCount: number
  failedCount: number
  settled: boolean
}

/** Fold one document into the numbers the caller reports. */
export function summarizeDoc(doc: SessionDoc): WorklogSummary {
  const recordedSeconds = doc.activities.reduce((sum, activity) => sum + activity.seconds, 0)
  const measuredSeconds = doc.turns.reduce((sum, turn) => sum + turn.seconds, 0)
  const entries = doc.draft?.entries ?? []
  const uncovered = uncoveredActivities(doc)
  const unrecorded = unrecordedActivities(doc)
  return {
    bound: doc.binding !== null,
    key: doc.binding?.key ?? null,
    summary: doc.binding?.summary ?? null,
    statusName: doc.binding?.statusName ?? null,
    url: doc.binding?.url ?? null,
    activityCount: doc.activities.length,
    recordedSeconds,
    measuredSeconds,
    gapSeconds: measuredSeconds - recordedSeconds,
    uncoveredCount: uncovered.length,
    unrecordedCount: unrecorded.length,
    draftCount: entries.length,
    pendingCount: entries.filter(entry => entry.state !== 'synced').length,
    syncedCount: entries.filter(entry => entry.state === 'synced').length,
    failedCount: entries.filter(entry => entry.state === 'failed').length,
    settled: isSettled(doc),
  }
}

/** Drop the drafts, keep what already reached Jira. */
export function discardDraft(doc: SessionDoc): { kept: number; removed: number } {
  const entries = doc.draft?.entries ?? []
  const kept = entries.filter(entry => entry.state === 'synced')
  const removed = entries.length - kept.length
  doc.draft = kept.length === 0 ? null : { generatedAt: doc.draft?.generatedAt ?? new Date().toISOString(), entries: kept }
  return { kept: kept.length, removed }
}
