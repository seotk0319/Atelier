import { describe, expect, it } from 'vitest'
import type { GenerationRequest } from '../src/shared/types'
import { buildGenerateImagePayload } from '../src/main/nai/payload'
import { UC_HEAVY_V5 } from '../src/shared/nai-presets'
import { fullModelForVersion, withEffort, withFixedSettings } from '../src/shared/nai-models'
import { estimateAnlas } from '../src/shared/anlas'
import { estimateV5Images } from '../src/shared/v5-usage'
import { modelFromMetadata } from '../src/renderer/src/lib/metadata-request'

const request: GenerationRequest = {
  prompt: '1girl, -3::hat::',
  negativePrompt: 'bad hands, extra fingers',
  model: 'nai-diffusion-5-full-medium',
  width: 832,
  height: 1216,
  steps: 28,
  cfgScale: 5,
  cfgRescale: 0.4,
  sampler: 'k_dpmpp_2m_sde',
  noiseSchedule: 'karras',
  seed: 42,
  variety: false,
  qualityToggle: true,
  ucPreset: 4,
  characterPrompts: [
    { prompt: 'girl', negativePrompt: 'glasses', enabled: true, center: { x: 0.5, y: 0.5 } }
  ],
  useCoords: false
} as GenerationRequest

describe('V5 Full medium effort (NAI 웹 fixedSettings 기준)', () => {
  it('sends the medium model with 14 steps, Euler Ancestral, no rescale and only the V5 heavy preset as UC', () => {
    const p = buildGenerateImagePayload(request)
    expect(p.model).toBe('nai-diffusion-5-full-medium')
    expect(p.parameters).toMatchObject({
      steps: 14,
      sampler: 'k_euler_ancestral',
      cfg_rescale: 0,
      ucPreset: 0,
      negative_prompt: UC_HEAVY_V5
    })
    expect(UC_HEAVY_V5.startsWith('lowres')).toBe(true)
    const neg = p.parameters.v4_negative_prompt as {
      caption: { base_caption: string; char_captions: { char_caption: string }[] }
    }
    expect(neg.caption.base_caption).toBe(UC_HEAVY_V5)
    expect(neg.caption.char_captions[0].char_caption).toBe('')
    expect((p.parameters.characterPrompts as { uc: string }[])[0].uc).toBe('')
    // 프롬프트 안의 음수 가중치(빼기)는 그대로 간다
    expect(p.input.startsWith('1girl, -3::hat::')).toBe(true)
  })

  it('leaves High (V5 Full) requests and the stored settings untouched', () => {
    const high = { ...request, model: 'nai-diffusion-5-full' }
    expect(withFixedSettings(high)).toBe(high)
    const p = buildGenerateImagePayload(high)
    expect(p.parameters).toMatchObject({ steps: 28, sampler: 'k_dpmpp_2m_sde', cfg_rescale: 0.4 })
    expect(p.parameters.negative_prompt).toBe('bad hands, extra fingers')
    expect(request.steps).toBe(28)
  })

  it('switches effort only for V5 Full and keeps inpainting', () => {
    expect(withEffort('nai-diffusion-5-full', true)).toBe('nai-diffusion-5-full-medium')
    expect(withEffort('nai-diffusion-5-full-medium-inpainting', false)).toBe(
      'nai-diffusion-5-full-inpainting'
    )
    expect(withEffort('nai-diffusion-5-full-inpainting', true)).toBe(
      'nai-diffusion-5-full-medium-inpainting'
    )
    expect(withEffort('nai-diffusion-4-5-full', true)).toBe('nai-diffusion-4-5-full')
    expect(fullModelForVersion('5', true, true)).toBe('nai-diffusion-5-full-medium-inpainting')
    expect(modelFromMetadata('NovelAI Diffusion V5 93F4BD30')).toBe('nai-diffusion-5-full-medium')
    expect(modelFromMetadata('NovelAI Diffusion V5 70AB5786')).toBe('nai-diffusion-5-full-medium')
  })

  it('estimates medium as cheaper in Anlas and in V5 usage', () => {
    const base = { width: 1216, height: 832, isOpus: false, batchCount: 1 }
    const high = estimateAnlas({ ...base, steps: 23 }).perImage
    const medium = estimateAnlas({
      ...base,
      steps: 14,
      model: 'nai-diffusion-5-full-medium'
    }).perImage
    expect(medium).toBeLessThan(high * 0.7)
    const usage = { percent: 50, isNegative: false, timeUntilNextPercent: 0 } as never
    expect(estimateV5Images(usage)).toBe(865)
    expect(estimateV5Images(usage, 'nai-diffusion-5-full-medium')).toBe(Math.floor(865 / 0.58))
  })
})
