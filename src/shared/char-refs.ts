import type { CharRefType } from './types'
import { isMediumEffort, isV5Model, withEffort } from './nai-models'

/**
 * Precise Reference (캐릭터 레퍼런스) 모델별 규칙 — NAI 웹 코드 확인 (2026-11-25, V5 출시 공지 당일).
 *
 * - V5 Curated/Full 모두 지원. Fidelity 슬라이더는 없고 웹은 fidelity 1(= secondary 0)로 고정해 보낸다.
 * - V5 강도 상한 5, V4.5는 1.
 * - V5 신규: 의상(costume) 레퍼런스, 「동일 의상 선호」 토글.
 *   토글은 description 값을 바꾼다:
 *     캐릭터          끔 character                    켬 character_mainoutfit
 *     캐릭터 & 스타일  끔 character&style_anyoutfit   켬 character&style
 * - V4.5로 보낼 때 웹은 costume을 빼고, character_mainoutfit → character,
 *   character&style_anyoutfit → character&style로 되돌린다.
 * - V5 레퍼런스는 Medium effort에서 못 쓴다 — 레퍼런스가 켜져 있으면 High로 생성한다.
 * - V5 인페인트는 레퍼런스를 지원하지 않는다 (웹은 무시하고 보낸다).
 */

/**
 * 화면에서는 「레퍼 그림에서 무엇을 따라 할지」를 세 칸(얼굴·머리 / 옷 / 그림체)으로 고른다.
 * 저장값(description)은 그 조합이다:
 *   얼굴                 character
 *   얼굴 + 옷            character_mainoutfit        (NAI 「Prefer same outfit」 켬)
 *   얼굴 + 그림체         character&style_anyoutfit
 *   얼굴 + 옷 + 그림체    character&style             (NAI 「Prefer same outfit」 켬)
 *   그림체               style
 *   옷                   costume (V5 전용)
 *   옷 + 그림체, 빈 조합   NAI에 없는 조합 — 고를 수 없다
 */
export type RefPart = 'face' | 'outfit' | 'style'

export const REF_PARTS: { value: RefPart; label: string; short: string }[] = [
  { value: 'face', label: '얼굴·머리', short: '얼굴' },
  { value: 'outfit', label: '옷', short: '옷' },
  { value: 'style', label: '그림체', short: '그림체' }
]

const PARTS_BY_TYPE: Record<CharRefType, RefPart[]> = {
  character: ['face'],
  character_mainoutfit: ['face', 'outfit'],
  'character&style_anyoutfit': ['face', 'style'],
  'character&style': ['face', 'outfit', 'style'],
  style: ['style'],
  costume: ['outfit'],
  delta: []
}

export function refParts(type: CharRefType): RefPart[] {
  return PARTS_BY_TYPE[type] ?? []
}

/** 화면에 켜진 것으로 보일 칸 — V4.5는 얼굴과 함께 쓴 옷을 따로 다루지 않으니 꺼진 것으로 보인다 */
export function shownRefParts(type: CharRefType, model: string): RefPart[] {
  if (isV5Model(model) || type === 'costume') return refParts(type)
  return refParts(type).filter((p) => p !== 'outfit')
}

/** 세 칸 조합 → 저장값. NAI에 없는 조합이면 null */
export function refTypeOfParts(parts: RefPart[]): CharRefType | null {
  const face = parts.includes('face')
  const outfit = parts.includes('outfit')
  const style = parts.includes('style')
  if (face) {
    if (style) return outfit ? 'character&style' : 'character&style_anyoutfit'
    return outfit ? 'character_mainoutfit' : 'character'
  }
  if (outfit && style) return null
  if (outfit) return 'costume'
  if (style) return 'style'
  return null
}

/** 한 칸을 눌렀을 때의 결과 — 못 누르면 이유를 준다 */
export function toggleRefPart(
  type: CharRefType,
  part: RefPart,
  model: string
): { type: CharRefType } | { blocked: string } {
  const has = refParts(type).includes(part)
  if (part === 'outfit' && !isV5Model(model))
    return { blocked: 'V4.5는 옷을 따로 고를 수 없어요 (V5에서만)' }
  const next = has ? refParts(type).filter((p) => p !== part) : [...refParts(type), part]
  const nextType = refTypeOfParts(next)
  // V4.5는 의상 레퍼런스를 보내지 않으니 「옷만」 남는 것도 빈 조합과 같다
  if (nextType && (nextType !== 'costume' || isV5Model(model))) return { type: nextType }
  if (nextType === 'costume') return { blocked: '하나는 골라야 해요' }
  if (next.length === 0) return { blocked: '하나는 골라야 해요' }
  return { blocked: '옷과 그림체만 같이 따라 하는 건 NAI가 못 해요. 얼굴·머리를 켜면 돼요' }
}

