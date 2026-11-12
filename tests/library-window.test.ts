import { describe, expect, it } from 'vitest'
import { olderWindow, recentWindowStart, shiftDate } from '../src/renderer/src/lib/library-window'

describe('library window', () => {
  it('shifts local dates across month and year ends', () => {
    expect(shiftDate('2026-11-03', -6)).toBe('2026-10-28')
    expect(shiftDate('2026-01-02', -6)).toBe('2025-12-27')
    expect(shiftDate('2026-02-28', 1)).toBe('2026-03-01')
  })

  it('starts the recent window six days before today', () => {
    expect(recentWindowStart(new Date(2026, 10, 11, 23, 59))).toBe('2026-11-05')
  })

  const dates = [
    { date: '2026-11-11', count: 10 },
    { date: '2026-11-05', count: 3 },
    { date: '2026-11-04', count: 7 },
    { date: '2026-10-29', count: 2 },
    { date: '2026-10-28', count: 5 },
    { date: '2026-08-01', count: 1 }
  ]

  it('widens by one week ending at the nearest older day with images', () => {
    expect(olderWindow(dates, '2026-11-05')).toEqual({
      since: '2026-10-29',
      to: '2026-11-04',
      count: 9
    })
  })

  it('skips empty weeks', () => {
    expect(olderWindow(dates, '2026-10-28')).toEqual({
      since: '2026-07-26',
      to: '2026-08-01',
      count: 1
    })
  })

  it('returns null when nothing older is left', () => {
    expect(olderWindow(dates, '2026-07-26')).toBeNull()
    expect(olderWindow([], '2026-11-05')).toBeNull()
  })
})
