/**
 * 일반 태그 약화: 고정 칸은 그대로(1.0) 두고, 그 아래(가변·디테일·씬)를 수치 가중치로 감싼다.
 * 작가·품질 태그를 고정 칸에 두면 상대적으로 1/weight배 세진다.
 *
 * 감쌀 쪽에 이미 수치 가중치(N::…::)가 있으면 NAI가 겹친 가중치를 어떻게 읽는지
 * 확인된 바가 없어서 겹치지 않게 편다:
 *   0.75:: a, 1.2::b::, c ::  →  0.75::a::, 0.9::b::, 0.75::c::
 * 양수 가중치는 곱하고, 0 이하(빼기용)는 그대로 둔다.
 */

export const GENERAL_WEIGHT_KEY = 'general_tag_weight'
export const DEFAULT_GENERAL_WEIGHT = 0.75
export const GENERAL_WEIGHT_MIN = 0.3
export const GENERAL_WEIGHT_MAX = 1

/** 설정값 문자열 → 쓸 수 있는 가중치. 비었거나 이상하면 기본값 */
export function parseGeneralWeight(value: string | null | undefined): number {
  const n = Number(value)
  if (value == null || value === '' || !Number.isFinite(n)) return DEFAULT_GENERAL_WEIGHT
  return Math.min(GENERAL_WEIGHT_MAX, Math.max(GENERAL_WEIGHT_MIN, n))
}

const fmt = (n: number): string => String(Number(n.toFixed(4)))

const NUMERIC_OPEN = /(-?\d*\.?\d+)::/g

/** 글자·숫자가 하나라도 있으면 감쌀 내용이 있는 것 */
const hasContent = (s: string): boolean => /[\p{L}\p{N}]/u.test(s)

/** 앞뒤의 쉼표·공백·줄바꿈은 괄호 밖에 둔다 */
function wrapRun(run: string, weight: number): string {
  if (!hasContent(run)) return run
  const m = /^([\s,]*)([\s\S]*?)([\s,]*)$/.exec(run)!
  return `${m[1]}${fmt(weight)}::${m[2]}::${m[3]}`
}

/** 감쌀 쪽 글을 weight로 감싼다. 안에 수치 가중치가 있으면 겹치지 않게 편다 */
export function weakenText(text: string, weight: number): string {
  if (!hasContent(text)) return text
  const opens = [...text.matchAll(NUMERIC_OPEN)]
  if (opens.length === 0) return wrapRun(text, weight)

  let out = ''
  let pos = 0
  for (const m of opens) {
    const start = m.index!
    if (start < pos) continue // 앞 구간 안에 있던 여는 표시는 건너뛴다
    const innerStart = start + m[0].length
    const close = text.indexOf('::', innerStart)
    const end = close < 0 ? text.length : close + 2
    const inner = text.slice(innerStart, close < 0 ? text.length : close)
    out += wrapRun(text.slice(pos, start), weight)
    const n = Number(m[1])
    out += n > 0 ? `${fmt(n * weight)}::${inner}::` : text.slice(start, end)
    pos = end
  }
  out += wrapRun(text.slice(pos), weight)
  return out
}

/** 고정 칸 + 약화한 나머지. 나머지가 비었으면 고정 칸만 */
export function composeWeakened(fixed: string, rest: string[], weight: number): string {
  const tail = rest.filter((p) => p.trim()).join(', ')
  const weakened = tail ? weakenText(tail, weight) : ''
  return [fixed, weakened].filter((p) => p.trim()).join(', ')
}
