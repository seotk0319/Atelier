// 에덴 작품 본문 읽기. 주소와 필드는 2026-11-10에 에덴 응답으로 확인했다.
//   GET /api/user/works                          내 작품 목록 {success, works[]}
//   GET /api/works/{id}                          작품 전체 (메인·소개·로어북·시작 상황)
//   GET /api/works/{id}/characters               캐릭터 배열
//   GET /api/works/{id}/characters/{cid}/images  캐릭터 이미지 배열
//   GET /api/works/{id}/translations             언어 판본 목록 {items[]}
//   GET /api/works/{id}/translations/{lang}      판본 내용 {item:{work, characters}}
// 저장은 PUT /api/works/{id} 통째 저장만 메인·로어북·시작 상황을 받는다 (PATCH는 400).
import type {
  EditionBody,
  EditionInfo,
  LoreEntry,
  WorkAdapter,
  WorkBody,
  WorkFetch,
  WorkListItem
} from './types'

const ORIGIN = 'https://www.eden-chat.com'
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const UUID_RE = new RegExp('^' + UUID + '$', 'i')
const LANG_RE = /^[A-Za-z]{2,3}(-[A-Za-z]{2,4})?$/
const READ_PATHS = [
  /^\/api\/user\/works$/,
  new RegExp('^/api/works/' + UUID + '$', 'i'),
  new RegExp('^/api/works/' + UUID + '/characters$', 'i'),
  new RegExp('^/api/works/' + UUID + '/characters/' + UUID + '/images$', 'i'),
  new RegExp('^/api/works/' + UUID + '/translations$', 'i'),
  new RegExp('^/api/works/' + UUID + '/translations/[A-Za-z]{2,3}(-[A-Za-z]{2,4})?$', 'i')
]

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
const list = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter(isObj) : [])
const text = (v: unknown): string => (typeof v === 'string' ? v : '')
const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)
const numOrNull = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null

async function json(res: Response): Promise<unknown> {
  if (res.status === 401 || res.status === 403) throw new Error('LOGIN_REQUIRED')
  if (res.status === 404) throw new Error('WORK_NOT_FOUND')
  if (!res.ok) throw new Error('WORK_READ_FAILED ' + res.status)
  return res.json()
}

function workId(id: string): string {
  if (!UUID_RE.test(id)) throw new Error('BAD_WORK_ID')
  return id.toLowerCase()
}

const FIELDS: Record<string, string> = {
  title: 'title',
  subtitle: 'subtitle',
  description: 'description',
  main: 'scenario_settings',
  creator_comment: 'creator_comment'
}

function body(work: Obj, characters: Obj[], images: Record<string, unknown>): WorkBody {
  return {
    id: strOrNull(work.id),
    title: text(work.title),
    visibility: strOrNull(work.visibility),
    status: strOrNull(work.status),
    updatedAt: strOrNull(work.updated_at),
    fields: Object.fromEntries(Object.entries(FIELDS).map(([k, f]) => [k, text(work[f])])),
    lorebook: list(work.lorebook).map((e) => ({
      title: text(e.title),
      keys: text(e.key),
      content: text(e.value),
      mode: strOrNull(e.triggerMode),
      offKeys: Array.isArray(e.offKeywords)
        ? e.offKeywords.filter((k) => typeof k === 'string')
        : [],
      turnRange: numOrNull(e.turnRange),
      offTurnRange: numOrNull(e.offTurnRange)
    })),
    startScenarios: list(work.start_scenarios).map((s) => ({
      id: typeof s.id === 'string' || typeof s.id === 'number' ? s.id : null,
      title: text(s.title),
      isDefault: s.isDefault === true,
      content: text(s.detailedSettings),
      subPrompt: text(s.subPrompt),
      dialogue: text(s.dialogue),
      situation: text(s.situation),
      description: text(s.description)
    })),
    characters: characters.map((c) => {
      const id = strOrNull(c.id)
      const own = id ? images[id] : null
      return {
        id,
        name: text(c.character_name),
        isMain: c.is_main_character === true,
        order: numOrNull(c.character_order),
        details: text(c.character_details),
        info: text(c.character_info),
        imageCount: Array.isArray(own) ? own.length : 0
      }
    })
  }
}

