import { describe, it, expect } from 'vitest'
import { addDays, localDate, mondayOf, mondayOfDate, parseIsoDate, todayIso } from '../src/timezone.js'

// 2026-09-07 is a Monday. The week runs 2026-09-07 (Mon) .. 2026-09-13 (Sun).
const MONDAY = '2026-09-07'
const SUNDAY = '2026-09-13'
const TUESDAY = '2026-09-08'

describe('localDate', () => {
  it('returns the UTC date during local daytime', () => {
    // 2026-09-07 12:00 Asia/Shanghai == 04:00 UTC → same calendar day.
    expect(localDate(new Date('2026-09-07T04:00:00Z'))).toBe('2026-09-07')
  })

  it('returns the local date when UTC has already rolled over', () => {
    // 2026-09-07 02:00 Asia/Shanghai == 2026-09-06 18:00 UTC.
    // The UTC date is 2026-09-06 but the Shanghai date is still 2026-09-07.
    expect(localDate(new Date('2026-09-06T18:00:00Z'))).toBe('2026-09-07')
  })

  it('rolls forward for local times just after midnight', () => {
    // 2026-09-08 01:00 Asia/Shanghai == 2026-09-07 17:00 UTC.
    expect(localDate(new Date('2026-09-07T17:00:00Z'))).toBe('2026-09-08')
  })

  it('matches naive UTC slicing only outside the 00:00-08:00 local window', () => {
    const d = new Date('2026-09-07T10:00:00Z') // 18:00 Shanghai
    expect(localDate(d)).toBe(d.toISOString().slice(0, 10))
  })
})

describe('todayIso', () => {
  it('is the local calendar day, not the UTC one', () => {
    expect(todayIso(new Date('2026-09-06T18:00:00Z'))).toBe('2026-09-07')
  })
})

describe('mondayOf', () => {
  it('returns the same date for a Monday', () => {
    expect(mondayOf(MONDAY)).toBe(MONDAY)
  })

  it('returns the previous Monday for a mid-week day', () => {
    expect(mondayOf(TUESDAY)).toBe(MONDAY)
  })

  it('returns the same Monday for a Sunday', () => {
    expect(mondayOf(SUNDAY)).toBe(MONDAY)
  })

  it('returns the same Monday for the day after a Sunday', () => {
    // 2026-09-14 is itself a Monday, so it is its own week start.
    expect(mondayOf('2026-09-14')).toBe('2026-09-14')
  })

  it('handles month boundaries', () => {
    // 2026-10-01 is a Thursday → Monday is 2026-09-28.
    expect(mondayOf('2026-10-01')).toBe('2026-09-28')
  })
})

describe('mondayOfDate', () => {
  it('resolves the Monday of the local week', () => {
    // 2026-09-07 02:00 Shanghai is still Monday locally, but already Sunday
    // in UTC. The local week must win.
    expect(mondayOfDate(new Date('2026-09-06T18:00:00Z'))).toBe(MONDAY)
  })
})

describe('addDays', () => {
  it('adds days across a week boundary', () => {
    expect(addDays(SUNDAY, 1)).toBe('2026-09-14')
  })

  it('subtracts days', () => {
    expect(addDays(MONDAY, -1)).toBe('2026-09-06')
  })

  it('crosses a month boundary', () => {
    expect(addDays('2026-09-30', 1)).toBe('2026-10-01')
  })

  it('crosses a year boundary', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
  })
})

describe('parseIsoDate', () => {
  it('anchors at UTC midnight', () => {
    expect(parseIsoDate('2026-09-07').toISOString()).toBe('2026-09-07T00:00:00.000Z')
  })
})
