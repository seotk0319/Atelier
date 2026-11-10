// 에덴 작품 본문 읽기. 주소와 필드는 2026-11-10에 에덴 응답으로 확인했다.
//   GET /api/user/works                          내 작품 목록 {success, works[]}
//   GET /api/works/{id}                          작품 전체 (메인·소개·로어북·시작 상황)
//   GET /api/works/{id}/characters               캐릭터 배열
//   GET /api/works/{id}/characters/{cid}/images  캐릭터 이미지 배열
//   GET /api/works/{id}/translations             언어 판본 목록 {items[]}
//   GET /api/works/{id}/translations/{lang}      판본 내용 {item:{work, characters}}
// 저장은 PUT /api/works/{id} 통째 저장만 메인·로어북·시작 상황을 받는다 (PATCH는 400). 아직 쓰지 않는다.
import type {
  EditionBody,
  EditionInfo,
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
    'editions'
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
  }
}
