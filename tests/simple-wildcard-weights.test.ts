import { describe, expect, it } from 'vitest'
import { processWildcards } from '../src/main/fragments/processor'

const none = { getLines: () => null }
const last = (): number => 0.99

describe('a/b wildcard inside weights and brackets', () => {
  it('keeps the weight and bracket marks balanced', () => {
    expect(processWildcards('1.2::red/blue::, {a/b}', none, last)).toBe('1.2::blue::, {b}')
    expect(processWildcards('-1::hat/cap::', none, last)).toBe('-1::cap::')
    expect(processWildcards('0.8::x, green/blue::', none, last)).toBe('0.8::x, blue::')
    expect(processWildcards('[[a/b]]', none, last)).toBe('[[b]]')
  })

  it('still picks plain a/b and leaves spaced or URL text alone', () => {
    expect(processWildcards('1girl, red/blue', none, last)).toBe('1girl, blue')
    expect(processWildcards('1.2::red hair/blue hair::', none, last)).toBe(
      '1.2::red hair/blue hair::'
    )
    expect(processWildcards('1.2::red::', none, last)).toBe('1.2::red::')
  })
})
