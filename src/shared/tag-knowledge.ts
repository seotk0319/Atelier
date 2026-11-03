/**
 * NAI 태그 지식 지표 (Tag Knowledge Indicators). NAI 웹이 태그 옆에 찍는 흰~검 점과 같은 값이다.
 * /ai/generate-image/suggest-tags 가 모델별로 돌려주는 count(0~10000)가 그 태그를 모델이 얼마나 아는지다.
 * confidence는 입력 글자와 비슷한 정도라 지표로 쓰지 않는다 (2026-11-03 실측).
 * 기준: V5 Full에서 mika (track) 9488은 잘 나왔고 mika (new year) 5388은 비슷하지 않았다 (arca 글 실험).
 */

export type KnowledgeLevel = 'strong' | 'fair' | 'weak' | 'unknown'

export const KNOWLEDGE_LABEL: Record<KnowledgeLevel, string> = {
  strong: '잘 앎',
  fair: '애매',
  weak: '약함',
  unknown: '모름'
}

/** null = 모델이 이 태그를 추천 목록에 내지 않음 */
export function knowledgeLevel(count: number | null | undefined): KnowledgeLevel {
  if (count == null || count <= 0) return 'unknown'
  if (count >= 8000) return 'strong'
  if (count >= 3000) return 'fair'
  return 'weak'
}

/** 지표를 물을 모델. 인페인트·Medium은 같은 모델의 지식을 쓴다 */
export function knowledgeModel(model: string): string {
  const base = model.replace(/-inpainting$/, '')
  return base === 'nai-diffusion-5-full-medium' ? 'nai-diffusion-5-full' : base
}

export const normalizeTag = (tag: string): string =>
  tag.replace(/_/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase()

export interface PromptTag {
  /** 화면 표시용 원문 */
  tag: string
  /** 조회 키 (소문자·공백 정리) */
  key: string
  start: number
  end: number
}

/** 작가 태그는 추천 목록에 나오지 않아 지표로 확인할 수 없다 */
export const isCheckable = (key: string): boolean =>
  !!key && !key.startsWith('artist:') && !/^[-\d.\s]*$/.test(key) && key.length <= 80

/**
 * 프롬프트에서 태그를 뽑는다. 쉼표·줄바꿈으로 나누고, 가중치(1.2::태그 ::)·괄호 강조({} [])·
 * 조각(<이름>)·주석(# 줄)·와일드카드(|)는 뺀다. 같은 태그는 처음 나온 자리 하나만.
 */
export function promptTags(text: string): PromptTag[] {
  const out: PromptTag[] = []
  const seen = new Set<string>()
  let lineStart = 0
  for (const line of text.split('\n')) {
    const isComment = line.trimStart().startsWith('#')
    if (!isComment) {
      let pos = 0
      for (const raw of line.split(',')) {
        const segStart = lineStart + pos
        pos += raw.length + 1
        if (/[<>|]/.test(raw)) continue
        const cleaned = raw
          .replace(/-?\d*\.?\d+\s*::/g, ' ')
          .replace(/::/g, ' ')
          .replace(/[{}[\]]/g, ' ')
        const tag = cleaned.replace(/\s+/g, ' ').trim()
        const key = normalizeTag(tag)
        if (!isCheckable(key) || seen.has(key)) continue
        seen.add(key)
        const idx = raw.indexOf(tag.split(' ')[0])
        const start = segStart + Math.max(0, idx)
        out.push({ tag, key, start, end: Math.min(segStart + raw.length, start + tag.length) })
      }
    }
    lineStart += line.length + 1
  }
  return out
}
