import type { BaseRef, CharRefType, ExtraCharRef } from './types'

/**
 * 기준 레퍼 (씬·프리셋에 저장해 두는 캐릭터 레퍼런스).
 *
 * - 씬에 기준 레퍼가 있으면 씬 것, 없으면 그 씬이 든 프리셋 것을 쓴다 (sceneOrPresetRefs).
 * - 기준 레퍼가 있는 씬을 뽑으면 화면(레퍼 창)에서 켜 둔 레퍼는 싣지 않는다 —
 *   프리셋 캐릭터 바인드가 사이드바 캐릭터를 대신하는 것과 같은 규칙이다.
 *   일회성 레퍼(선별 인페인트의 기준 그림)는 그대로 함께 싣는다.
 * - V5 기준이라 충실도는 없고 강도(0~5)만 둔다. 보낼 때 fidelity는 1.
 */

export const BASE_REF_MAX = 4
export const BASE_REF_DEFAULT_STRENGTH = 2.5
export const BASE_REF_DEFAULT_TYPE: CharRefType = 'character'

/** 화면에서 고르는 세 가지. 캐릭터 계열은 둘 다 옷을 프롬프트대로 입힌다. */
export const BASE_REF_TYPE_CHOICES: { type: CharRefType; label: string }[] = [
  { type: 'character', label: '캐릭터' },
  { type: 'character&style_anyoutfit', label: '캐릭터&스타일' },
  { type: 'costume', label: '의상' }
]

/** 저장할 수 있는 종류 — 클로 생성 창구가 받는 것과 같다 (delta는 그림 경로만으로 못 만든다) */
export const BASE_REF_TYPES: readonly CharRefType[] = [
  'character',
  'style',
  'character&style',
  'costume',
  'character_mainoutfit',
  'character&style_anyoutfit'
]

const REF_EXT = /\.(png|webp|jpe?g)$/i
const ABS_PATH = /^(?:[A-Za-z]:[\\/]|\/)/

export function baseRefTypeLabel(type: CharRefType): string {
  const choice = BASE_REF_TYPE_CHOICES.find((c) => c.type === type)
  if (choice) return choice.label
  switch (type) {
    case 'character_mainoutfit':
      return '캐릭터(옷 포함)'
    case 'character&style':
      return '캐릭터&스타일(옷 포함)'
    case 'style':
      return '스타일'
    default:
      return type
  }
}

/**
 * 받은 값을 확인해 고친 목록으로 돌려준다. 빈 목록·null은 null(지우기).
 * 파일이 있는지는 보지 않는다 (본체에서 따로 본다).
 */
export function normalizeBaseRefs(
  input: unknown
): { ok: true; refs: BaseRef[] | null } | { ok: false; error: string } {
  if (input === null || input === undefined) return { ok: true, refs: null }
  if (!Array.isArray(input)) return { ok: false, error: '기준 레퍼는 배열이어야 해요' }
  if (input.length === 0) return { ok: true, refs: null }
  if (input.length > BASE_REF_MAX)
    return { ok: false, error: `기준 레퍼는 ${BASE_REF_MAX}장까지예요` }
  const refs: BaseRef[] = []
  for (const raw of input as Record<string, unknown>[]) {
    if (!raw || typeof raw !== 'object') return { ok: false, error: '잘못된 기준 레퍼 항목' }
    const filePath = typeof raw.filePath === 'string' ? raw.filePath.trim() : ''
    if (!filePath || !ABS_PATH.test(filePath) || !REF_EXT.test(filePath))
      return { ok: false, error: '기준 레퍼 filePath는 png·webp·jpg 절대 경로예요' }
    const refType = raw.refType === undefined ? BASE_REF_DEFAULT_TYPE : raw.refType
    if (typeof refType !== 'string' || !BASE_REF_TYPES.includes(refType as CharRefType))
      return { ok: false, error: `기준 레퍼 refType은 ${BASE_REF_TYPES.join('|')} 중 하나예요` }
    const strength = raw.strength === undefined ? BASE_REF_DEFAULT_STRENGTH : raw.strength
    if (typeof strength !== 'number' || !Number.isFinite(strength) || strength < 0 || strength > 5)
      return { ok: false, error: '기준 레퍼 strength는 0~5예요' }
    refs.push({ filePath, refType: refType as CharRefType, strength })
  }
  return { ok: true, refs }
}

/** DB에 든 JSON → 목록. 깨졌거나 비었으면 null */
export function parseBaseRefs(raw: string | null | undefined): BaseRef[] | null {
  if (!raw) return null
  try {
    const checked = normalizeBaseRefs(JSON.parse(raw))
    return checked.ok ? checked.refs : null
  } catch {
    return null
  }
}

export function serializeBaseRefs(refs: BaseRef[] | null | undefined): string | null {
  return refs && refs.length > 0 ? JSON.stringify(refs) : null
}

/** 씬 것이 있으면 씬 것, 없으면 프리셋 것 */
export function sceneOrPresetRefs(
  sceneRefs: BaseRef[] | null | undefined,
  presetRefs: BaseRef[] | null | undefined
): { refs: BaseRef[]; from: 'scene' | 'preset' } | null {
  if (sceneRefs && sceneRefs.length > 0) return { refs: sceneRefs, from: 'scene' }
  if (presetRefs && presetRefs.length > 0) return { refs: presetRefs, from: 'preset' }
  return null
}

/** 파일 이름만 (윈도·유닉스 구분자 모두) */
export function baseRefFileName(filePath: string): string {
  const parts = filePath.split(/[\\/]/)
  return parts[parts.length - 1] || filePath
}

/**
 * 생성 직전에 실을 레퍼를 정한다.
 * - 클로 생성 창구 요청: 건에 받은 레퍼(extra)만. 기준 레퍼·화면 레퍼는 싣지 않는다.
 * - 기준 레퍼가 있는 씬: 일회성 레퍼 + 기준 레퍼, 화면에서 켜 둔 레퍼는 뺀다.
 * - 그 밖: 지금까지처럼 일회성 레퍼 + 화면 레퍼.
 */
export function refsWithBase(
  extra: ExtraCharRef[] | undefined,
  base: BaseRef[] | null | undefined,
  fromClaude: boolean
): { extraCharRefs: ExtraCharRef[]; screenRefs: boolean } {
  const own = extra ?? []
  if (fromClaude) return { extraCharRefs: own, screenRefs: false }
  if (!base || base.length === 0) return { extraCharRefs: own, screenRefs: true }
  return {
    extraCharRefs: [...own, ...base.map((r) => ({ ...r, fidelity: 1 }))],
    screenRefs: false
  }
}
