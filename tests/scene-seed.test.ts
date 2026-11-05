import { describe, expect, it } from 'vitest'
import { normalizeSceneSeed, sceneSeedFrom } from '../src/shared/scene-seed'

describe('scene seed', () => {
  it('accepts only 0..4294967295 integers (numbers or digit strings)', () => {
    expect(normalizeSceneSeed(1234567890)).toBe(1234567890)
    expect(normalizeSceneSeed('42')).toBe(42)
    expect(normalizeSceneSeed(0)).toBe(0)
    expect(normalizeSceneSeed(4294967295)).toBe(4294967295)
    for (const bad of [-1, 4294967296, 1.5, '', ' ', 'abc', null, undefined, {}]) {
      expect(normalizeSceneSeed(bad)).toBeNull()
    }
  })
  it('pushes repeated shots of one scene by +offset and wraps', () => {
    expect(sceneSeedFrom(100, 0)).toBe(100)
    expect(sceneSeedFrom(100, 2)).toBe(102)
    expect(sceneSeedFrom(4294967295, 1)).toBe(0)
  })
})
