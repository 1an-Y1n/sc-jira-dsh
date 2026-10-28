/**
 * sc-jira worklog ledger handlers.
 *
 * The ledger is the local record of time spent. These handlers expose it for
 * review and for the upload that follows a review — an upload is always
 * something a person asked for, never something the plugin decided on its
 * own.
 *
 * The four operations:
 *
 *   list   — read the ledger and its totals
 *   edit   — change a duration, a comment or a start time
 *   upload — send the SELECTED entries to Jira
 *   repull — re-read Jira's worklogs and reconcile the local view
 */
import type { ScjiraSettings } from './types.js'
import {
  appendWorklog,
  editWorklog,
  markFailed,
  markSynced,
  readLedger,
  summarizeLedger,
  type WorklogEdit,
  type WorklogLedgerEntry,
} from './worklog-ledger.js'
import type { JiraClient } from './jira-client.js'
import { formatDuration } from './jira-client.js'

/** What the handlers need to reach Jira and the ledger. */
export interface WorklogDeps {
  jira: JiraClient
  creds: ScjiraSettings
  tasksDir: string
}

/** One entry as the UI receives it. */
export interface WorklogView {
  id: string
  turn: number | null
  seconds: number
  duration: string
  comment: string
  startedAt: string
  state: 'draft' | 'synced' | 'failed'
  jiraId: string | null
  createdAt: string
  syncedAt: string | null
  error: string | null
}

/** The ledger as the UI receives it. */
export interface WorklogLedgerView {
  key: string
  entries: WorklogView[]
  totalSeconds: number
  totalDuration: string
  draftCount: number
  syncedCount: number
  failedCount: number
}

function toView(entry: WorklogLedgerEntry): WorklogView {
  return {
    id: entry.id,
    turn: entry.turn,
    seconds: entry.seconds,
    duration: formatDuration(entry.seconds),
    comment: entry.comment,
    startedAt: entry.startedAt,
    state: entry.state,
    jiraId: entry.jiraId,
    createdAt: entry.createdAt,
    syncedAt: entry.syncedAt,
    error: entry.error,
  }
}

/** Read the ledger for an issue. */
export async function handleListWorklogs(
  deps: WorklogDeps,
  args: { key: string },
): Promise<{ ok: true; ledger: WorklogLedgerView } | { ok: false; error: string }> {
  const entries = await readLedger(deps.tasksDir, args.key)
  const totals = summarizeLedger(entries)
  return {
    ok: true,
    ledger: {
      key: args.key,
      entries: entries.map(toView),
      totalSeconds: totals.totalSeconds,
      totalDuration: formatDuration(totals.totalSeconds),
      draftCount: totals.draftCount,
      syncedCount: totals.syncedCount,
      failedCount: totals.failedCount,
    },
  }
}

/**
 * Edit one entry.
 *
 * A draft entry changes locally only. A synced entry changes locally AND on
 * Jira — the user edited a duration that is already on the tracker, and the
 * tracker should agree.
 */
export async function handleEditWorklog(
  deps: WorklogDeps,
  args: { key: string; id: string; edit: WorklogEdit },
): Promise<
  | { ok: true; entry: WorklogView }
  | { ok: false; error: string }
> {
  const entry = await editWorklog(deps.tasksDir, args.key, args.id, args.edit)
  if (entry === null) {
    return { ok: false, error: `no ledger entry ${args.id} for ${args.key}` }
  }
  if (entry.state === 'synced' && entry.jiraId !== null) {
    const updated = await deps.jira.updateWorklog(args.key, entry.jiraId, {
      seconds: entry.seconds,
      comment: entry.comment,
      started: entry.startedAt,
    })
    if (!updated.ok) {
      return {
        ok: false,
        error: `edited locally but Jira rejected the change (${updated.error}): ${updated.detail ?? ''}`,
      }
    }
  }
  return { ok: true, entry: toView(entry) }
}

/** The outcome of uploading one entry. */
export interface UploadOutcome {
  id: string
  ok: boolean
  jiraId: string | null
  error?: string
}

/**
 * Upload the SELECTED entries to Jira.
 *
 * `ids` names the entries to send; an empty list uploads nothing, because
 * the upload is the user's decision and an accidental "upload all" would
 * write to the real tracker.
 */
