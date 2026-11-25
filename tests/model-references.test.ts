import { describe, expect, it } from 'vitest'
import { supportsVibes } from '../src/shared/nai-models'
import {
  clampRefStrength,
  effortForRefs,
  REF_BUCKETS,
  refBucket,
  refImageMode,
  refParts,
  refShortLabel,
  refsForModel,
  refStrengthMax,
  refTypeOfParts,
  sentRefCount,
  shownRefParts,
  showsFidelity,
  toggleRefPart
} from '../src/shared/char-refs'
import type { CharRefType } from '../src/shared/types'

describe('supportsVibes (V5에는 바이브를 싣지 않는다)', () => {
  it('V5 계열은 모두 false (Full·Medium·Curated·인페인트)', () => {
    for (const model of [
      'nai-diffusion-5-full',
      'nai-diffusion-5-full-medium',
      'nai-diffusion-5-curated',
      'nai-diffusion-5-full-inpainting',
      'nai-diffusion-5-full-medium-inpainting'
    ]) {
      expect(supportsVibes(model), model).toBe(false)
    }
  })

  it('V4.5 계열은 true', () => {
    for (const model of [
      'nai-diffusion-4-5-full',
      'nai-diffusion-4-5-curated',
      'nai-diffusion-4-5-full-inpainting'
    ]) {
      expect(supportsVibes(model), model).toBe(true)
    }
  })
})

describe('Precise Reference 모델별 규칙 (NAI 웹 코드 2026-11-25)', () => {
  const ref = (
    referenceType: CharRefType,
    fidelity = 0.6,
    strength = 1
  ): { referenceType: CharRefType; strength: number; fidelity: number } => ({
    referenceType,
    strength,
    fidelity
  })

  it('세 칸(얼굴·옷·그림체) 조합이 description 값이 된다', () => {
    expect(refTypeOfParts(['face'])).toBe('character')
    expect(refTypeOfParts(['face', 'outfit'])).toBe('character_mainoutfit')
    expect(refTypeOfParts(['face', 'style'])).toBe('character&style_anyoutfit')
    expect(refTypeOfParts(['style', 'outfit', 'face'])).toBe('character&style')
    expect(refTypeOfParts(['style'])).toBe('style')
    expect(refTypeOfParts(['outfit'])).toBe('costume')
    expect(refTypeOfParts(['outfit', 'style'])).toBeNull()
    expect(refTypeOfParts([])).toBeNull()
    expect(refParts('character&style_anyoutfit')).toEqual(['face', 'style'])
  })

  it('칸 누르기: 없는 조합·마지막 칸 끄기·V4.5의 옷은 막는다', () => {
    const v5 = 'nai-diffusion-5-full'
    const v45 = 'nai-diffusion-4-5-full'
    expect(toggleRefPart('character', 'outfit', v5)).toEqual({ type: 'character_mainoutfit' })
    expect(toggleRefPart('character&style', 'face', v5)).toEqual({ blocked: expect.any(String) })
    expect(toggleRefPart('style', 'style', v5)).toEqual({ blocked: '하나는 골라야 해요' })
    expect(toggleRefPart('character', 'outfit', v45)).toEqual({ blocked: expect.any(String) })
    expect(toggleRefPart('character', 'style', v45)).toEqual({ type: 'character&style_anyoutfit' })
    // V4.5에서 얼굴을 끄면 의상만 남는데, 의상은 V4.5에서 안 보내므로 막는다
    expect(toggleRefPart('character_mainoutfit', 'face', v45)).toEqual({
      blocked: '하나는 골라야 해요'
    })
    expect(shownRefParts('character&style', v45)).toEqual(['face', 'style'])
    expect(shownRefParts('costume', v45)).toEqual(['outfit'])
  })

  it('V5는 모든 종류를 그대로 보내고 fidelity를 1로 고정한다', () => {
    const out = refsForModel(
      [ref('character_mainoutfit'), ref('costume'), ref('character&style_anyoutfit')],
      'nai-diffusion-5-full'
    )
    expect(out.map((r) => r.referenceType)).toEqual([
      'character_mainoutfit',
      'costume',
      'character&style_anyoutfit'
    ])
    expect(out.every((r) => r.fidelity === 1)).toBe(true)
  })

  it('V4.5는 의상을 빼고 V5 전용 값을 되돌린다, fidelity는 그대로', () => {
    const out = refsForModel(
      [ref('character_mainoutfit'), ref('costume'), ref('character&style_anyoutfit'), ref('style')],
      'nai-diffusion-4-5-full'
    )
    expect(out.map((r) => r.referenceType)).toEqual(['character', 'character&style', 'style'])
    expect(out.every((r) => r.fidelity === 0.6)).toBe(true)
    expect(sentRefCount(['costume', 'character'], 'nai-diffusion-4-5-full')).toBe(1)
    expect(sentRefCount(['costume', 'character'], 'nai-diffusion-5-full')).toBe(2)
  })

  it('V5 절약은 레퍼런스가 있으면 일반으로, 없으면 그대로', () => {
    expect(effortForRefs('nai-diffusion-5-full-medium', 1)).toBe('nai-diffusion-5-full')
    expect(effortForRefs('nai-diffusion-5-full-medium-inpainting', 1)).toBe(
      'nai-diffusion-5-full-inpainting'
    )
    expect(effortForRefs('nai-diffusion-5-full-medium', 0)).toBe('nai-diffusion-5-full-medium')
    expect(effortForRefs('nai-diffusion-4-5-full', 2)).toBe('nai-diffusion-4-5-full')
  })

  it('강도 상한과 충실도 표시', () => {
    expect(refStrengthMax('nai-diffusion-5-full')).toBe(5)
    expect(refStrengthMax('nai-diffusion-4-5-full')).toBe(1)
    expect(showsFidelity('nai-diffusion-5-curated')).toBe(false)
    expect(showsFidelity('nai-diffusion-4-5-full')).toBe(true)
  })

  it('카드 머리 표시: 켠 칸을 잇고, V4.5에서는 옷을 빼고 적는다', () => {
    expect(refShortLabel('character&style', 'nai-diffusion-5-full', 0.6)).toBe(
      '얼굴+옷+그림체 · 강도 0.60'
    )
    expect(refShortLabel('character&style', 'nai-diffusion-4-5-full', 0.6)).toBe(
      '얼굴+그림체 · 강도 0.60'
    )
    expect(refShortLabel('costume', 'nai-diffusion-4-5-full', 0.6)).toBe('옷 · V5에서만')
    expect(refShortLabel('character', 'nai-diffusion-5-full')).toBe('얼굴')
  })

  it('강도는 보낼 모델의 상한으로 자른다 (저장값 3은 V4.5에 1로 간다)', () => {
    expect(clampRefStrength(3, 'nai-diffusion-4-5-full')).toBe(1)
    expect(clampRefStrength(3, 'nai-diffusion-5-full')).toBe(3)
    expect(clampRefStrength(7, 'nai-diffusion-5-full')).toBe(5)
    expect(clampRefStrength(-1, 'nai-diffusion-5-full')).toBe(0)
    expect(
      refsForModel([ref('character', 0.6, 3)], 'nai-diffusion-4-5-full').map((r) => r.strength)
    ).toEqual([1])
    expect(
      refsForModel([ref('character', 0.6, 3)], 'nai-diffusion-5-full').map((r) => r.strength)
    ).toEqual([3])
  })
})

