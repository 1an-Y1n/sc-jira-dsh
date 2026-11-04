/**
 * Turning wall clock into a recorded duration.
 *
 * The host measures; it does not interpret. Two numbers come out of this
 * module:
 *
 *   - a duration for an activity the agent recorded without one — the wall
 *     clock since the previous record, clamped by the policy; and
 *   - the gap between what was measured and what was recorded, which the
 *     generation step reports so a reader can see the records are incomplete.
 *
 * The measure is an approximation and the design says so: a turn's span
 * includes waiting for the model, waiting for the user, and walking away from
 * the desk. The policy clamps it, the activity stays editable in the panel,
 * and nothing is uploaded without a human seeing the number first.
 */
import type { Activity, WorklogPolicy } from './types.js'

/** Format an instant as the local timestamp the ledger stores. */
export function localTimestamp(epochMs: number): string {
  const shifted = new Date(epochMs + 8 * 60 * 60 * 1000)
  return `${shifted.toISOString().slice(0, 23)}+0800`
}

/**
 * Parse a stored instant, or null when it is not one.
 *
 * Only the shape this plugin writes is accepted: an ISO timestamp with an
 * explicit offset, so a value without a zone can never be read as local time
 * by accident.
 */
export function instantOf(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:?\d{2})$/.test(value)) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

/** When one activity ended, in epoch milliseconds. */
export function activityEnd(activity: Activity): number {
  const start = instantOf(activity.startedAt) ?? Date.now()
  return start + activity.seconds * 1000
}

/**
 * Derive a duration from the wall clock.
 *
 * @returns the rounded seconds, or null when the interval is below the
 *   policy floor (too short to be worth recording).
 */
export function deriveSeconds(elapsedMs: number, policy: WorklogPolicy): number | null {
  const seconds = elapsedMs / 1000
  if (!Number.isFinite(seconds) || seconds < policy.minSeconds) return null
  const capped = Math.min(seconds, policy.maxSecondsPerActivity)
  // Round UP: 61 seconds is "a minute and a bit", and recording 1 minute
  // loses the bit.
  const rounded = Math.ceil(capped / policy.rounding) * policy.rounding
  return Math.max(policy.rounding, rounded)
}

/** A caller-supplied duration, validated but not rewritten. */
export type SecondsCheck =
  | { ok: true; seconds: number }
  | { ok: false; error: string }

/**
 * Validate an explicit duration.
 *
 * A duration the caller measured itself is not rounded or floored — that
 * would be the host second-guessing a number it did not measure. Only `<= 0`
 * and the cap are enforced.
 */
export function explicitSeconds(seconds: unknown, policy: WorklogPolicy): SecondsCheck {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) {
    return { ok: false, error: 'seconds must be a finite number' }
  }
  const whole = Math.round(seconds)
  if (whole <= 0) return { ok: false, error: 'seconds must be greater than 0' }
  if (whole > policy.maxSecondsPerActivity) {
    return { ok: false, error: `seconds exceeds the per-activity cap (${policy.maxSecondsPerActivity})` }
  }
  return { ok: true, seconds: whole }
}

/**
 * The time measured but not accounted for by records.
 *
 * Negative when the records claim more than the host measured, which is a
 * real outcome (the agent may legitimately attribute time it spent thinking
 * before the first step).
 */
export function gapSeconds(measuredSeconds: number, recordedSeconds: number): number {
  return Math.round(measuredSeconds - recordedSeconds)
}
