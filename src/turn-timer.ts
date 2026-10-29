/**
 * sc-jira turn timing.
 *
 * A turn is one user question and the work that answered it. Its wall-clock
 * duration is the plugin's measure of time spent, and it is what an automatic
 * worklog entry records.
 *
 * The window opens when the turn's first step is admitted and closes when
 * `agent/turn-stopping` fires. Steps are not the unit: a turn can hold
 * several of them (a model call, the tools it asked for, another model call),
 * and the time between them belongs to the turn, not to any one step.
 *
 * The measure is an approximation and the design says so: Jira cannot tell
 * "read the code for thirty minutes" from "stared at the screen for thirty
 * minutes". The policy clamps it — a floor below which nothing is recorded,
 * a ceiling above which a turn records no more than the ceiling — and the
 * local ledger is editable, so the number the user sees is one they can fix.
 */
import type { AutoWorklogConfig } from './types.js'

/** One turn's measured span. */
export interface TurnSpan {
  /** The turn number. */
  turn: number
  /** When the turn's first step was admitted. */
  startedAt: number
  /** When the turn closed. */
  endedAt: number
  /** Wall-clock milliseconds between the two. */
  elapsedMs: number
}

/**
 * Apply the recording policy to a measured duration.
 *
 * @param elapsedMs - the measured wall-clock duration.
 * @param policy - the binding's automatic-worklog policy.
 * @param opts.requireEnabled - whether the policy's on/off switch applies.
 *   Automatic recording honours it; a caller that measured the time itself
 *   and asked for it to be recorded does not — the switch governs recording
 *   that happens without being asked for.
 * @returns the seconds to record, or null when the turn is too short to count.
 */
export function secondsToRecord(
  elapsedMs: number,
  policy: AutoWorklogConfig,
  opts: { requireEnabled?: boolean } = {},
): number | null {
  if (opts.requireEnabled !== false && !policy.enabled) return null
  const seconds = elapsedMs / 1000
  if (seconds < policy.minSeconds) return null
  const capped = Math.min(seconds, policy.maxSecondsPerTurn)
  // Round UP to the rounding step: a turn that ran for 61 seconds is an
  // hour's worth of a minute and a bit, and recording 1 minute loses it.
  const rounded = Math.ceil(capped / policy.rounding) * policy.rounding
  return Math.max(policy.rounding, rounded)
}

/**
 * Track the open turn of each agent.
 *
 * One open turn per agent: a turn's first step opens it, and later steps of
 * the same turn find it already open. A different turn number means a
 * different turn, so the previous one is replaced.
 */
export class TurnTimer {
  private readonly open = new Map<string, TurnSpan>()

  /**
   * Open a turn, or return the one already open.
   *
   * @param sessionId - the agent whose turn is starting.
   * @param turn - the turn number.
   * @returns the open span.
   */
  start(sessionId: string, turn: number): TurnSpan {
    const existing = this.open.get(sessionId)
    if (existing !== undefined && existing.turn === turn) return existing
    const span: TurnSpan = { turn, startedAt: Date.now(), endedAt: 0, elapsedMs: 0 }
    this.open.set(sessionId, span)
    return span
  }

  /**
   * Close a turn and report how long it ran.
   *
   * @param sessionId - the agent whose turn is closing.
   * @param turn - the turn number; a mismatch means the span is not ours.
   * @returns the measured span, or null when no matching turn was open.
   */
  end(sessionId: string, turn: number): TurnSpan | null {
    const existing = this.open.get(sessionId)
    if (existing === undefined || existing.turn !== turn) return null
    const endedAt = Date.now()
    const span: TurnSpan = {
      ...existing,
      endedAt,
      elapsedMs: Math.max(0, endedAt - existing.startedAt),
    }
    this.open.delete(sessionId)
    return span
  }

  /** The open turn of an agent, if any. */
  peek(sessionId: string): TurnSpan | undefined {
    return this.open.get(sessionId)
  }

  /** Forget an agent's open turn — used when the agent goes away. */
  forget(sessionId: string): void {
    this.open.delete(sessionId)
  }

  /** How many turns are currently open. */
  get size(): number {
    return this.open.size
  }
}

/**
 * Format an instant as the local timestamp the ledger stores.
 *
 * The offset is fixed at +0800 rather than taken from the host's zone: the
 * Jira server runs on Asia/Taipei, which shares the offset with
 * Asia/Shanghai, and a fixed offset keeps a backdated entry lining up with
 * the working day the user meant.
 */
export function localTimestamp(epochMs: number): string {
  const shifted = new Date(epochMs + 8 * 60 * 60 * 1000)
  return `${shifted.toISOString().slice(0, 23)}+0800`
}

/**
 * The comment an automatic entry carries.
 *
 * It names the turn so the entry is traceable, and optionally the session, so
 * a Jira user can tell which conversation it came from.
 */
export function autoComment(turn: number, sessionId: string, includeSessionId: boolean): string {
  if (!includeSessionId) return `auto: turn ${turn}`
  const short = sessionId.length > 12 ? `${sessionId.slice(0, 12)}…` : sessionId
  return `auto: turn ${turn} (session ${short})`
}
