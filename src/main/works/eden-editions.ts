// 에덴 언어 판본 저장. 2026-11-10 편집기 코드(40265 묶음)에서 읽은 흐름 그대로다.
//   PUT /api/works/{id}/translations/{lang}   본문 {work, characters} → {item}   ('번역 저장' 버튼)
// 편집기는 판본을 열 때 원문 위에 판본 값을 겹쳐 보여 주고(판본에 값이 있는 칸만), 저장할 때
// 그 겹친 값을 통째로 보낸다. 여기서도 같은 순서로 겹치고 같은 모양으로 보낸다.
// 자동 번역(POST …/translations/{lang}, POST …/translation-drafts)은 돈이 드는 다른 길이라 부르지 않는다.

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
const list = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter(isObj) : [])
const strOrUndef = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const strings = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : undefined

// 편집기가 판본 값을 "있다"고 보는 기준: 빈 글·빈 배열·null이 아니면 있다
const filled = (v: unknown): boolean =>
  v != null && (typeof v === 'string' ? v.trim() !== '' : !Array.isArray(v) || v.length > 0)
const text = (v: unknown): boolean => typeof v === 'string' && v.trim() !== ''

const WORK_KEYS = [
  'title',
  'subtitle',
  'description',
  'creator_comment',
  'scenario_settings',
  'tags',
  'hashtags',
  'cover_image_url'
]
const START_KEYS = [
  'title',
  'situation',
  'dialogue',
  'description',
  'detailedSettings',
  'subPrompt'
]
const PERSONA_KEYS = ['name', 'nickname', 'description']
const CHARACTER_KEYS = [
  'character_name',
  'character_info',
  'character_details',
  'scenario_settings'
]

/** 번호가 같은 항목끼리, 원문과 판본 둘 다 글이 있는 칸만 판본 글로 바꾼다 (구조는 원문을 따른다) */
function mergeById(
  source: unknown,
  translated: unknown,
  keys: string[],
  persona: boolean
): unknown {
  if (!Array.isArray(source) || !source.length || !Array.isArray(translated) || !translated.length)
    return source
  const byId = new Map<unknown, Obj>()
  for (const item of list(translated))
    if (item.id !== undefined && item.id !== null && !byId.has(item.id)) byId.set(item.id, item)
  if (!byId.size) return source
  return list(source).flatMap((item) => {
    if (item.id === undefined || item.id === null) return []
    const found = byId.get(item.id)
    if (!found) return [item]
    const out: Obj = { ...item }
    for (const key of keys)
      if (text(found[key]) && text(item[key]) && found[key] !== item[key]) {
        out[key] = found[key]
        // 편집기는 번역된 페르소나 이름 옆에 원문 이름을 남긴다
        if (persona && key === 'name') out.source_name = item.name
      }
    return [out]
  })
}

/**
 * 원문(readRaw 모양)과 판본(readEditionRaw 모양)을 겹친다. 결과는 원문과 같은 모양이라
 * normalize·applyChanges를 그대로 쓸 수 있다. 판본이 아직 없으면 원문 그대로다.
 */
export function edenEditionView(source: unknown, edition: unknown): Obj {
  if (!isObj(source) || !isObj(source.work) || !isObj(edition)) throw new Error('EDITION_SHAPE')
  const view = structuredClone(source) as Obj
  const work = view.work as Obj
  view.edition = { language: edition.language_code, exists: edition.exists === true }
  if (edition.exists !== true) return view

  const tr = isObj(edition.work) ? edition.work : {}
  for (const key of WORK_KEYS) if (filled(tr[key])) work[key] = structuredClone(tr[key])
  if (filled(tr.lorebook)) work.lorebook = structuredClone(tr.lorebook)
  work.start_scenarios = mergeById(work.start_scenarios, tr.start_scenarios, START_KEYS, false)
  work.recommended_personas = mergeById(
    work.recommended_personas,
    tr.recommended_personas,
    PERSONA_KEYS,
    true
  )

  const byCharacter = new Map(list(edition.characters).map((c) => [String(c.character_id), c]))
  view.characters = list(view.characters).map((c) => {
    const found = byCharacter.get(String(c.id ?? ''))
    if (!found) return c
    const out: Obj = { ...c }
    for (const key of CHARACTER_KEYS) if (filled(found[key])) out[key] = found[key]
    if (filled(found.lorebook)) out.lorebook = structuredClone(found.lorebook)
    return out
  })
  return view
}

/** 겹친 원본 → '번역 저장' 본문. 편집기의 본문 조립 함수와 같은 칸만 보낸다 */
export function edenEditionBody(view: unknown): Obj {
  if (!isObj(view) || !isObj(view.work)) throw new Error('EDITION_SHAPE')
  const w = view.work
  if (!text(w.title) || !text(w.scenario_settings)) throw new Error('EMPTY_FIELD')
  const cover = strOrUndef(w.cover_image_url)
  return {
    work: {
      title: strOrUndef(w.title),
      subtitle: strOrUndef(w.subtitle) ?? '',
      description: strOrUndef(w.description),
      creator_comment: strOrUndef(w.creator_comment) ?? '',
      scenario_settings: strOrUndef(w.scenario_settings),
      tags: strings(w.tags) ?? [],
      hashtags: strings(w.hashtags) ?? [],
      // 편집기는 표지 주소가 http 주소일 때만 보낸다 (없으면 칸을 뺀다)
      ...(cover && /^https?:\/\//i.test(cover) ? { cover_image_url: cover } : {}),
      lorebook: Array.isArray(w.lorebook) ? w.lorebook : null,
      start_scenarios: Array.isArray(w.start_scenarios) ? w.start_scenarios : [],
      recommended_personas: list(w.recommended_personas).filter((p) => text(p.name))
    },
    characters: list(view.characters).flatMap((c) => {
      const id = strOrUndef(c.id)
      return id
        ? [
            {
              character_id: id,
              character_name: strOrUndef(c.character_name),
              character_info: strOrUndef(c.character_info),
              character_details: strOrUndef(c.character_details),
              scenario_settings: strOrUndef(c.scenario_settings),
              lorebook: c.lorebook ?? null
            }
          ]
        : []
    })
  }
}
