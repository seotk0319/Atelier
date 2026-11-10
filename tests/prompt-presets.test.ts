import { describe, expect, it, beforeAll } from 'vitest'
import type { PresetParams, PromptPreset } from '../src/shared/types'

beforeAll(() => {
  const store = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key)
    },
    configurable: true
  })
})

type Helpers = typeof import('../src/renderer/src/stores/prompt-presets-store')
async function helpers(): Promise<Helpers> {
  return await import('../src/renderer/src/stores/prompt-presets-store')
}

describe('prompt preset sync guards', () => {
  const base: Pick<PromptPreset, 'prompt' | 'negativePrompt' | 'params'> = {
    prompt: 'old prompt',
    negativePrompt: 'old neg',
    params: null
  }

  it('does not backfill legacy null params during preset apply/no-op sync', async () => {
    const { shouldSyncPromptPreset } = await helpers()
    expect(
      shouldSyncPromptPreset(base, {
        prompt: 'old prompt',
        negativePrompt: 'old neg',
        params: { steps: 28, cfgScale: 6, cfgRescale: 0.56, sampler: 'k_euler', ucPreset: 0 }
      })
    ).toBe(false)
  })

  it('still syncs explicit prompt edits for legacy presets', async () => {
    const { shouldSyncPromptPreset } = await helpers()
    expect(
      shouldSyncPromptPreset(base, {
        prompt: 'new prompt',
        negativePrompt: 'old neg',
        params: { steps: 28 }
      })
    ).toBe(true)
  })

  it('syncs params for presets that already own params', async () => {
    const { shouldSyncPromptPreset } = await helpers()
    expect(
      shouldSyncPromptPreset(
        { ...base, params: { steps: 20, cfgScale: 5 } satisfies PresetParams },
        { prompt: 'old prompt', negativePrompt: 'old neg', params: { steps: 30, cfgScale: 7 } }
      )
    ).toBe(true)
  })

  it('resets split prompt parts when applying another preset', async () => {
    const { splitPromptForPreset } = await helpers()
    expect(splitPromptForPreset('1girl, blue hair')).toEqual({
      base: '1girl, blue hair',
      additional: '',
      detail: ''
    })
  })
})

describe('preset params on apply (이전 프리셋 값이 딸려 오지 않게)', () => {
  const full = {
    width: 832,
    height: 1216,
    cfgRescale: 0,
    sampler: 'k_euler_ancestral',
    noiseSchedule: 'karras',
    variety: false,
    qualityToggle: true,
    transparentBackground: false,
    ucPreset: 0
  }

  it('params가 없는 옛 프리셋은 모든 칸을 지금 모델의 기본값으로 채운다', async () => {
    const { presetParamsForApply } = await helpers()
    expect(presetParamsForApply(null, 'nai-diffusion-4-5-full')).toEqual({
      ...full,
      model: 'nai-diffusion-4-5-full',
      steps: 28,
      cfgScale: 5
    })
    expect(presetParamsForApply(null, 'nai-diffusion-5-full')).toEqual({
      ...full,
      model: 'nai-diffusion-5-full',
      steps: 23,
      cfgScale: 7
    })
  })

  it('저장된 칸은 그대로, 빠진 칸은 저장된 모델의 기본값', async () => {
    const { presetParamsForApply } = await helpers()
    const applied = presetParamsForApply(
      { model: 'nai-diffusion-5-full', steps: 40, cfgScale: undefined },
      'nai-diffusion-4-5-full'
    )
    expect(applied.model).toBe('nai-diffusion-5-full')
    expect(applied.steps).toBe(40)
    expect(applied.cfgScale).toBe(7)
    expect(applied.sampler).toBe('k_euler_ancestral')
  })

  it('직전 프리셋이 무엇이었든 같은 값이 된다', async () => {
    const { presetParamsForApply } = await helpers()
    const partial = { model: 'nai-diffusion-4-5-full', steps: 28, cfgScale: 5 }
    const afterV5 = presetParamsForApply(partial, 'nai-diffusion-5-full')
    expect(afterV5).toEqual(presetParamsForApply(partial, 'nai-diffusion-4-5-curated'))
    expect(Object.values(afterV5)).not.toContain(undefined)
  })

  it('적용 결과를 요청에 덮으면 이전 요청의 생성 값이 남지 않는다', async () => {
    const { presetParamsForApply, pickPresetParams } = await helpers()
    const { DEFAULT_REQUEST } = await import('../src/renderer/src/stores/generation-store')
    const previous = {
      ...DEFAULT_REQUEST,
      steps: 50,
      cfgScale: 9,
      sampler: 'k_dpmpp_2m',
      width: 1024,
      height: 1024,
      transparentBackground: true
    }
    const next = { ...previous, ...presetParamsForApply({ steps: 30 }, previous.model) }
    expect(pickPresetParams(next)).toEqual({
      ...full,
      model: previous.model,
      steps: 30,
      cfgScale: 5
    })
  })
})

describe('prompt preset split parts (3분할 보존)', () => {
  const parts = { base: '1girl', additional: 'smile', detail: 'cafe' }
  const merged = '1girl, smile, cafe'

  it('restores stored parts when they match the preset prompt', async () => {
    const { partsForApply } = await helpers()
    expect(partsForApply({ prompt: merged, promptParts: parts })).toEqual(parts)
  })

  it('reseeds when stored parts are stale (prompt edited while split off)', async () => {
    const { partsForApply } = await helpers()
    expect(partsForApply({ prompt: '1girl, edited', promptParts: parts })).toEqual({
      base: '1girl, edited',
      additional: '',
      detail: ''
    })
  })

  it('reseeds when no parts are stored', async () => {
    const { partsForApply } = await helpers()
    expect(partsForApply({ prompt: 'solo', promptParts: null })).toEqual({
      base: 'solo',
      additional: '',
      detail: ''
    })
  })

  it('normalizes trivial parts (base only) to null', async () => {
    const { normalizePresetParts } = await helpers()
    expect(normalizePresetParts({ base: '1girl', additional: '', detail: ' ' })).toBeNull()
    expect(normalizePresetParts({ base: '1girl', additional: 'smile', detail: '' })).toEqual({
      base: '1girl',
      additional: 'smile',
      detail: ''
    })
  })

  it('syncs when split parts change but merged prompt stays the same', async () => {
    const { shouldSyncPromptPreset } = await helpers()
    expect(
      shouldSyncPromptPreset(
        { prompt: merged, negativePrompt: '', params: { steps: 28 }, promptParts: parts },
        {
          prompt: merged,
          negativePrompt: '',
          params: { steps: 28 },
          promptParts: { base: '1girl, smile', additional: 'cafe', detail: '' }
        }
      )
    ).toBe(true)
  })

  it('does not touch stored parts when split is off (promptParts undefined)', async () => {
    const { shouldSyncPromptPreset } = await helpers()
    expect(
      shouldSyncPromptPreset(
        { prompt: merged, negativePrompt: '', params: { steps: 28 }, promptParts: parts },
        { prompt: merged, negativePrompt: '', params: { steps: 28 } }
      )
    ).toBe(false)
  })

  it('legacy preset guard still holds with trivial parts', async () => {
    const { shouldSyncPromptPreset } = await helpers()
    expect(
      shouldSyncPromptPreset(
        { prompt: 'old', negativePrompt: '', params: null, promptParts: null },
        {
          prompt: 'old',
          negativePrompt: '',
          params: { steps: 28 },
          promptParts: { base: 'old', additional: '', detail: '' }
        }
      )
    ).toBe(false)
  })
})
