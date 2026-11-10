import { describe, expect, it } from 'vitest'
import { supportsReferences } from '../src/shared/nai-models'

describe('supportsReferences (V5에는 바이브·캐릭터 레퍼런스를 싣지 않는다)', () => {
  it('V5 계열은 모두 false (Full·Medium·Curated·인페인트)', () => {
    for (const model of [
      'nai-diffusion-5-full',
      'nai-diffusion-5-full-medium',
      'nai-diffusion-5-curated',
      'nai-diffusion-5-full-inpainting',
      'nai-diffusion-5-full-medium-inpainting'
    ]) {
      expect(supportsReferences(model), model).toBe(false)
    }
  })

  it('V4.5 계열은 true', () => {
    for (const model of [
      'nai-diffusion-4-5-full',
      'nai-diffusion-4-5-curated',
      'nai-diffusion-4-5-full-inpainting'
    ]) {
      expect(supportsReferences(model), model).toBe(true)
    }
  })
})
