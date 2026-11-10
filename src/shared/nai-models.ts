import type { GenerationRequest } from './types'

export const NAI_MODEL_V45_FULL = 'nai-diffusion-4-5-full'
export const NAI_MODEL_V5_FULL = 'nai-diffusion-5-full'
/**
 * V5 Full "Medium" effort (2026-10-08 공지, NAI 웹 코드 확인). 원래 모델을 14스텝으로 증류한 별도 모델이고,
 * 웹은 스텝 14 · Euler Ancestral · UC 프리셋 heavy를 고정하고 사용자 네거티브와 캐릭터 네거티브를 비워 보낸다.
 * CFG Rescale도 지원하지 않는다. 사용량은 기본 설정 기준 약 42% 적다.
 */
export const NAI_MODEL_V5_FULL_MEDIUM = 'nai-diffusion-5-full-medium'
export const MEDIUM_EFFORT_STEPS = 14
export const MEDIUM_EFFORT_SAMPLER = 'k_euler_ancestral'
/** NAI 공지: 기본 설정에서 High(23스텝)보다 약 42% 적게 쓴다 */
export const MEDIUM_EFFORT_USAGE_RATIO = 0.58

export function isMediumEffort(model: string): boolean {
  return model.startsWith(NAI_MODEL_V5_FULL_MEDIUM)
}

/** V5 Full 계열만 High/Medium을 바꾼다 (인페인트 여부 유지). 다른 모델은 그대로 돌려준다. */
export function withEffort(model: string, medium: boolean): string {
  const inpainting = model.endsWith('-inpainting')
  const base = model.replace(/-inpainting$/, '')
  if (base !== NAI_MODEL_V5_FULL && base !== NAI_MODEL_V5_FULL_MEDIUM) return model
  return (medium ? NAI_MODEL_V5_FULL_MEDIUM : NAI_MODEL_V5_FULL) + (inpainting ? '-inpainting' : '')
}

/**
 * Medium이면 웹과 같이 고정값을 덮어쓴다. 저장된 설정은 건드리지 않고 보내기 직전에만 쓴다
 * (High로 돌아가면 원래 스텝·샘플러·네거티브가 그대로 살아 있게).
 */
export function withFixedSettings<
  T extends Pick<
    GenerationRequest,
    | 'model'
    | 'steps'
    | 'sampler'
    | 'cfgRescale'
    | 'negativePrompt'
    | 'ucPreset'
    | 'characterPrompts'
  >
>(req: T): T {
  if (!isMediumEffort(req.model)) return req
  return {
    ...req,
    steps: MEDIUM_EFFORT_STEPS,
    sampler: MEDIUM_EFFORT_SAMPLER,
    cfgRescale: 0,
    negativePrompt: '',
    ucPreset: 0,
    characterPrompts: req.characterPrompts.map((c) => ({ ...c, negativePrompt: '' }))
  }
}

/** NovelAI 웹의 이미지 프롬프트 한도. V5 Curated도 메타데이터 불러오기를 위해 구분한다. */
export const NAI_TOKEN_LIMIT_V45 = 512
export const NAI_TOKEN_LIMIT_V5_CURATED = 703
export const NAI_TOKEN_LIMIT_V5_FULL = 1471

export function isV5Model(model: string): boolean {
  return model.includes('nai-diffusion-5-')
}

/**
 * 바이브 트랜스퍼·캐릭터 레퍼런스를 요청에 실을 수 있는 모델인지. V5는 둘 다 받지 않는다
 * (원본 NAIS3 v1.0.19 modelCapabilities와 같은 기준).
 */
export function supportsReferences(model: string): boolean {
  return !isV5Model(model)
}

/** NAI 웹 모델 설정: V4.5는 캐릭터 6명, V5는 32명까지 (NAI 웹 코드 확인) */
export function maxCharactersForModel(model: string): number {
  return isV5Model(model) ? 32 : 6
}

/** V5는 캐릭터 위치를 0~1 자유 좌표로, V4.5는 5×5 칸(0.1~0.9)으로만 받는다 */
export function freeformPositionForModel(model: string): boolean {
  return isV5Model(model)
}

const GRID = [0.1, 0.3, 0.5, 0.7, 0.9]
/** 가장 가까운 5×5 칸 좌표로 맞춘다 (V4.5용) */
export function snapToGrid(center: { x: number; y: number }): { x: number; y: number } {
  const snap = (v: number): number =>
    GRID.reduce((best, g) => (Math.abs(g - v) < Math.abs(best - v) ? g : best), 0.5)
  return { x: snap(center.x), y: snap(center.y) }
}

/**
 * 새 캐릭터를 놓을 빈 자리 (NAI 웹과 같은 순서): 가운데 줄 0.5 → 0.3 → 0.7 → 0.1 → 0.9,
 * 그다음 가운데에서 가까운 칸부터. 자유 좌표에서는 0.1보다 가까우면 겹친 것으로 본다.
 */
const PLACEMENT_ORDER = [
  ...[0.5, 0.3, 0.7, 0.1, 0.9].map((x) => ({ x, y: 0.5 })),
  ...[0.1, 0.3, 0.7, 0.9]
    .flatMap((y) => GRID.map((x) => ({ x, y })))
    .sort(
      (a, b) =>
        Math.hypot(a.x - 0.5, a.y - 0.5) - Math.hypot(b.x - 0.5, b.y - 0.5) ||
        Math.abs(a.y - 0.5) - Math.abs(b.y - 0.5) ||
        a.x - b.x ||
        a.y - b.y
    )
]
export const CHARACTER_OVERLAP_DISTANCE = 0.1
export function nextFreeCenter(taken: { x: number; y: number }[]): { x: number; y: number } {
  for (const spot of PLACEMENT_ORDER)
    if (!taken.some((c) => Math.hypot(c.x - spot.x, c.y - spot.y) < CHARACTER_OVERLAP_DISTANCE))
      return spot
  return { x: 0.5, y: 0.5 }
}

export function tokenLimitForModel(model: string): number {
  if (!isV5Model(model)) return NAI_TOKEN_LIMIT_V45
  return model.includes('curated') ? NAI_TOKEN_LIMIT_V5_CURATED : NAI_TOKEN_LIMIT_V5_FULL
}

export function fullModelForVersion(
  version: '4.5' | '5',
  inpainting = false,
  medium = false
): string {
  const model =
    version === '5' ? (medium ? NAI_MODEL_V5_FULL_MEDIUM : NAI_MODEL_V5_FULL) : NAI_MODEL_V45_FULL
  return inpainting ? `${model}-inpainting` : model
}
