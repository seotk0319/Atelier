import { describe, expect, it } from 'vitest'
import { isRecent } from '../src/main/notifications/query'

describe('isRecent', () => {
  const now = Date.parse('2026-11-11T00:00:00Z')
  it('keeps comments from the last 30 days', () => {
    expect(isRecent({ at: '2026-10-20T00:00:00Z', firstSeen: '' }, now)).toBe(true)
    expect(isRecent({ at: '2026-10-12T00:00:00Z', firstSeen: '' }, now)).toBe(true)
  })
  it('drops older comments and ones without a usable time', () => {
    expect(isRecent({ at: '2026-10-11T23:59:00Z', firstSeen: '' }, now)).toBe(false)
    expect(isRecent({ at: '', firstSeen: '' }, now)).toBe(false)
  })
  it('falls back to firstSeen', () => {
    expect(isRecent({ at: '', firstSeen: '2026-11-01T00:00:00Z' }, now)).toBe(true)
  })
})