export const edenWorks: WorkAdapter = {
  id: 'eden',
  label: '에덴',
  capabilities: [
    'works_list',
    'work_read',
    'lorebook',
    'start_scenarios',
    'characters',
    'editions',
    'save'
  ],

  readAllowed(url) {
    try {
      const u = new URL(url)
      return (
        u.origin === ORIGIN &&
        !u.username &&
        !u.password &&
        !u.search &&
        !u.hash &&
        READ_PATHS.some((re) => re.test(u.pathname))
      )
    } catch {
      return false
    }
  },

  async list(read: WorkFetch): Promise<WorkListItem[]> {
    const data = await json(await read(ORIGIN + '/api/user/works'))
    const works = isObj(data) ? data.works : data
    if (!Array.isArray(works)) throw new Error('WORK_LIST_SHAPE')
    return list(works).flatMap((w) => {
      const id = strOrNull(w.id)
      return id
        ? [
            {
              id,
              title: text(w.title),
              visibility: strOrNull(w.visibility),
              status: strOrNull(w.status),
              updatedAt: strOrNull(w.updated_at),
              characters: numOrNull(w.character_count)
            }
          ]
        : []
    })
  },

  async readRaw(read, id) {
    const wid = workId(id)
    const work = await json(await read(ORIGIN + '/api/works/' + wid))
    if (!isObj(work)) throw new Error('WORK_SHAPE')
    const got = await json(await read(ORIGIN + '/api/works/' + wid + '/characters'))
    const characters = list(isObj(got) ? got.characters : got).sort(
      (a, b) => (numOrNull(a.character_order) ?? 0) - (numOrNull(b.character_order) ?? 0)
    )
    const images: Record<string, unknown> = {}
    for (const c of characters) {
      const cid = strOrNull(c.id)
      if (!cid || !UUID_RE.test(cid)) continue
      const found = await json(
        await read(ORIGIN + '/api/works/' + wid + '/characters/' + cid.toLowerCase() + '/images')
      )
      images[cid] = Array.isArray(found)
        ? found
        : isObj(found)
          ? (found.images ?? found.items ?? found.data ?? [])
          : []
    }
    return { work, characters, images }
  },

  normalize(raw) {
    if (!isObj(raw) || !isObj(raw.work)) throw new Error('WORK_SHAPE')
    return body(raw.work, list(raw.characters), isObj(raw.images) ? raw.images : {})
  },

  async editions(read, id): Promise<EditionInfo[]> {
    const data = await json(await read(ORIGIN + '/api/works/' + workId(id) + '/translations'))
    return list(isObj(data) ? data.items : null).flatMap((e) => {
      const language = strOrNull(e.language_code)
      return language
        ? [
            {
              language,
              isSource: e.is_source === true,
              exists: e.exists === true,
              status: strOrNull(e.status),
              stale: e.stale === true
            }
          ]
        : []
    })
  },

  async readEditionRaw(read, id, language) {
    if (!LANG_RE.test(language)) throw new Error('BAD_LANGUAGE')
    const data = await json(
      await read(ORIGIN + '/api/works/' + workId(id) + '/translations/' + language)
    )
    if (!isObj(data) || !isObj(data.item)) throw new Error('EDITION_SHAPE')
    return data.item
  },

  normalizeEdition(raw): EditionBody {
    if (!isObj(raw)) throw new Error('EDITION_SHAPE')
    const base = body(isObj(raw.work) ? raw.work : {}, list(raw.characters), {})
    return {
      ...base,
      language: text(raw.language_code),
      exists: raw.exists === true,
      status: strOrNull(raw.status),
      stale: raw.stale === true
    }
  },

  writeAllowed(method, url) {
    try {
      const u = new URL(url)
      return (
        method === 'PUT' &&
        u.origin === ORIGIN &&
        !u.username &&
        !u.password &&
        !u.search &&
        !u.hash &&
        WRITE_PATH.test(u.pathname)
      )
    } catch {
      return false
    }
  },

  applyChanges(raw, changes) {
    if (!isObj(raw) || !isObj(raw.work)) throw new Error('WORK_SHAPE')
    const next = structuredClone(raw) as Obj
    const work = next.work as Obj

    for (const [name, value] of Object.entries(changes.fields ?? {})) {
      const key = FIELDS[name]
      if (!key || typeof value !== 'string') throw new Error('BAD_FIELD')
      if ((name === 'main' || name === 'title') && !value.trim()) throw new Error('EMPTY_FIELD')
      // 편집기는 빈 제작자 코멘트를 null로 보낸다
      work[key] = name === 'creator_comment' && !value ? null : value
    }

    if (changes.lorebook) work.lorebook = changes.lorebook.map((e) => loreRaw({}, e))
    if (changes.lorebookPatch?.length) {
      const entries = list(work.lorebook)
      for (const patch of changes.lorebookPatch)
        entries[at(patch.index, entries.length)] = loreRaw(entries[patch.index], patch)
      work.lorebook = entries
    }
    // 편집기는 내용이 빈 항목과 키워드 없는 키워드 항목을 저장할 때 버린다. 조용히 사라지지 않게 막는다.
    for (const e of list(work.lorebook))
      if (!text(e.value).trim() || (e.triggerMode !== 'always' && !text(e.key).trim()))
        throw new Error('BAD_LOREBOOK')

    if (changes.startScenarios?.length) {
      const scenarios = list(work.start_scenarios)
      for (const patch of changes.startScenarios) {
        const s = scenarios[at(patch.index, scenarios.length)]
        if (patch.title !== undefined) s.title = patch.title
        if (patch.content !== undefined) s.detailedSettings = patch.content
        if (patch.subPrompt !== undefined) s.subPrompt = patch.subPrompt
        if (patch.dialogue !== undefined) s.dialogue = patch.dialogue
        if (patch.situation !== undefined) s.situation = patch.situation
        if (patch.description !== undefined) s.description = patch.description
      }
      work.start_scenarios = scenarios
    }

    if (changes.characters?.length) {
      const characters = list(next.characters)
      for (const patch of changes.characters) {
        const c = characters[at(patch.index, characters.length)]
        if (patch.name !== undefined) {
          if (!patch.name.trim()) throw new Error('EMPTY_FIELD')
          c.character_name = patch.name
        }
        if (patch.details !== undefined) c.character_details = patch.details
        if (patch.info !== undefined) c.character_info = patch.info
      }
      next.characters = characters
    }
    return next
  },

  async save(write, id, next) {
    const res = await write('PUT', ORIGIN + '/api/works/' + workId(id), edenSaveBody(next))
    if (res.status === 401 || res.status === 403) throw new Error('LOGIN_REQUIRED')
    const reply: unknown = await res.json().catch(() => null)
    if (!res.ok || !isObj(reply) || reply.success !== true)
      throw new Error('SAVE_FAILED ' + res.status)
  }
}

