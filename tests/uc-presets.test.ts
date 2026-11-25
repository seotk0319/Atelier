import { describe, expect, it } from 'vitest'
import {
  inferUcPresetIndex,
  mergeUcPreset,
  mergeUcPresetForModel,
  stripUcPresetText,
  UC_PRESETS_V5
} from '../src/shared/nai-presets'

// NAI 웹 번들(2026-11-25)의 UC 병합 규칙: 프리셋 원문에는 nsfw가 없고, Curated가 아니고 프리셋이 있고
// 프롬프트에 nsfw가 없을 때만 앞에 "nsfw, "를 붙인다.
const SFW = '1girl, smile, very aesthetic, masterpiece, no text'
const NSFW = '1girl, nsfw, nude, very aesthetic, masterpiece, no text'

describe('UC 프리셋 병합 (NAI 웹 규칙)', () => {
  it('V4.5 Full·V5 Full의 SFW 프롬프트는 예전 V4.5 병합과 같다', () => {
    for (const model of ['nai-diffusion-4-5-full', 'nai-diffusion-5-full']) {
      for (const idx of [0, 3] as const) {
        expect(mergeUcPresetForModel('bad hands', idx, model, SFW), `${model} ${idx}`).toBe(
          mergeUcPreset('bad hands', idx)
        )
      }
    }
    expect(mergeUcPresetForModel('x', 1, 'nai-diffusion-4-5-full', SFW)).toBe(mergeUcPreset('x', 1))
  })

  it('프롬프트에 nsfw가 있으면 네거티브에 nsfw를 넣지 않는다', () => {
    const v45 = mergeUcPresetForModel('bad hands', 0, 'nai-diffusion-4-5-full', NSFW)
    expect(v45.startsWith('lowres, ')).toBe(true)
    expect(v45.endsWith(', bad hands')).toBe(true)
    expect(v45.includes('nsfw')).toBe(false)
    expect(mergeUcPresetForModel('', 0, 'nai-diffusion-5-full-medium', NSFW)).toBe(UC_PRESETS_V5[0])
  })

  it('V5 Light는 V5 문구, Curated에는 nsfw가 붙지 않고, None이면 네거티브만', () => {
    expect(mergeUcPresetForModel('', 1, 'nai-diffusion-5-full', SFW)).toBe(
      `nsfw, ${UC_PRESETS_V5[1]}`
    )
    expect(mergeUcPresetForModel('x', 1, 'nai-diffusion-5-curated', SFW)).toBe(
      `${UC_PRESETS_V5[1]}, x`
    )
    expect(mergeUcPresetForModel('x', 4, 'nai-diffusion-5-full', SFW)).toBe('x')
    expect(mergeUcPresetForModel('', 4, 'nai-diffusion-5-full', SFW)).toBe('')
    // 인페인트 모델도 같은 표
    expect(mergeUcPresetForModel('', 1, 'nai-diffusion-5-full-inpainting', NSFW)).toBe(
      UC_PRESETS_V5[1]
    )
  })

  it('메타데이터의 병합된 네거티브에서 V5 프리셋도 알아보고 벗긴다 (두 번 붙지 않게)', () => {
    const webLightFull = `nsfw, ${UC_PRESETS_V5[1]}, blurry`
    expect(inferUcPresetIndex(webLightFull)).toBe(1)
    expect(stripUcPresetText(webLightFull, 1)).toBe('blurry')
    const curatedHeavy = `${UC_PRESETS_V5[0]}, extra`
    expect(inferUcPresetIndex(curatedHeavy)).toBe(0)
    expect(stripUcPresetText(curatedHeavy, 0)).toBe('extra')
    // Human Focus는 Heavy로 시작하지만 더 긴 쪽으로 알아본다
    expect(inferUcPresetIndex(mergeUcPreset('z', 3))).toBe(3)
    expect(inferUcPresetIndex('just my words')).toBeUndefined()
  })
})
