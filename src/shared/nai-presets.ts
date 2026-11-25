import type { UcPresetIndex } from './types'

/**
 * NAI 웹이 클라이언트에서 병합하는 프리셋 텍스트 (실캡처 확정).
 * payload 조립(메인)과 토큰 카운트 표시(렌더러)가 공유한다 —
 * 카운트는 병합 "후" 텍스트 기준이어야 웹 표시와 일치한다.
 */

/** 실캡처 확정 (V4.5 full): 프롬프트 "뒤"에 그대로 이어 붙는다 */
export const QUALITY_TAGS_SUFFIX = ', very aesthetic, masterpiece, no text'

const UC_HEAVY =
  'nsfw, lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page'

/**
 * V5 계열 heavy 프리셋 (NAI 웹 코드 2026-10-09 확인). V4.5와 달리 nsfw가 없다.
 * V5 Full Medium은 네거티브를 받지 않고 이 텍스트만 보낸다.
 */
export const UC_HEAVY_V5 =
  'lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page'

/** 인덱스 매핑 (실캡처): 0=Heavy, 1=Light, 3=Human Focus, 4=None. 2는 미사용 */
export const UC_PRESETS_V45_FULL: Record<UcPresetIndex, string> = {
  0: UC_HEAVY,
  1: 'nsfw, lowres, artistic error, scan artifacts, worst quality, bad quality, jpeg artifacts, multiple views, very displeasing, too many watermarks, negative space, blank page',
  2: '',
  3: UC_HEAVY + ', @_@, mismatched pupils, glowing eyes, bad anatomy',
  4: ''
}

/** 줄 맨 앞(선행 공백 허용)이 #인 주석 줄만 제거한다. 줄 중간의 #은 NAI 문법으로 보존한다. */
export function removeComments(prompt: string): string {
  return prompt
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n')
}

/**
 * V5 투명 배경 (NAI 웹 코드 확인): 켜면 퀄리티 접미사 "앞"에 이 태그가 붙는다.
 * 퀄리티 태그가 꺼져 있으면 이 태그만 붙는다.
 */
export const TRANSPARENT_BG_TAG = 'transparent background'

export function mergeQualityTags(
  prompt: string,
  qualityToggle: boolean,
  transparentBackground = false
): string {
  if (!transparentBackground) return qualityToggle ? prompt + QUALITY_TAGS_SUFFIX : prompt
  const suffix = TRANSPARENT_BG_TAG + (qualityToggle ? QUALITY_TAGS_SUFFIX : '')
  return prompt ? prompt + ', ' + suffix : suffix
}

/** 병합된 프롬프트에서 퀄리티·투명 배경 접미사를 떼어 원문과 스위치 상태를 돌려준다. */
export function splitQualityTags(prompt: string): {
  prompt: string
  quality: boolean
  transparent: boolean
} {
  let rest = prompt
  const quality = rest.endsWith(QUALITY_TAGS_SUFFIX)
  if (quality) rest = rest.slice(0, -QUALITY_TAGS_SUFFIX.length)
  let transparent = false
  if (rest === TRANSPARENT_BG_TAG) {
    rest = ''
    transparent = true
  } else if (rest.endsWith(', ' + TRANSPARENT_BG_TAG)) {
    rest = rest.slice(0, -(TRANSPARENT_BG_TAG.length + 2))
    transparent = true
  }
  // 투명 배경 없이 퀄리티만 켠 경우는 예전 형식 그대로 (접미사가 ", "로 시작)
  return { prompt: rest, quality, transparent }
}

/** 캡처 확정: 프리셋 텍스트 + ", " + 유저 네거티브 순서로 병합 */
export function mergeUcPreset(negativePrompt: string, ucPreset: UcPresetIndex): string {
  const preset = UC_PRESETS_V45_FULL[ucPreset]
  if (!preset) return negativePrompt
  return negativePrompt ? preset + ', ' + negativePrompt : preset
}

/*
 * NAI 웹 번들(2026-11-25 novelai.net/image 스크립트 확인)의 UC 프리셋 표와 병합 규칙.
 * 웹은 프리셋 원문에 nsfw를 넣지 않고, Curated가 아닌 모델에서 프리셋이 None이 아니고 (퀄리티 태그까지
 * 붙인) 프롬프트에 "nsfw"가 없을 때만 맨 앞에 "nsfw, "를 붙인다. 그래서 V4.5 Full·V5 Full의 Heavy·Light·
 * Human Focus는 SFW 프롬프트에서 위 UC_PRESETS_V45_FULL과 같고, 프롬프트에 nsfw가 있으면 nsfw가 빠진다.
 * V5 Light는 문구가 다르고, Curated에는 nsfw가 붙지 않는다. Atelier 인덱스: 0=Heavy 1=Light 3=Human Focus 4=None.
 */
const WEB_HEAVY =
  'lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page'
const WEB_HUMAN = WEB_HEAVY + ', @_@, mismatched pupils, glowing eyes, bad anatomy'

