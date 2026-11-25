import { describe, expect, it } from 'vitest'
import type { GenerationRequest } from '../src/shared/types'
import { buildGenerateImagePayload } from '../src/main/nai/payload'
import { UC_HEAVY_V5, UC_PRESETS_V45_FULL, mergeUcPreset } from '../src/shared/nai-presets'

const request = {
  prompt: '1girl',
  negativePrompt: 'bad hands',
  model: 'nai-diffusion-5-full',
  width: 1024,
  height: 1024,
  steps: 28,
  cfgScale: 5,
  cfgRescale: 0,
  sampler: 'k_euler_ancestral',
  noiseSchedule: 'karras',
  seed: 1,
  variety: false,
  qualityToggle: true,
  ucPreset: 0,
  characterPrompts: [],
  useCoords: false
} as GenerationRequest

describe('UC preset text per model', () => {
  it('V5 High with Heavy sends the V5 heavy text (no nsfw), like the NAI web', () => {
    const p = buildGenerateImagePayload(request)
    expect(p.parameters.negative_prompt).toBe(UC_HEAVY_V5 + ', bad hands')
    expect(String(p.parameters.negative_prompt).startsWith('nsfw')).toBe(false)
    const neg = p.parameters.v4_negative_prompt as { caption: { base_caption: string } }
    expect(neg.caption.base_caption).toBe(UC_HEAVY_V5 + ', bad hands')
  })

  it('V5 inpaint uses the V5 text too; V4.5 keeps its own text', () => {
    expect(mergeUcPreset('', 0, 'nai-diffusion-5-full-inpainting')).toBe(UC_HEAVY_V5)
    expect(mergeUcPreset('', 0, 'nai-diffusion-5-curated')).toBe(UC_HEAVY_V5)
    const v45 = buildGenerateImagePayload({ ...request, model: 'nai-diffusion-4-5-full' })
    expect(v45.parameters.negative_prompt).toBe(UC_PRESETS_V45_FULL[0] + ', bad hands')
    expect(mergeUcPreset('x', 0)).toBe(UC_PRESETS_V45_FULL[0] + ', x')
    expect(mergeUcPreset('x', 4, 'nai-diffusion-5-full')).toBe('x')
  })
})
