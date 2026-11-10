import { describe, expect, it } from 'vitest'
import { applyCharSections, gridCenter, sectionOf } from '../src/shared/char-sections'
import { buildGenerateImagePayload } from '../src/main/nai/payload'
import type { GenerationRequest } from '../src/shared/types'

describe('char section positions', () => {
  it('reads NAI grid cells (A1 top-left, C3 center, E5 bottom-right)', () => {
    expect(gridCenter('A1')).toEqual({ x: 0.1, y: 0.1 })
    expect(gridCenter('c3')).toEqual({ x: 0.5, y: 0.5 })
    expect(gridCenter('E5')).toEqual({ x: 0.9, y: 0.9 })
    expect(gridCenter('F1')).toBeNull()
  })

  it('accepts a position and an asset-generator code on the marker line', () => {
    expect(sectionOf('# == char2 B3 ==')).toBe(2)
    expect(sectionOf('# == char2 ns1 ==')).toBe(2)
    expect(sectionOf('# == char2 ns1 D3 ==')).toBe(2)
    expect(sectionOf('# == 구도 ==')).toBeNull()
  })

  it('sets centers and turns on manual positions only when a position is written', () => {
    const out = applyCharSections({
      prompt:
        '3girls\n# == char1 C3 ==\npink hair\n# == char2 B3 ==\nblonde hair\n# == char3 ==\npurple eyes',
      negativePrompt: '',
      characterPrompts: [],
      useCoords: false
    })
    expect(out.useCoords).toBe(true)
    expect(out.characterPrompts.map((c) => c.center)).toEqual([
      { x: 0.5, y: 0.5 },
      { x: 0.3, y: 0.5 },
      undefined
    ])
    const plain = applyCharSections({
      prompt: '2girls\n# == char1 ==\na\n# == char2 ==\nb',
      negativePrompt: '',
      characterPrompts: [],
      useCoords: false
    })
    expect(plain.useCoords).toBe(false)
  })

  it('sends the written positions to NAI with use_coords on', () => {
    const req = {
      prompt:
        '3girls\n# == char1 C3 ==\npink hair\n# == char2 B3 ==\nblonde hair\n# == char3 D3 ==\npurple eyes',
      negativePrompt: 'lowres',
      model: 'nai-diffusion-5-full',
      width: 1216,
      height: 832,
      steps: 28,
      cfgScale: 5,
      cfgRescale: 0,
      sampler: 'k_euler_ancestral',
      noiseSchedule: 'karras',
      seed: 1,
      variety: false,
      qualityToggle: false,
      ucPreset: 2,
      characterPrompts: [],
      useCoords: false
    } as GenerationRequest
    const p = buildGenerateImagePayload(applyCharSections(req)) as unknown as {
      parameters: {
        v4_prompt: {
          use_coords: boolean
          caption: { char_captions: { centers: { x: number; y: number }[] }[] }
        }
      }
    }
    expect(p.parameters.v4_prompt.use_coords).toBe(true)
    expect(p.parameters.v4_prompt.caption.char_captions.map((c) => c.centers[0])).toEqual([
      { x: 0.5, y: 0.5 },
      { x: 0.3, y: 0.5 },
      { x: 0.7, y: 0.5 }
    ])
  })
})
