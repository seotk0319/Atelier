import { describe, expect, it } from 'vitest'
import {
  composeWeakened,
  DEFAULT_GENERAL_WEIGHT,
  parseGeneralWeight,
  weakenText
} from '../src/shared/general-weight'

describe('general tag weight', () => {
  it('고정 칸은 그대로, 나머지를 한 괄호로 감싼다', () => {
    expect(
      composeWeakened('artist:a, masterpiece', ['1girl, smile', 'upper body'], 0.75)
    ).toBe('artist:a, masterpiece, 0.75::1girl, smile, upper body::')
  })

  it('나머지가 비었으면 빈 괄호를 붙이지 않는다', () => {
    expect(composeWeakened('artist:a', ['', '  '], 0.75)).toBe('artist:a')
  })

  it('고정 칸이 비었으면 나머지만 감싼다', () => {
    expect(composeWeakened('', ['1girl'], 0.75)).toBe('0.75::1girl::')
  })

  it('앞뒤 쉼표와 공백은 괄호 밖에 둔다', () => {
    expect(weakenText('  1girl, smile, ', 0.75)).toBe('  0.75::1girl, smile::, ')
  })

  it('안에 수치 가중치가 있으면 겹치지 않게 펴고 곱한다', () => {
    expect(weakenText('a, 1.2::b::, c', 0.75)).toBe('0.75::a::, 0.9::b::, 0.75::c::')
  })

  it('빼기용 음수 가중치는 그대로 둔다', () => {
    expect(weakenText('-1::flat color::, smile', 0.75)).toBe('-1::flat color::, 0.75::smile::')
  })

  it('중괄호와 대괄호는 감싼 안에 그대로 남는다', () => {
    expect(weakenText('{smile}, [blush]', 0.5)).toBe('0.5::{smile}, [blush]::')
  })

  it('닫히지 않은 수치 가중치는 끝까지로 보고 닫는다', () => {
    expect(weakenText('a, 1.2::b', 0.75)).toBe('0.75::a::, 0.9::b::')
  })

  it('설정값 읽기: 비었거나 이상하면 기본값, 범위 밖이면 자른다', () => {
    expect(parseGeneralWeight(null)).toBe(DEFAULT_GENERAL_WEIGHT)
    expect(parseGeneralWeight('abc')).toBe(DEFAULT_GENERAL_WEIGHT)
    expect(parseGeneralWeight('0.8')).toBe(0.8)
    expect(parseGeneralWeight('0.1')).toBe(0.3)
    expect(parseGeneralWeight('2')).toBe(1)
  })
})
