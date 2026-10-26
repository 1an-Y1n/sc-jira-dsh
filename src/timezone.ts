/**
 * sc-jira timezone helpers.
 *
 * The plugin reports worklog by calendar day in **Asia/Shanghai** (UTC+8),
 * matching the Jira server's worklog date semantics and the user's own
 * working day. The naive `new Date().toISOString().slice(0, 10)` used
 * everywhere returns the **UTC** date, which is off by one for 8 hours a day:
 * between 00:00 and 08:00 Shanghai time the UTC date is still yesterday.
 *
 * These helpers are deliberately dependency-free and pure so that both the
 * host (`src/handlers.ts`) and the browser client (`src/client/ScjiraView.tsx`)
 * can share the exact same week/day arithmetic.
 */

/** The timezone the plugin reports days in. */
export const TIMEZONE = 'Asia/Shanghai'

/** Fixed UTC offset for `Asia/Shanghai` (no DST since 1991). */
const TZ_OFFSET_MINUTES = 8 * 60

/**
 * Return the calendar date (YYYY-MM-DD) that `date` falls on in the plugin
 * timezone.
 */
export function localDate(date: Date = new Date()): string {
  const shifted = new Date(date.getTime() + TZ_OFFSET_MINUTES * 60_000)
  return shifted.toISOString().slice(0, 10)
}

/**
 * Parse an ISO date (YYYY-MM-DD) into a UTC-midnight Date. The date is a
 * calendar day, not an instant, so it is anchored at UTC midnight to keep
 * day arithmetic free of DST/timezone drift.
 */
export function parseIsoDate(isoDate: string): Date {
  return new Date(`${isoDate}T00:00:00Z`)
}

/**
 * Add (or subtract) whole days to an ISO date, returning an ISO date.
 */
export function addDays(isoDate: string, n: number): string {
  const d = parseIsoDate(isoDate)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/**
 * Return the Monday of the ISO week containing `isoDate`.
 *
 * Weeks are ISO-8601: Monday is day 1, Sunday is day 7.
 */
export function mondayOf(isoDate: string): string {
  const d = parseIsoDate(isoDate)
  const dow = d.getUTCDay() || 7  // Sun=7
  d.setUTCDate(d.getUTCDate() - (dow - 1))
  return d.toISOString().slice(0, 10)
}

/**
 * Return the Monday of the week containing `date`, in the plugin timezone.
 */
export function mondayOfDate(date: Date = new Date()): string {
  return mondayOf(localDate(date))
}

/**
 * Return the ISO date of `date` in the plugin timezone.
 */
export function todayIso(date: Date = new Date()): string {
  return localDate(date)
}
