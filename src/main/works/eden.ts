// 에덴 작품 본문 읽기. 주소와 필드는 2026-11-10에 에덴 응답으로 확인했다.
//   GET /api/user/works                          내 작품 목록 {success, works[]}
//   GET /api/works/{id}                          작품 전체 (메인·소개·로어북·시작 상황)
//   GET /api/works/{id}/characters               캐릭터 배열
//   GET /api/works/{id}/characters/{cid}/images  캐릭터 이미지 배열
//   GET /api/works/{id}/translations             언어 판본 목록 {items[]}
//   GET /api/works/{id}/translations/{lang}      판본 내용 {item:{work, characters}}
// 저장은 PUT /api/works/{id} 통째 저장만 메인·로어북·시작 상황을 받는다 (PATCH는 400).
// 이미지·표지는 eden-media.ts, 언어 판본 저장은 eden-editions.ts에 있다.
import { randomUUID } from 'node:crypto'
import { edenEditionBody, edenEditionView } from './eden-editions'
import {
  EDEN_COVER_RULES,
  EDEN_IMAGE_RULES,
  edenApplyImages,
  edenImageGroups,
  edenPlanImages,
  edenSendRule,
  edenUploadCover
} from './eden-media'
import type {
  EditionBody,
  EditionInfo,
  LoreEntry,
  WorkAdapter,
  WorkBody,
  WorkDraft,
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
  guide: {
    save: '작품 통째 저장이다. 공개 상태는 읽은 값 그대로 보내고, 같은 값을 보내도 수정 시각은 바뀐다.',
    manual: [],
    unverified: [
      '공개(public) 전환',
      '공개작 저장이 독자에게 "업데이트됨"으로 보이는지',
      '공개작에 없던 언어 판본을 새로 만들 때 바로 노출되는지',
      '일본어·중국어 판본 저장',
      '배경음·캐릭터 음성 칸이 저장 뒤 남는지'
    ]
  },
  capabilities: [
    'works_list',
    'work_read',
    'lorebook',
    'start_scenarios',
    'characters',
    'editions',
    'save',
    'images',
    'cover',
    'edition_save'
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
      const rows = Array.isArray(found)
        ? found
        : isObj(found)
          ? (found.images ?? found.items ?? found.data ?? [])
          : []
      // 플랫폼은 이미지를 순서 없이 돌려준다. 편집기처럼 display_order로 줄을 세워야
      // 화면에 보이는 순서와 같고, 순서 바꾸기 결과도 여기서 확인할 수 있다.
      const order = (image: unknown): number => {
        const value = isObj(image) ? image.display_order : null
        return typeof value === 'number' ? value : parseInt(String(value ?? '0'), 10) || 0
      }
      images[cid] = Array.isArray(rows)
        ? rows
            .map((image, i) => ({ image, i }))
            .sort((a, b) => order(a.image) - order(b.image) || a.i - b.i)
            .map((x) => x.image)
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
        u.origin === ORIGIN &&
        !u.username &&
        !u.password &&
        !u.search &&
        !u.hash &&
        WRITE_ROUTES.some(([m, re]) => m === method && re.test(u.pathname))
      )
    } catch {
      return false
    }
  },

  applyChanges(raw, changes) {
    if (!isObj(raw) || !isObj(raw.work)) throw new Error('WORK_SHAPE')
    const next = structuredClone(raw) as Obj
    const work = next.work as Obj

    if (changes.visibility !== undefined) {
      if (!VISIBILITIES.includes(changes.visibility)) throw new Error('BAD_VISIBILITY')
      work.visibility = changes.visibility
      // 공개·링크 공개는 게시된 상태여야 한다 (편집기도 게시할 때 status를 active로 보낸다)
      if (changes.visibility !== 'private') work.status = 'active'
    }

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
    if (changes.lorebookRemove?.length) {
      const entries = list(work.lorebook)
      const gone = new Set(changes.lorebookRemove.map((i) => at(i, entries.length)))
      work.lorebook = entries.filter((_, i) => !gone.has(i))
    }
    if (changes.lorebookAdd?.length)
      work.lorebook = [...list(work.lorebook), ...changes.lorebookAdd.map((e) => loreRaw({}, e))]
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
    if (changes.startScenariosRemove?.length) {
      const scenarios = list(work.start_scenarios)
      const gone = new Set(changes.startScenariosRemove.map((i) => at(i, scenarios.length)))
      // 기본 시작 상황과 마지막 하나는 남긴다 (편집기도 하나는 꼭 둔다)
      if ([...gone].some((i) => scenarios[i].isDefault === true) || gone.size >= scenarios.length)
        throw new Error('KEEP_DEFAULT')
      work.start_scenarios = scenarios.filter((_, i) => !gone.has(i))
    }
    if (changes.startScenariosAdd?.length) {
      const scenarios = list(work.start_scenarios)
      for (const draft of changes.startScenariosAdd) {
        // 편집기의 추가 버튼과 같은 모양: 안 겹치는 정수 번호를 새로 뽑는다
        const used = new Set(scenarios.map((s) => s.id))
        let id: number
        do id = Math.floor(2e9 * Math.random()) + 1
        while (used.has(id))
        scenarios.push({
          id,
          title: draft.title ?? '',
          description: draft.description ?? '',
          detailedSettings: draft.content ?? '',
          isDefault: !scenarios.some((s) => s.isDefault === true),
          situation: draft.situation ?? '',
          dialogue: draft.dialogue ?? '',
          subPrompt: draft.subPrompt ?? '',
          imageCode: '',
          imageCodes: [],
          elementOrder: ['image', 'situation', 'dialogue']
        })
      }
      work.start_scenarios = scenarios
    }

    if (changes.charactersRemove?.length) {
      const characters = list(next.characters)
      const gone = new Set(changes.charactersRemove.map((i) => at(i, characters.length)))
      if ([...gone].some((i) => characters[i].is_main_character === true))
        throw new Error('KEEP_DEFAULT')
      next.characters = characters.filter((_, i) => !gone.has(i))
      // 저장 본문에서 빠진 캐릭터를 플랫폼이 지우게 한다 (편집기의 delete_missing)
      next.deleteMissing = true
    }
    if (changes.charactersAdd?.length) {
      const characters = list(next.characters)
      const images = isObj(next.images) ? next.images : {}
      for (const draft of changes.charactersAdd) {
        if (!draft.name?.trim()) throw new Error('EMPTY_FIELD')
        // 편집기도 새 캐릭터에 새 uuid를 붙여 통째 저장 본문에 넣는다
        const id = randomUUID()
        characters.push({
          id,
          character_name: draft.name,
          character_details: draft.details ?? '',
          character_info: draft.info ?? '',
          is_main_character: false,
          character_order: characters.length,
          start_scenario: null
        })
        images[id] = []
      }
      next.characters = characters
      next.images = images
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
  },

  visibilities: ['public', 'link', 'private'],

  async remove(write, id) {
    const res = await write('DELETE', ORIGIN + '/api/works/' + workId(id))
    if (res.status === 401 || res.status === 403) throw new Error('LOGIN_REQUIRED')
    if (res.status === 404) throw new Error('WORK_NOT_FOUND')
    if (!res.ok) throw new Error('DELETE_FAILED ' + res.status)
  },

  sendRule: edenSendRule,
  imageRules: EDEN_IMAGE_RULES,
  imageGroups: edenImageGroups,
  planImages: edenPlanImages,
  applyImages: (io, id, raw, changes) => edenApplyImages(io, workId(id), raw, changes),

  coverRules: EDEN_COVER_RULES,
  coverUrl(raw) {
    if (!isObj(raw) || !isObj(raw.work)) throw new Error('WORK_SHAPE')
    return strOrNull(raw.work.cover_image_url)
  },
  async uploadCover(io, id, file, language) {
    const wid = workId(id)
    if (language === undefined) return edenUploadCover(io, wid, file)
    // 판본 표지는 올린 주소를 '번역 저장' 본문에 넣어야 판본에 남는다 (편집기도 올린 뒤 번역 저장을 보낸다).
    // 판본이 없으면 번역 저장이 원문을 베낀 새 판본을 만들어 버리므로 올리지 않는다.
    const source = await edenWorks.readRaw(io.read, wid)
    const edition = await edenWorks.readEditionRaw!(io.read, wid, language)
    if (!isObj(edition) || edition.exists !== true) throw new Error('EDITION_MISSING')
    const view = edenEditionView(source, edition)
    const url = await edenUploadCover(io, wid, file, language)
    ;(view.work as Obj).cover_image_url = url
    await edenWorks.saveEdition!(io.write, wid, language, view)
    return url
  },

  editionView: edenEditionView,
  applyEditionChanges(view, changes) {
    // 판본은 원문의 구조(시작 상황·캐릭터 개수)와 공개 상태를 따른다. 글만 바꿀 수 있다.
    if (
      changes.visibility !== undefined ||
      changes.startScenariosAdd?.length ||
      changes.startScenariosRemove?.length ||
      changes.charactersAdd?.length ||
      changes.charactersRemove?.length
    )
      throw new Error('EDITION_FIXED')
    return edenWorks.applyChanges!(view, changes)
  },
  async saveEdition(write, id, language, view) {
    if (!LANG_RE.test(language)) throw new Error('BAD_LANGUAGE')
    const res = await write(
      'PUT',
      ORIGIN + '/api/works/' + workId(id) + '/translations/' + language,
      edenEditionBody(view)
    )
    if (res.status === 401 || res.status === 403) throw new Error('LOGIN_REQUIRED')
    const reply: unknown = await res.json().catch(() => null)
    if (!res.ok || !isObj(reply) || !isObj(reply.item))
      throw new Error(
        'SAVE_FAILED ' + res.status + ' ' + text(isObj(reply) ? reply.error_code : '').slice(0, 40)
      )
  },

  async create(write, draft) {
    const res = await write('PUT', ORIGIN + '/api/works/new', edenCreateBody(draft))
    if (res.status === 401 || res.status === 403) throw new Error('LOGIN_REQUIRED')
    const reply: unknown = await res.json().catch(() => null)
    if (!res.ok || !isObj(reply) || reply.success !== true || !isObj(reply.work))
      throw new Error(
        'CREATE_FAILED ' + res.status + ' ' + text(isObj(reply) ? reply.error : '').slice(0, 60)
      )
    const made = isObj(reply.work.to_jsonb) ? reply.work.to_jsonb : reply.work
    const id = strOrNull(made.id)
    if (!id || !UUID_RE.test(id)) throw new Error('CREATE_FAILED response')
    return id.toLowerCase()
  }
}