const WRITE_PATH = new RegExp('^/api/works/' + UUID + '$', 'i')

function at(index: unknown, length: number): number {
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= length)
    throw new Error('BAD_INDEX')
  return index
}

/** 공통 이름의 로어북 항목(일부여도 됨)을 에덴 원본 모양에 얹는다 */
function loreRaw(base: Obj | undefined, e: Partial<LoreEntry>): Obj {
  const out: Obj = { ...(base ?? {}) }
  if (e.title !== undefined) out.title = e.title
  if (e.keys !== undefined) out.key = e.keys
  if (e.content !== undefined) out.value = e.content
  if (e.mode !== undefined) out.triggerMode = e.mode ?? 'keyword'
  if (e.offKeys !== undefined) out.offKeywords = e.offKeys
  if (e.turnRange !== undefined) out.turnRange = e.turnRange ?? 5
  if (e.offTurnRange !== undefined) out.offTurnRange = e.offTurnRange ?? 5
  out.title ??= ''
  out.key ??= ''
  out.triggerMode ??= 'keyword'
  out.offKeywords ??= []
  out.turnRange ??= 5
  out.offTurnRange ??= 5
  return out
}

const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

/**
 * 통째 저장(PUT /api/works/{id}) 본문. 편집기의 본문 조립 함수와 같은 모양이다
 * (2026-11-10 사이트 코드와 시험 작품 저장으로 확인). 공개 상태(visibility·status)는
 * 읽은 값 그대로 보내고, 캐릭터마다 이미지 목록을 같이 보낸다.
 * 작품·캐릭터의 bgm·character_voice는 읽기 응답에 없어 보내지 않는다.
 */
export function edenSaveBody(raw: unknown): Obj {
  if (!isObj(raw) || !isObj(raw.work)) throw new Error('WORK_SHAPE')
  const w = raw.work
  const images = isObj(raw.images) ? raw.images : {}
  const visibility = strOrNull(w.visibility)
  const status = strOrNull(w.status)
  if (!visibility || !status || typeof w.scenario_settings !== 'string')
    throw new Error('WORK_SHAPE')
  const template = text(w.template_type) || 'default'
  return {
    title: text(w.title),
    description: text(w.description),
    subtitle: text(w.subtitle),
    work_type: text(w.work_type) || 'original',
    genre: arr(w.genre),
    tags: arr(w.tags),
    categories: arr(w.categories),
    hashtags: arr(w.hashtags),
    scenario_settings: w.scenario_settings,
    template_type: template,
    prompt_version: text(w.prompt_version) || 'v1',
    lorebook: arr(w.lorebook),
    start_scenarios: arr(w.start_scenarios),
    selected_scenario_id: w.selected_scenario_id ?? null,
    character_presets: arr(w.character_presets),
    selected_preset_id: w.selected_preset_id ?? null,
    recommended_personas: arr(w.recommended_personas),
    image_source_mode: text(w.image_source_mode) || 'mixed',
    creator_comment: text(w.creator_comment) || null,
    is_nsfw: w.is_nsfw === true,
    visibility,
    status,
    cover_image_url: w.cover_image_url ?? null,
    characters: list(raw.characters).map((c, order) => {
      const id = strOrNull(c.id)
      if (!id) throw new Error('WORK_SHAPE')
      return {
        id,
        character_name: text(c.character_name),
        character_info: text(c.character_info),
        character_details: text(c.character_details),
        is_main_character: c.is_main_character === true,
        template_type: template,
        character_order: order,
        scenario_settings: text(c.scenario_settings),
        start_scenario: c.start_scenario ?? null,
        images: list(images[id]).flatMap((image) => {
          const imageId = strOrNull(image.id)
          if (!imageId) return []
          const url = text(image.url)
          return [{ id: imageId, ...(/^https?:\/\//i.test(url) ? { url } : {}) }]
        })
      }
    })
  }
}
