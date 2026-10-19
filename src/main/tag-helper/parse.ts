// AI 응답을 태그 배열로 다듬는 순수 함수. 코드펜스·라벨·번호·중복·한글 잔여물을 걷어낸다.
import type { TagHelperItem } from '../../shared/tag-helper'

const HANGUL = /[\u3131-\u318e\uac00-\ud7a3]/
const MAX_TAG_LENGTH = 60
const WEIGHT = /^\s*[0-9]*\.?[0-9]+\s*::\s*(.*?)\s*::\s*$/
const FENCE = /\x60+[a-zA-Z]*/g

/** "1.2::smile ::" -> "smile". 가중치가 없으면 그대로. */
export function stripWeight(tag: string): string {
  const match = tag.trim().match(WEIGHT)
  return (match ? match[1] : tag).trim()
}

/** 한 조각을 태그 모양으로 다듬는다. 비면 빈 문자열. */
export function normalizeTag(raw: string): string {
  let value = raw.trim()
  value = value.replace(FENCE, '').trim()
  // 라벨·번호·불릿을 먼저 걷어야 "2. \"tag\"" 같은 줄이 제대로 정리된다.
  // 번호는 점 뒤에 공백이 있을 때만 지운다 — "1.2::tag ::"의 소수점을 건드리지 않는다.
  value = value.replace(/^(?:tags?|tag list|태그)\s*[:：]\s*/i, '')
  value = value.replace(/^\d{1,3}\s*[.)]\s+/, '')
  value = value.replace(/^[-*•]\s+/, '')
  value = value.replace(/^[\s"'\x60]+/, '').replace(/[\s"'\x60]+$/, '')
  value = value.toLowerCase().replace(/_/g, ' ')
  return value.replace(/\s+/g, ' ').trim()
}

export function parseTags(text: string): string[] {
  if (typeof text !== 'string' || !text.trim()) return []
  const cleaned = text.replace(FENCE, ' ').replace(/\x60+/g, ' ')
  const tags: string[] = []
  const seen = new Set<string>()
  for (const piece of cleaned.split(/[,\n\r]+/)) {
    const tag = normalizeTag(piece)
    if (!tag) continue
    if (tag.length > MAX_TAG_LENGTH) continue
    if (HANGUL.test(tag)) continue
    if (seen.has(tag)) continue
    seen.add(tag)
    tags.push(tag)
  }
  return tags
}

export function toItems(tags: string[], isKnown: (tag: string) => boolean): TagHelperItem[] {
  return tags.map((tag) => {
    let known = false
    try {
      known = isKnown(stripWeight(tag))
    } catch {
      known = false
    }
    return { tag, known }
  })
}

/** 무헤더 한 줄. */
export function joinTags(tags: string[]): string {
  return tags.join(', ')
}
// ── 성별·성인 앵커 정리 ──
// 모델에게 맡기면 옷만 적어도 girl이 붙거나, 머리·체형이 있는데 adult woman이 빠진다.
// 외형 태그가 있을 때만 앵커를 두고, 있으면 성인 앵커까지 맞춘다 (ZK-514 1·11번 슬롯).
const HAIR_ACCESSORY =
  /\bhair (ribbon|ornament|clip|bow|flower|band|tie|stick|pin)s?\b|\bhair(clip|band|pin)s?\b/
const APPEARANCE =
  /\b(hair|bangs|sidelocks|braids?|ponytail|twintails|bun|eyes|eyebrows|eyelashes|breasts|skin|hips|waist|thighs|legs|mole|freckles|glasses|mask|ears|horns|muscular|curvy|petite)\b/
const BODY = /\b(breasts|skin|hips|waist|thighs|legs|muscular|curvy|petite)\b/
const PAIRS: [string, string][] = [
  ['girl', 'adult woman'],
  ['boy', 'adult man']
]
const ANCHORS = new Set(PAIRS.flat())

export function isAppearanceTag(tag: string): boolean {
  const bare = stripWeight(tag)
  return !HAIR_ACCESSORY.test(bare) && APPEARANCE.test(bare)
}

/**
 * hasLook: 그림 요청이면 "외형"을 골랐는지, 한글 요청이면 null(태그를 보고 판단).
 */
export function fixAnchors(tags: string[], hasLook: boolean | null): string[] {
  const appearance = hasLook ?? tags.some(isAppearanceTag)
  if (!appearance || !tags.some(isAppearanceTag)) {
    return tags.filter((t) => !ANCHORS.has(stripWeight(t)))
  }
  const out = [...tags]
  for (const [sex, adult] of PAIRS) {
    if (!out.includes(sex) || out.includes(adult)) continue
    const body = out.findIndex((t) => BODY.test(stripWeight(t)))
    if (body >= 0) out.splice(body, 0, adult)
    else {
      let last = -1
      out.forEach((t, i) => {
        if (isAppearanceTag(t)) last = i
      })
      out.splice(last + 1, 0, adult)
    }
  }
  return out
}
