// 프롬프트 안의 구간 표시로 캐릭터 프롬프트를 나눈다.
//   # == base ==   → 기본 프롬프트
//   # == char1 ==  → 1번 캐릭터 프롬프트 (켜 둔 캐릭터 순서, 없으면 새로 만든다)
//   # == char2 ==  → 2번 캐릭터 …
// 표시가 없는 줄은 앞 구간에 속한다. 맨 처음은 base. 다른 '#' 줄(# == 구도 == 등)은 그대로 주석이다.
// 네거티브에 쓰면 캐릭터 네거티브로 간다.
import type { CharacterPromptInput } from './types'

const MARKER = /^\s*#\s*=+\s*(base|char\s*(\d{1,2}))\s*=+\s*$/i

/** base 또는 charN 표시 줄이면 0(base)이나 N을, 아니면 null */
export function sectionOf(line: string): number | null {
  const m = MARKER.exec(line)
  if (!m) return null
  return m[2] ? Math.max(1, Number(m[2])) : 0
}

export function hasCharSections(text: string): boolean {
  return String(text || '')
    .split('\n')
    .some((line) => (sectionOf(line) ?? 0) > 0)
}

/** 주석 줄은 지우되 구간 표시 줄은 남긴다 (씬 프롬프트를 이어 붙일 때 표시가 사라지지 않게) */
export function removeCommentsKeepSections(text: string): string {
  return String(text || '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#') || sectionOf(line) !== null)
    .join('\n')
}

const tidyJoin = (a: string, b: string): string =>
  [a.trim().replace(/,\s*$/, ''), b.trim().replace(/^,\s*/, '')].filter(Boolean).join(', ')

/**
 * 프롬프트 두 개를 이어 붙인다 (기본 + 씬 등). 구간 표시는 남기고,
 * 뒤쪽이 표시로 시작하면 줄을 바꿔 붙여 표시가 줄 맨 앞에 오게 한다.
 * 앞쪽에 캐릭터 구간이 있는데 뒤쪽이 표시 없이 시작하면, 뒤쪽은 base로 돌려보낸다.
 */
export function joinPromptSections(base: string, add: string): string {
  const b = removeCommentsKeepSections(base).trim().replace(/,\s*$/, '')
  const a = removeCommentsKeepSections(add).trim().replace(/^,\s*/, '')
  if (!b) return a
  if (!a) return b
  const firstLine = a.split('\n')[0]
  if (sectionOf(firstLine) !== null) return b + ',\n' + a
  if (hasCharSections(b)) return b + '\n# == base ==\n' + a
  return b + ', ' + a
}

export interface SplitSections {
  base: string
  /** 캐릭터 번호(1부터) → 그 구간 글 */
  chars: Map<number, string>
}

export function splitCharSections(text: string): SplitSections {
  const buckets = new Map<number, string[]>([[0, []]])
  let current = 0
  for (const line of String(text || '').split('\n')) {
    const section = sectionOf(line)
    if (section !== null) {
      current = section
      if (!buckets.has(current)) buckets.set(current, [])
      continue
    }
    buckets.get(current)!.push(line)
  }
  const join = (lines: string[]): string =>
    lines
      .join('\n')
      .trim()
      .replace(/^,\s*|,\s*$/g, '')
  const chars = new Map<number, string>()
  for (const [n, lines] of buckets) {
    if (n === 0) continue
    const value = join(lines)
    if (value) chars.set(n, value)
  }
  return { base: join(buckets.get(0)!), chars }
}

interface SectionTarget {
  prompt: string
  negativePrompt: string
  promptParts?: { base: string; additional: string; detail: string }
  characterPrompts: CharacterPromptInput[]
}

/**
 * 요청의 프롬프트(또는 고정·가변·디테일 각각)와 네거티브에서 charN 구간을 떼어
 * N번째 켜 둔 캐릭터에 이어 붙인다. 그 번호의 캐릭터가 없으면 새로 만든다.
 * 구간 표시가 하나도 없으면 요청을 그대로 돌려준다.
 */
export function applyCharSections<T extends SectionTarget>(req: T, maxCharacters = 32): T {
  const positive = req.promptParts
    ? [req.promptParts.base, req.promptParts.additional, req.promptParts.detail]
    : [req.prompt]
  if (![...positive, req.negativePrompt].some(hasCharSections)) return req

  const splits = positive.map(splitCharSections)
  const negative = splitCharSections(req.negativePrompt)
  const charPos = new Map<number, string>()
  const charNeg = new Map<number, string>()
  for (const s of splits)
    for (const [n, v] of s.chars) charPos.set(n, tidyJoin(charPos.get(n) ?? '', v))
  for (const [n, v] of negative.chars) charNeg.set(n, tidyJoin(charNeg.get(n) ?? '', v))

  const characters = req.characterPrompts.map((c) => ({ ...c }))
  const enabled = characters.map((c, i) => (c.enabled ? i : -1)).filter((i) => i >= 0)
  const numbers = [...new Set([...charPos.keys(), ...charNeg.keys()])].sort((a, b) => a - b)
  for (const n of numbers) {
    let index = enabled[n - 1]
    if (index === undefined) {
      if (enabled.length >= maxCharacters) continue
      characters.push({ prompt: '', negativePrompt: '', enabled: true })
      index = characters.length - 1
      enabled.push(index)
    }
    const c = characters[index]
    c.prompt = tidyJoin(c.prompt, charPos.get(n) ?? '')
    c.negativePrompt = tidyJoin(c.negativePrompt, charNeg.get(n) ?? '')
  }

  const promptParts = req.promptParts
    ? { base: splits[0].base, additional: splits[1].base, detail: splits[2].base }
    : undefined
  return {
    ...req,
    prompt: promptParts ? req.prompt : splits[0].base,
    promptParts,
    negativePrompt: negative.base,
    characterPrompts: characters
  }
}