describe('V5 레퍼런스 그림 버킷 (NAI 웹과 같은 표)', () => {
  it('V5는 버킷, V4.5는 캔버스', () => {
    expect(refImageMode('nai-diffusion-5-full')).toBe('bucket')
    expect(refImageMode('nai-diffusion-5-full-medium-inpainting')).toBe('bucket')
    expect(refImageMode('nai-diffusion-4-5-full')).toBe('canvas')
  })

  it('버킷은 97개, 모두 64 배수이고 1MP를 넘지 않는다', () => {
    expect(REF_BUCKETS).toHaveLength(97)
    for (const [w, h] of REF_BUCKETS) {
      expect(w % 64).toBe(0)
      expect(h % 64).toBe(0)
      expect(w * h).toBeLessThanOrEqual(1024 * 1024)
    }
    expect(REF_BUCKETS[0]).toEqual([256, 4096])
    expect(REF_BUCKETS[48]).toEqual([1024, 1024])
    expect(REF_BUCKETS[96]).toEqual([4096, 256])
  })

  it('종횡비가 가까운 버킷을 덮게 키우고 가운데를 자른다', () => {
    // 832×1216 (세로 에셋) → 832×1216 버킷이 있으면 그대로
    const same = refBucket(832, 1216)
    expect([same.width, same.height]).toEqual([832, 1216])
    expect(same.unchanged).toBe(true)
    // 정사각 2048² → 1024² 로 줄이기만
    const square = refBucket(2048, 2048)
    expect([square.width, square.height, square.resizeWidth, square.resizeHeight]).toEqual([
      1024, 1024, 1024, 1024
    ])
    expect(square.unchanged).toBe(false)
    // 가로 1920×1080 → 가장 가까운 가로 버킷, 잘라 낸 영역이 키운 그림 안에 있다
    const wide = refBucket(1920, 1080)
    expect(wide.width).toBeGreaterThan(wide.height)
    expect(wide.width * wide.height).toBeLessThanOrEqual(1024 * 1024)
    expect(wide.left + wide.width).toBeLessThanOrEqual(wide.resizeWidth)
    expect(wide.top + wide.height).toBeLessThanOrEqual(wide.resizeHeight)
    expect(wide.resizeWidth).toBeGreaterThanOrEqual(wide.width)
    expect(wide.resizeHeight).toBeGreaterThanOrEqual(wide.height)
  })
})
