import {
  KNOWLEDGE_LABEL,
  knowledgeLevel,
  knowledgeModel,
  normalizeTag
} from '@shared/tag-knowledge'

export function knowledgeTitle(count: number | null, modelLabel: string): string {
  const level = knowledgeLevel(count)
  return (
    modelLabel +
    ' 태그 지식: ' +
    KNOWLEDGE_LABEL[level] +
    (count == null ? ' (추천 목록에 없음)' : ' · ' + count.toLocaleString() + ' / 10,000')
  )
}

/** 화면 쪽 캐시: 모델|태그 → count(null = 모름). 본체도 디스크에 캐시하지만 IPC를 줄인다 */
const cache = new Map<string, number | null>()
/** 작가 이름으로 확인된 태그 (조회하지 않는다) */
const artistKeys = new Set<string>()
const key = (model: string, tag: string): string => knowledgeModel(model) + '|' + normalizeTag(tag)

export function cachedKnowledge(model: string, tag: string): number | null | undefined {
  return cache.get(key(model, tag))
}

export async function fetchKnowledge(
  model: string,
  tags: string[]
): Promise<{ counts: Map<string, number | null>; artists: Set<string>; error?: string }> {
  const counts = new Map<string, number | null>()
  const artists = new Set<string>()
  const todo: string[] = []
  for (const t of tags) {
    const k = key(model, t)
    if (artistKeys.has(normalizeTag(t))) artists.add(normalizeTag(t))
    else if (cache.has(k)) counts.set(normalizeTag(t), cache.get(k)!)
    else todo.push(t)
  }
  let error: string | undefined
  if (todo.length) {
    const res = await window.nais.invoke('tags:knowledge', { tags: todo, model })
    error = res.error
    for (const [tag, count] of Object.entries(res.counts)) {
      cache.set(key(model, tag), count)
      counts.set(tag, count)
    }
    for (const a of res.artists ?? []) {
      artistKeys.add(a)
      artists.add(a)
    }
  }
  return { counts, artists, error }
}
