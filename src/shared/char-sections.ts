// 프롬프트 안의 구간 표시로 캐릭터 프롬프트를 나눈다.
//   # == base ==   → 기본 프롬프트
//   # == char1 ==  → 1번 캐릭터 프롬프트 (켜 둔 캐릭터 순서, 없으면 새로 만든다)
//   # == char2 ==  → 2번 캐릭터 …
//   # == char1 C3 == → 위치까지 지정 (NAI 5×5 칸: 가로 A~E, 세로 1~5, 가운데 C3)
//     위치를 하나라도 적으면 그 요청은 위치 지정 모드로 보낸다. 안 적은 구간은 캐릭터 칸에만 들어간다.
//     에셋 생성기의 캐릭터 코드(# == char2 ns1 ==)는 여기서는 무시한다.
// 표시가 없는 줄은 앞 구간에 속한다. 맨 처음은 base. 다른 '#' 줄(# == 구도 == 등)은 그대로 주석이다.
// 네거티브에 쓰면 캐릭터 네거티브로 간다.
import type { CharacterPromptInput } from './types'

const MARKER = /^\s*#\s*=+\s*(base|char\s*(\d{1,2})((?:\s+[A-Za-z0-9_-]+){0,2}))\s*=+\s*$/i
const GRID = /^([A-E])([1-5])$/i

/** NAI 위치 칸 이름(A1~E5)을 0~1 좌표로. A1이 왼쪽 위, C3이 가운데 */
export function gridCenter(cell: string): { x: number; y: number } | null {
  const m = GRID.exec(cell.trim())
  if (!m) return null
  const col = m[1].toUpperCase().charCodeAt(0) - 65
  const row = Number(m[2]) - 1
  return { x: Math.round((0.1 + col * 0.2) * 10) / 10, y: Math.round((0.1 + row * 0.2) * 10) / 10 }
}

/** 표시 줄을 읽는다: 구간 번호(0 = base)와 적어 둔 위치 */
export function markerOf(
  line: string
): { section: number; center: { x: number; y: number } | null } | null {
  const m = MARKER.exec(line)
  if (!m) return null
  if (!m[2]) return { section: 0, center: null }
  const tokens = (m[3] || '').trim().split(/\s+/).filter(Boolean)
  const cell = tokens.find((t) => GRID.test(t))
  return { section: Math.max(1, Number(m[2])), center: cell ? gridCenter(cell) : null }
}

/** base 또는 charN 표시 줄이면 0(base)이나 N을, 아니면 null */
export function sectionOf(line: string): number | null {
  return markerOf(line)?.section ?? null
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

/** 앞뒤 끝의 주석(#) 줄을 뗀다 — 주석 줄 끝에 ", 다음 글"을 붙이면 주석 제거가 그 글까지 지운다 */
function trimCommentEdges(text: string): string {
  const lines = text.split('\n')
  const isComment = (line: string): boolean => line.trimStart().startsWith('#')
  while (lines.length && (isComment(lines[lines.length - 1]) || !lines[lines.length - 1].trim()))
    lines.pop()
  while (lines.length && (isComment(lines[0]) || !lines[0].trim())) lines.shift()
  return lines.join('\n')
}

const tidyJoin = (a: string, b: string): string =>
  [trimCommentEdges(a).trim().replace(/,\s*$/, ''), trimCommentEdges(b).trim().replace(/^,\s*/, '')]
    .filter(Boolean)
    .join(', ')

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
  /** 캐릭터 번호 → 표시 줄에 적은 위치 */
  centers: Map<number, { x: number; y: number }>
}

export function splitCharSections(text: string): SplitSections {
  const buckets = new Map<number, string[]>([[0, []]])
  const centers = new Map<number, { x: number; y: number }>()
  let current = 0
  for (const line of String(text || '').split('\n')) {
    const marker = markerOf(line)
    if (marker !== null) {
      current = marker.section
      if (marker.center) centers.set(current, marker.center)
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
  return { base: join(buckets.get(0)!), chars, centers }
}

interface SectionTarget {
  prompt: string
  negativePrompt: string
  promptParts?: { base: string; additional: string; detail: string }
  characterPrompts: CharacterPromptInput[]
  useCoords?: boolean
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
  const centers = new Map<number, { x: number; y: number }>()
  for (const s of splits)
    for (const [n, v] of s.chars) charPos.set(n, tidyJoin(charPos.get(n) ?? '', v))
  for (const [n, v] of negative.chars) charNeg.set(n, tidyJoin(charNeg.get(n) ?? '', v))
  for (const s of [...splits, negative]) for (const [n, c] of s.centers) centers.set(n, c)

  const characters = req.characterPrompts.map((c) => ({ ...c }))
  const enabled = characters.map((c, i) => (c.enabled ? i : -1)).filter((i) => i >= 0)
  const numbers = [...new Set([...charPos.keys(), ...charNeg.keys(), ...centers.keys()])].sort(
    (a, b) => a - b
  )
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
    const center = centers.get(n)
    if (center) c.center = center
  }

  const promptParts = req.promptParts
    ? { base: splits[0].base, additional: splits[1].base, detail: splits[2].base }
    : undefined
  return {
    ...req,
    prompt: promptParts ? req.prompt : splits[0].base,
    promptParts,
    negativePrompt: negative.base,
    characterPrompts: characters,
    // 위치를 하나라도 적었으면 위치 지정 모드로 (안 적은 캐릭터는 카드에 찍어 둔 좌표를 쓴다)
    useCoords: centers.size > 0 ? true : req.useCoords
  }
}