const VISIBILITIES = ['public', 'link', 'private']
const WRITE_PATH = new RegExp('^/api/works/' + UUID + '$', 'i')
const LANG = '[A-Za-z]{2,3}(?:-[A-Za-z]{2,4})?'
// JSON으로 쓰는 요청 전부. 여기 없는 요청은 나가지 않는다.
// 자동 번역(POST …/translations/{lang}, POST …/translation-drafts)은 일부러 넣지 않았다.
const WRITE_ROUTES: [string, RegExp][] = [
  // 통째 저장·삭제는 작품 주소로, 새 작품(임시저장)은 /api/works/new 로만 보낸다
  ['PUT', WRITE_PATH],
  ['DELETE', WRITE_PATH],
  ['PUT', /^\/api\/works\/new$/],
  // 표지: 올릴 자리 받기 → (저장소에 올림) → 작품 표지 또는 언어 판본 표지로 등록
  ['POST', new RegExp('^/api/works/' + UUID + '/upload-cover/signed-url$', 'i')],
  ['POST', new RegExp('^/api/works/' + UUID + '/upload-cover$', 'i')],
  ['POST', new RegExp('^/api/works/' + UUID + '/translations/' + LANG + '/cover$', 'i')],
  // 언어 판본 '번역 저장'
  ['PUT', new RegExp('^/api/works/' + UUID + '/translations/' + LANG + '$', 'i')],
  // 캐릭터 이미지 순서
  ['PUT', new RegExp('^/api/works/' + UUID + '/characters/' + UUID + '/images/reorder$', 'i')]
]

