import { describe, expect, it } from 'vitest'
import { MAX_GENERATION_PIXELS, snapResolution } from '../src/renderer/src/stores/resolutions-store'

describe('사용자 해상도 픽셀 상한 (NAI 웹 3×1024×1024)', () => {
  it('상한 안이면 64 배수로만 맞춘다', () => {
    expect(snapResolution(832, 1216)).toEqual({ width: 832, height: 1216 })
    expect(snapResolution(1000, 1500)).toEqual({ width: 1024, height: 1472 })
  })
  it('넘으면 비율을 지키며 64 배수로 줄인다', () => {
    const square = snapResolution(2048, 2048)
    expect(square.width * square.height).toBeLessThanOrEqual(MAX_GENERATION_PIXELS)
    expect(square).toEqual({ width: 1728, height: 1728 })
    const tall = snapResolution(1536, 2048)
    expect(tall.width * tall.height).toBeLessThanOrEqual(MAX_GENERATION_PIXELS)
    expect(tall.width % 64).toBe(0)
    expect(tall.height % 64).toBe(0)
  })
})