export async function handleUploadWorklogs(
  deps: WorklogDeps,
  args: { key: string; ids: string[]; commentPrefix?: string },
): Promise<
  | { ok: true; uploaded: UploadOutcome[]; syncedCount: number }
  | { ok: false; error: string }
> {
  const entries = await readLedger(deps.tasksDir, args.key)
  const selected = entries.filter(e => args.ids.includes(e.id))
  if (selected.length === 0) {
    return { ok: true, uploaded: [], syncedCount: 0 }
  }

  const uploaded: UploadOutcome[] = []
  let syncedCount = 0
  for (const entry of selected) {
    if (entry.state === 'synced') {
      // Already on Jira — nothing to send.
      uploaded.push({ id: entry.id, ok: true, jiraId: entry.jiraId })
      syncedCount += 1
      continue
    }
    const comment = args.commentPrefix !== undefined && args.commentPrefix !== ''
      ? `${args.commentPrefix} ${entry.comment}`
      : entry.comment
    const created = await deps.jira.addWorklog(args.key, {
      seconds: entry.seconds,
      comment,
      started: entry.startedAt,
    })
    if (!created.ok) {
      const detail = created.detail ?? created.error
      await markFailed(deps.tasksDir, args.key, entry.id, `Jira rejected the worklog (${detail})`)
      uploaded.push({ id: entry.id, ok: false, jiraId: null, error: `Jira rejected the worklog (${detail})` })
      continue
    }
    await markSynced(deps.tasksDir, args.key, entry.id, created.body.id, new Date().toISOString())
    uploaded.push({ id: entry.id, ok: true, jiraId: created.body.id })
    syncedCount += 1
  }

  return { ok: true, uploaded, syncedCount }
}

/**
 * Re-read Jira's worklogs and reconcile the local view.
 *
 * The user may have edited a duration in Jira's own UI. The local ledger
 * would then disagree with the tracker, so this re-reads the tracker and
 * matches the entries by start time and duration.
 *
 * A synced local entry whose Jira counterpart matches has its comment and
 * duration refreshed. A Jira worklog with no local counterpart is added as
 * a synced entry — it is real time on the tracker that the ledger does not
 * know about.
 */
export async function handleRepullWorklogs(
  deps: WorklogDeps,
  args: { key: string },
): Promise<
  | { ok: true; updated: number; added: number; ledger: WorklogLedgerView }
  | { ok: false; error: string }
> {
  const page = await deps.jira.worklogs(args.key, { startAt: 0, maxResults: 1000 })
  if (!page.ok) {
    return { ok: false, error: `Jira returned ${page.error}` }
  }
  const remote = page.body.worklogs ?? []
  const local = await readLedger(deps.tasksDir, args.key)

  let updated = 0
  let added = 0

  // Match a remote worklog to a local synced entry: same start (within a
  // minute) and the same duration.
  const matchedRemote = new Set<string>()
  for (const entry of local) {
    if (entry.state !== 'synced' || entry.jiraId === null) continue
    const remoteEntry = remote.find(r => r.id === entry.jiraId)
    if (remoteEntry === undefined) continue
    matchedRemote.add(remoteEntry.id)
    const remoteComment = remoteEntry.comment ?? ''
    const remoteSeconds = remoteEntry.timeSpentSeconds ?? entry.seconds
    if (remoteComment !== entry.comment || remoteSeconds !== entry.seconds) {
      await editWorklog(deps.tasksDir, args.key, entry.id, {
        comment: remoteComment,
        seconds: remoteSeconds,
      })
      updated += 1
    }
  }

  // A Jira worklog the ledger does not know about is real time on the
  // tracker; record it so the ledger tells the whole truth.
  for (const remoteEntry of remote) {
    if (matchedRemote.has(remoteEntry.id)) continue
    const seconds = remoteEntry.timeSpentSeconds ?? 0
    if (seconds <= 0) continue
    const created = await appendWorklog(deps.tasksDir, args.key, {
      turn: null,
      step: null,
      seconds,
      comment: remoteEntry.comment ?? '',
      startedAt: remoteEntry.started,
      createdAt: new Date().toISOString(),
    })
    await markSynced(deps.tasksDir, args.key, created.id, remoteEntry.id, new Date().toISOString())
    added += 1
  }

  const after = await handleListWorklogs(deps, { key: args.key })
  if (!after.ok) return { ok: false, error: after.error }
  return { ok: true, updated, added, ledger: after.ledger }
}