/**
 * 새 작품 본문 (임시저장, 항상 비공개). 편집기의 새 작품 기본값과 같은 모양으로 채운다
 * (2026-11-10 사이트 코드: 기본 work_type original, prompt_version v1, image_source_mode mixed,
 * 시작 상황 하나, 캐릭터마다 새 uuid). 표지와 이미지는 만든 뒤 따로 올린다.
 */
export function edenCreateBody(draft: WorkDraft): Obj {
  if (!draft.title.trim() || !draft.main.trim()) throw new Error('EMPTY_FIELD')
  if (!draft.characters.length || draft.characters.some((c) => !c.name.trim()))
    throw new Error('EMPTY_FIELD')
  const starts = (draft.startScenarios?.length ? draft.startScenarios : [{}]).map((s, i) => ({
    id: i + 1,
    title: s.title ?? '',
    description: s.description ?? '',
    detailedSettings: s.content ?? '',
    isDefault: i === 0,
    situation: s.situation ?? '',
    dialogue: s.dialogue ?? '',
    subPrompt: s.subPrompt ?? '',
    imageCode: '',
    imageCodes: [],
    elementOrder: ['image', 'situation', 'dialogue']
  }))
  const lorebook = (draft.lorebook ?? []).map((e) => loreRaw({}, e))
  for (const e of lorebook)
    if (!text(e.value).trim() || (e.triggerMode !== 'always' && !text(e.key).trim()))
      throw new Error('BAD_LOREBOOK')
  const body = edenSaveBody({
    work: {
      title: draft.title,
      subtitle: draft.subtitle ?? '',
      description: draft.description ?? '',
      scenario_settings: draft.main,
      work_type: 'original',
      genre: [],
      tags: [],
      categories: draft.categories ?? [],
      hashtags: draft.hashtags ?? [],
      template_type: 'default',
      prompt_version: 'v1',
      image_source_mode: 'mixed',
      lorebook,
      start_scenarios: starts,
      selected_scenario_id: 1,
      character_presets: [],
      selected_preset_id: null,
      recommended_personas: [],
      creator_comment: null,
      is_nsfw: draft.adult,
      visibility: 'private',
      status: 'draft'
    },
    characters: draft.characters.map((c, i) => ({
      id: randomUUID(),
      character_name: c.name,
      character_details: c.details ?? '',
      character_info: c.info ?? '',
      is_main_character: i === 0,
      start_scenario: null
    })),
    images: {}
  })
  // 편집기는 표지가 없으면 이 칸을 아예 보내지 않는다
  delete body.cover_image_url
  return body
}

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
    }),
    ...(raw.deleteMissing === true ? { delete_missing: true } : {})
  }
}