const UC_WEB_V45_FULL: Record<UcPresetIndex, string> = {
  0: WEB_HEAVY,
  1: 'lowres, artistic error, scan artifacts, worst quality, bad quality, jpeg artifacts, multiple views, very displeasing, too many watermarks, negative space, blank page',
  2: '',
  3: WEB_HUMAN,
  4: ''
}

/** V5 Full·Full Medium·Curated(인페인트 포함) 공통 */
export const UC_PRESETS_V5: Record<UcPresetIndex, string> = {
  0: WEB_HEAVY,
  1: 'lowres, bad hands, bad anatomy, artistic error, sepia, white haze, worst quality, very displeasing, jpeg artifacts, 0::ai-generated::',
  2: '',
  3: WEB_HUMAN,
  4: ''
}

const UC_WEB_V45_CURATED: Record<UcPresetIndex, string> = {
  0: 'blurry, lowres, upscaled, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, halftone, multiple views, logo, too many watermarks, negative space, blank page',
  1: 'blurry, lowres, upscaled, artistic error, scan artifacts, jpeg artifacts, logo, too many watermarks, negative space, blank page',
  2: '',
  3: 'blurry, lowres, upscaled, artistic error, film grain, scan artifacts, bad anatomy, bad hands, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, halftone, multiple views, logo, too many watermarks, @_@, mismatched pupils, glowing eyes, negative space, blank page',
  4: ''
}

/** 이 모델의 웹 UC 프리셋 표. 모르는 모델이면 null (예전 병합 규칙을 쓴다) */
function webUcPresets(model: string): Record<UcPresetIndex, string> | null {
  const base = model.replace(/-inpainting$/, '')
  if (base.startsWith('nai-diffusion-5-')) return UC_PRESETS_V5
  if (base === 'nai-diffusion-4-5-full') return UC_WEB_V45_FULL
  if (base === 'nai-diffusion-4-5-curated') return UC_WEB_V45_CURATED
  return null
}

/**
 * 모델별 웹 규칙으로 UC 프리셋을 병합한다. positivePrompt는 퀄리티 태그까지 붙인 보낼 프롬프트.
 * 웹 함수와 같다: 프리셋, ", ", 유저 네거티브 순서. Curated가 아니고 프리셋이 있고 프롬프트에 nsfw가
 * 없으면 맨 앞에 "nsfw, ".
 */
export function mergeUcPresetForModel(
  negativePrompt: string,
  ucPreset: UcPresetIndex,
  model: string,
  positivePrompt: string
): string {
  const table = webUcPresets(model)
  if (!table) return mergeUcPreset(negativePrompt, ucPreset)
  const preset = table[ucPreset] ?? ''
  const merged = !preset ? negativePrompt : negativePrompt ? `${preset}, ${negativePrompt}` : preset
  const curated = model.includes('curated')
  const addNsfw = !curated && preset !== '' && !positivePrompt.toLowerCase().includes('nsfw')
  if (!addNsfw) return merged
  return merged ? `nsfw, ${merged}` : 'nsfw'
}

/**
 * 메타데이터의 병합된 네거티브 앞에 붙어 있을 수 있는 이 프리셋의 모든 모양 (긴 것 먼저).
 * V4.5 표(nsfw 포함), 웹 표 그대로, 웹 표 + 앞 nsfw — 모델마다 다르게 붙어 있기 때문.
 */
export function ucPresetVariants(ucPreset: number): string[] {
  const idx = ucPreset as UcPresetIndex
  const texts = [
    UC_PRESETS_V45_FULL[idx],
    UC_WEB_V45_FULL[idx],
    UC_PRESETS_V5[idx],
    UC_WEB_V45_CURATED[idx]
  ].filter((t): t is string => !!t)
  const all = new Set<string>()
  for (const t of texts) {
    all.add(t)
    if (!t.startsWith('nsfw, ')) all.add(`nsfw, ${t}`)
  }
  return [...all].sort((a, b) => b.length - a.length)
}

/** 병합된 네거티브에서 이 프리셋을 벗긴다 (어느 모양이든). 못 찾으면 그대로 */
export function stripUcPresetText(uc: string, ucPreset: number): string {
  for (const preset of ucPresetVariants(ucPreset)) {
    if (uc === preset) return ''
    if (uc.startsWith(preset + ', ')) return uc.slice(preset.length + 2)
  }
  return uc
}

/** 병합된 네거티브에서 UC 프리셋 인덱스를 역추적 — 가장 긴 접두로 맞는 것 */
export function inferUcPresetIndex(uc: string): UcPresetIndex | undefined {
  let best: UcPresetIndex | undefined
  let bestLen = -1
  for (const idx of [0, 1, 3] as const) {
    for (const preset of ucPresetVariants(idx)) {
      if ((uc === preset || uc.startsWith(preset + ', ')) && preset.length > bestLen) {
        best = idx
        bestLen = preset.length
      }
    }
  }
  return best
}