/** 고른 조합을 풀어 쓴 한 줄 — 칸 아래에 보여 준다 */
export function refPartsHint(type: CharRefType, model: string): string {
  if (!isRefSent(type, model)) return 'V4.5에서는 이 레퍼런스를 쓰지 않아요'
  const v5 = isV5Model(model)
  switch (type) {
    case 'character':
      return v5 ? '얼굴·머리만 따라 해요. 옷은 프롬프트대로 입혀요' : '얼굴·머리를 따라 해요'
    case 'character_mainoutfit':
      return v5 ? '얼굴·머리와 옷을 따라 해요' : '얼굴·머리를 따라 해요'
    case 'character&style_anyoutfit':
      return v5
        ? '얼굴·머리와 그림체를 따라 해요. 옷은 프롬프트대로 입혀요'
        : '얼굴·머리와 그림체를 따라 해요'
    case 'character&style':
      return v5 ? '얼굴·머리, 옷, 그림체를 모두 따라 해요' : '얼굴·머리와 그림체를 따라 해요'
    case 'style':
      return '그림체만 따라 해요'
    case 'costume':
      return '옷만 따라 해요. 인물은 프롬프트대로예요'
    default:
      return '예전 방식(델타) 레퍼런스예요'
  }
}

/** 이 모델로 생성할 때 실제로 보내는 레퍼런스인지 (V4.5는 의상을 뺀다) */
export function isRefSent(type: CharRefType, model: string): boolean {
  return isV5Model(model) || type !== 'costume'
}

/** 일괄 적용 대화상자의 선택지 — 「옷」이 든 조합은 V5에서만 의미가 있다 */
export const REF_TYPE_CHOICES: { type: CharRefType; label: string; v5Only?: boolean }[] = [
  { type: 'character&style', label: '얼굴·머리 + 옷 + 그림체', v5Only: true },
  { type: 'character&style_anyoutfit', label: '얼굴·머리 + 그림체' },
  { type: 'character_mainoutfit', label: '얼굴·머리 + 옷', v5Only: true },
  { type: 'character', label: '얼굴·머리' },
  { type: 'style', label: '그림체' },
  { type: 'costume', label: '옷', v5Only: true }
]

/** 카드 머리의 짧은 표시 — 「얼굴+옷+그림체 · 강도 0.60」 */
export function refShortLabel(type: CharRefType, model: string, strength?: number): string {
  if (!isRefSent(type, model)) return '옷 · V5에서만'
  if (type === 'delta')
    return strength === undefined ? '델타' : `델타 · 강도 ${strength.toFixed(2)}`
  const v5 = isV5Model(model)
  const parts = refParts(type)
    .filter((p) => v5 || p !== 'outfit')
    .map((p) => REF_PARTS.find((r) => r.value === p)!.short)
  const label = [parts.join('+')]
  if (strength !== undefined) label.push(`강도 ${strength.toFixed(2)}`)
  return label.join(' · ')
}

export function refStrengthMax(model: string): number {
  return isV5Model(model) ? 5 : 1
}

export function showsFidelity(model: string): boolean {
  return !isV5Model(model)
}

interface RefLike {
  referenceType: CharRefType
  fidelity: number
}

/** 보낼 모델에 맞춘다 — V5는 fidelity 1 고정, V4.5는 V5 전용 종류를 빼거나 되돌린다 */
export function refsForModel<T extends RefLike>(refs: T[], model: string): T[] {
  if (isV5Model(model)) return refs.map((r) => ({ ...r, fidelity: 1 }))
  return refs
    .filter((r) => r.referenceType !== 'costume')
    .map((r) =>
      r.referenceType === 'character_mainoutfit'
        ? { ...r, referenceType: 'character' as const }
        : r.referenceType === 'character&style_anyoutfit'
          ? { ...r, referenceType: 'character&style' as const }
          : r
    )
}

/** 이 모델로 실제 보내지는 레퍼런스 수 (비용 계산용) */
export function sentRefCount(types: CharRefType[], model: string): number {
  return isV5Model(model) ? types.length : types.filter((t) => t !== 'costume').length
}

/** V5 Medium에서 레퍼런스가 켜져 있으면 High로 보낸다 (웹과 같음). 그 밖에는 그대로. */
export function effortForRefs(model: string, refCount: number): string {
  return refCount > 0 && isMediumEffort(model) ? withEffort(model, false) : model
}
