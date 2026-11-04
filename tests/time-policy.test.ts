import { describe, it, expect } from 'vitest'
import {
  activityEnd,
  deriveSeconds,
  explicitSeconds,
  gapSeconds,
  instantOf,
  localTimestamp,
} from '../src/time-policy.js'
import { DEFAULT_WORKLOG_POLICY } from '../src/types.js'

const policy = DEFAULT_WORKLOG_POLICY

describe('localTimestamp', () => {
  it('renders the instant at +0800', () => {
    expect(localTimestamp(Date.UTC(2026, 10, 4, 1, 30, 0))).toBe('2026-11-04T09:30:00.000+0800')
  })

  it('round-trips through instantOf', () => {
    const epoch = Date.UTC(2026, 10, 4, 1, 30, 0)
    expect(instantOf(localTimestamp(epoch))).toBe(epoch)
  })
})

describe('instantOf', () => {
  it('accepts an instant with a colon-less offset', () => {
    expect(instantOf('2026-11-04T09:30:00.000+0800')).not.toBeNull()
  })

  it('accepts a Z instant', () => {
    expect(instantOf('2026-11-04T01:30:00Z')).not.toBeNull()
  })

  it('refuses a timestamp with no offset', () => {
    // Without a zone the value would be read as the host's local time.
    expect(instantOf('2026-11-04T09:30:00')).toBeNull()
  })

  it('refuses nonsense', () => {
    expect(instantOf('yesterday')).toBeNull()
    expect(instantOf('')).toBeNull()
  })
})

describe('deriveSeconds', () => {
  it('refuses an interval below the floor', () => {
    expect(deriveSeconds(59_000, policy)).toBeNull()
  })

  it('rounds up to the step', () => {
    expect(deriveSeconds(61_000, policy)).toBe(120)
    expect(deriveSeconds(60_000, policy)).toBe(60)
    expect(deriveSeconds(121_000, policy)).toBe(180)
  })

  it('caps at the per-activity maximum', () => {
    expect(deriveSeconds(10 * 3600_000, policy)).toBe(policy.maxSecondsPerActivity)
  })

  it('never returns less than one step', () => {
    expect(deriveSeconds(60_000, { ...policy, rounding: 300 })).toBe(300)
  })
})

describe('explicitSeconds', () => {
  it('keeps a caller-measured value without rounding it', () => {
    expect(explicitSeconds(61, policy)).toEqual({ ok: true, seconds: 61 })
  })

  it('refuses zero and negatives', () => {
    expect(explicitSeconds(0, policy).ok).toBe(false)
    expect(explicitSeconds(-5, policy).ok).toBe(false)
  })

  it('refuses a value over the cap', () => {
    expect(explicitSeconds(policy.maxSecondsPerActivity + 1, policy).ok).toBe(false)
  })

  it('refuses a non-number', () => {
    expect(explicitSeconds('60' as never, policy).ok).toBe(false)
    expect(explicitSeconds(Number.NaN, policy).ok).toBe(false)
  })
})

describe('activityEnd / gapSeconds', () => {
  it('adds the duration to the start', () => {
    const start = Date.UTC(2026, 10, 4, 1, 0, 0)
    expect(activityEnd({
      id: 'act-01',
      summary: 'x',
      startedAt: localTimestamp(start),
      seconds: 90,
      turn: 1,
      source: 'agent',
    })).toBe(start + 90_000)
  })

  it('reports a negative gap when records claim more than was measured', () => {
    expect(gapSeconds(600, 900)).toBe(-300)
  })
})
