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
import { matchOld } from './match-old'
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
  WorkFeature,
  WorkFetch,
  WorkListItem
} from './types'
import { EXTRA_LIST_MAX, EXTRA_TEXT_MAX, UUID, UUID_RE, at, feature, isObj, list, strOrNull, text } from './shared'

const ORIGIN = 'https://www.eden-chat.com'
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

// 사이트에는 있는데 이 연결부가 읽지 못하는 것 (빈 칸으로 보여도 "없음"이 아니다)
const UNSUPPORTED = [
  '배경음',
  '캐릭터 음성',
  '댓글',
  '통계(대화·좋아요 수)',
  '추천 페르소나 내용(개수만)',
  '프리셋 내용(개수만)',
  '캐릭터별 로어북 내용(개수만)',
  '캐릭터 감정 이미지 내용(개수만)',
  '외부 이미지 내용(개수만)',
  '캐릭터 설명 내용(유무만)'
]

/**
 * 공통 칸에 들지 않는 원본 설정. 짧은 값은 그대로, 긴 글은 `_length`, 목록은 개수만 싣는다.
 * 원본에 있는 칸만 싣고, 읽을 때마다 달라지는 통계(대화·좋아요 수 등)는 싣지 않는다(저장 계획이 낡은 것으로 보이게 된다).
 */
function edenExtras(work: Obj, characters: Obj[]): Obj {
  const out: Obj = {}
  const short = (key: string, from: string): void => {
    if (!Object.hasOwn(work, from)) return
    const v = work[from]
    if (v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)))
      out[key] = v
    else if (typeof v === 'string') {
      if (v.length <= EXTRA_TEXT_MAX) out[key] = v
      else out[key + '_length'] = v.length
    }
  }
  const strings = (key: string): void => {
    const v = work[key]
    if (!Array.isArray(v)) return
    const items = v.filter((s): s is string => typeof s === 'string')
    if (items.length === v.length && items.length <= EXTRA_LIST_MAX && items.every((s) => s.length <= EXTRA_TEXT_MAX))
      out[key] = items
    else out[key + '_count'] = v.length
  }
  const count = (key: string, from: string): void => {
    const v = work[from]
    if (Array.isArray(v)) out[key] = v.length
  }
  const filled = (key: string, from: string): void => {
    if (Object.hasOwn(work, from)) out[key] = text(work[from]).trim() !== ''
  }

  short('work_type', 'work_type')
  for (const key of ['genre', 'tags', 'categories', 'hashtags']) strings(key)
  short('is_adult', 'is_nsfw')
  short('template_type', 'template_type')
  short('prompt_version', 'prompt_version')
  short('image_source_mode', 'image_source_mode')
  filled('has_cover_image', 'cover_image_url')
  filled('has_default_image', 'default_image_url')
  short('selected_scenario_id', 'selected_scenario_id')
  short('selected_preset_id', 'selected_preset_id')
  count('recommended_persona_count', 'recommended_personas')
  count('preset_count', 'character_presets')
  count('external_image_count', 'external_images')
  short('first_published_at', 'first_published_at')
  short('created_at', 'created_at')
  short('content_updated_at', 'content_updated_at')
  short('update_announced_at', 'update_announced_at')

  // 캐릭터별 부가칸은 값을 풀지 않고 얼마나 채워져 있는지만 센다
  const sum = (key: string, name: string, of: (v: unknown) => number): void => {
    if (characters.some((c) => Object.hasOwn(c, key)))
      out[name] = characters.reduce((n, c) => n + of(c[key]), 0)
  }
  const size = (v: unknown): number => (Array.isArray(v) ? v.length : 0)
  const has = (v: unknown): number => (text(v).trim() !== '' ? 1 : 0)
  sum('lorebook', 'character_lorebook_entry_count', size)
  sum('mood_images', 'character_mood_image_count', size)
  sum('profile_image_asset_url', 'characters_with_profile_image', has)
  sum('scenario_settings', 'characters_with_scenario_settings', has)
  sum('character_description', 'characters_with_description', has)
  sum('start_scenario', 'characters_with_start_scenario', (v) => (v === null || v === undefined || v === '' ? 0 : 1))
  return out
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

// 분석 문서(platform-analysis/eden.md 9절)를 코드와 맞춰 옮긴 것. note는 40자 이내.
const EDEN_FEATURES: Record<string, WorkFeature> = {
  title: feature('yes', 'yes', 'yes', 'partial', '빈 값 거절, 한도는 모름'),
  description: feature('yes', 'yes', 'yes', 'partial', 'HTML 소개, 8만자 넘게 읽음'),
  main_prompt: feature('yes', 'yes', 'yes', 'yes', 'scenario_settings, 상한 없음, 빈 값 거절'),
  first_message: feature('yes', 'yes', 'yes', 'partial', '시작 상황 content 칸'),
  start_scenarios: feature('yes', 'yes', 'partial', 'yes', '기본 지정·이미지 연결·순서는 못 바꿈'),
  lorebook: feature('yes', 'yes', 'yes', 'yes', '빈 항목·키 없는 키워드 항목 거절'),
  characters: feature('yes', 'partial', 'partial', 'yes', '주연 삭제 불가, 부가칸·순서는 못 다룸'),
  example_dialogue: feature('no', 'no', 'no', 'no', '전용 칸 못 찾음'),
  user_persona: feature('yes', 'partial', 'no', 'no', '개수만 읽음, 수정은 사이트에서 직접'),
  output_rules: feature('no', 'no', 'no', 'no', '전용 칸 없음, 메인에 포함'),
  situation_images: feature('yes', 'yes', 'partial', 'yes', '올리기·삭제·순서만, 약 4.5MB 이하'),
  cover: feature('yes', 'partial', 'yes', 'yes', 'webp·gif만, 현재 주소는 cover_plan'),
  tags: feature('yes', 'yes', 'partial', 'no', '새 작품 때만 지정, 수정은 사이트에서 직접'),
  visibility: feature('yes', 'yes', 'yes', 'partial', 'public 전환은 아직 확인 못 함'),
  create_work: feature('yes', 'yes', 'yes', 'yes', '항상 비공개 초안으로 만듦'),
  delete_work: feature('yes', 'yes', 'yes', 'yes', '제목 일치 필요, 되돌릴 수 없음'),
  versioning_review: feature('unknown', 'partial', 'no', 'no', '버전·심사 못 찾음, 시각만 읽음'),
  language_editions: feature('yes', 'yes', 'partial', 'partial', 'en만 저장 확인, 자동 번역은 막음'),
  bgm_voice: feature('yes', 'no', 'no', 'no', '읽기 응답에 칸 없음, 사이트에서 직접'),
  jsx_html: feature('yes', 'yes', 'yes', 'partial', '소개 HTML만, JSX 칸 없음'),
  model_settings: feature('unknown', 'partial', 'no', 'no', '모델 선택 칸 못 찾음, 프롬프트 종류만 읽음'),
  comments_stats: feature('yes', 'no', 'no', 'no', '작품 도구 밖, 사이트에서 직접')
}

export const edenWorks: WorkAdapter = {
  id: 'eden',
  label: '에덴',
  features: EDEN_FEATURES,
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
    const characters = list(raw.characters)
    return {
      ...body(raw.work, characters, isObj(raw.images) ? raw.images : {}),
      extras: edenExtras(raw.work, characters),
      unsupported: [...UNSUPPORTED]
    }
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
      // 'constructor' 같은 상속 속성 이름이 칸 이름으로 통과하지 않게 자기 칸만 본다
      const key = Object.hasOwn(FIELDS, name) ? FIELDS[name] : undefined
      if (!key || typeof value !== 'string') throw new Error('BAD_FIELD')
      if ((name === 'main' || name === 'title') && !value.trim()) throw new Error('EMPTY_FIELD')
      // 편집기는 빈 제작자 코멘트를 null로 보낸다
      work[key] = name === 'creator_comment' && !value ? null : value
    }

    // 이번 저장에서 바뀌었거나 새로 생긴 로어북 항목과 그 항목의 옛 모습(새 항목은 undefined). 검사는 이 항목들만, 바뀐 칸에만 한다.
    const touched = new Map<Obj, Obj | undefined>()
    if (changes.lorebook) {
      // 전체 교체: 제목이 같은 옛 항목의 발동 설정·숨은 칸을 물려받고, 짝이 없는 새 항목은 기본값으로 만든다
      const old = list(work.lorebook)
      const titles = changes.lorebook.map((e) => e.title)
      const matched = matchOld(titles, old, (o) => text(o.title), {
        contents: changes.lorebook.map((e) => e.content),
        contentOf: (o) => text(o.value)
      })
      // 제목이 달라도 이어진 짝(제자리에서 제목만 고친 것)은 지워진 옛 항목이 없을 때만 믿는다.
      // 안 이어진 옛 항목이 새 항목보다 많으면 어느 것이 지워졌는지 알 수 없어, 남의 발동 설정을 물려받지 않게 새 항목으로 만든다.
      const same = (o: Obj | undefined, i: number): boolean => !!o && text(o.title) === titles[i]
      const sure = matched.filter(same).length
      const guessed = matched.filter((o, i) => o && !same(o, i)).length
      const prev =
        guessed && old.length - sure > titles.length - sure
          ? matched.map((o, i) => (same(o, i) ? o : undefined))
          : matched
      work.lorebook = changes.lorebook.map((e, i) => {
        const entry = loreRaw(prev[i], prev[i] ? carryOld(e) : e)
        touched.set(entry, prev[i])
        return entry
      })
    }
    if (changes.lorebookPatch?.length) {
      const entries = list(work.lorebook)
      for (const patch of changes.lorebookPatch) {
        const base = entries[at(patch.index, entries.length)]
        const entry = loreRaw(base, patch)
        entries[patch.index] = entry
        touched.set(entry, touched.has(base) ? touched.get(base) : base)
      }
      work.lorebook = entries
    }
    if (changes.lorebookRemove?.length) {
      const entries = list(work.lorebook)
      const gone = new Set(changes.lorebookRemove.map((i) => at(i, entries.length)))
      work.lorebook = entries.filter((_, i) => !gone.has(i))
    }
    if (changes.lorebookAdd?.length) {
      const added = changes.lorebookAdd.map((e) => loreRaw(undefined, e))
      for (const entry of added) touched.set(entry, undefined)
      work.lorebook = [...list(work.lorebook), ...added]
    }
    // 편집기는 내용이 빈 항목과 키워드 없는 키워드 항목을 저장할 때 버린다. 조용히 사라지지 않게 막는다.
    // 손대지 않은 옛 항목과 옛 항목에서 바뀌지 않은 칸은 사이트가 받아 주던 값 그대로 보내므로 검사하지 않는다.
    for (const e of list(work.lorebook))
      if (touched.has(e) && loreInvalid(e, touched.get(e))) throw new Error('BAD_LOREBOOK')

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

    // 번호는 고치기 전 기준이라 고치기 → 지우기 → 더하기 순서로 적용한다 (지운 뒤에 고치면 번호가 밀린다)
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
          scenario_settings: '',
          start_scenario: null
        })
        images[id] = []
      }
      next.characters = characters
      next.images = images
    }
    // 판본 겹침(view)은 판본 저장 본문이 따로 정해지므로 손대지 않는다. 작품 저장은 아래 값을 채워 보내므로
    // 보내려는 원본(next)에도 같은 값을 둔다 (저장 뒤 원본 견주기가 null → 빈 글을 차이로 보지 않게).
    if (!('edition' in next)) {
      next.work = settleWork(work)
      if (Array.isArray(next.characters)) next.characters = list(next.characters).map(settleCharacter)
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
  const lorebook = (draft.lorebook ?? []).map((e) => loreRaw(undefined, e))
  for (const e of lorebook) if (loreInvalid(e)) throw new Error('BAD_LOREBOOK')
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
      scenario_settings: '',
      start_scenario: null
    })),
    images: {}
  })
  // 편집기는 표지가 없으면 이 칸을 아예 보내지 않는다
  delete body.cover_image_url
  return body
}

/**
 * 편집기가 저장 때 버리는 항목: 내용이 비었거나, 키워드 모드인데 키워드가 없다.
 * base(옛 항목)가 있으면 그 문제를 만든 칸이 옛 값에서 바뀌었을 때만 문제로 본다.
 */
function loreInvalid(e: Obj, base?: Obj): boolean {
  const noContent = !text(e.value).trim() && (!base || e.value !== base.value)
  const noKey =
    e.triggerMode !== 'always' &&
    !text(e.key).trim() &&
    (!base || e.key !== base.key || e.triggerMode !== base.triggerMode)
  return noContent || noKey
}

/**
 * 짝지은 옛 항목이 있는 전체 교체 항목에서 "안 줬다"는 칸을 뺀다 (빼면 옛 값이 남는다).
 * 호출한 쪽이 적어 준 칸(given)은 빈 값이어도 받은 값으로 바꾼다. given이 없는 옛 호출은
 * 빈 끄는 키워드를 "안 줬다"로 보고 옛 값을 남긴다 (비우려면 lorebook_patch).
 */
function carryOld(e: LoreEntry): Partial<LoreEntry> {
  const { given, mode, offKeys, turnRange, offTurnRange, keys, ...rest } = e
  const sent = (name: string, value: unknown): boolean =>
    given ? given.includes(name) : Array.isArray(value) ? value.length > 0 : value != null
  return {
    ...rest,
    // 키워드도 적어 주지 않았으면 옛 키워드를 빈 값으로 덮지 않는다 (given이 없는 옛 호출은 늘 받은 값을 쓴다)
    ...(!given || given.includes('keys') ? { keys } : {}),
    ...(sent('mode', mode) ? { mode } : {}),
    ...(sent('offKeys', offKeys) ? { offKeys } : {}),
    ...(sent('turnRange', turnRange) ? { turnRange } : {}),
    ...(sent('offTurnRange', offTurnRange) ? { offTurnRange } : {})
  }
}

/**
 * 공통 이름의 로어북 항목(일부여도 됨)을 에덴 원본 모양에 얹는다.
 * base가 있으면 그 항목의 값(모르는 칸 포함)을 그대로 두고 준 칸만 바꾼다. 기본값(keyword·5·5)은
 * base가 없는 새 항목에만 채운다. 발동 방식·턴 값이 null이면 "주지 않았다"는 뜻이다.
 */
function loreRaw(base: Obj | undefined, e: Partial<LoreEntry>): Obj {
  const out: Obj = { ...(base ?? {}) }
  if (e.title !== undefined) out.title = e.title
  if (e.keys !== undefined) out.key = e.keys
  if (e.content !== undefined) out.value = e.content
  if (e.mode != null) out.triggerMode = e.mode
  if (e.offKeys !== undefined) out.offKeywords = e.offKeys
  if (e.turnRange != null) out.turnRange = e.turnRange
  if (e.offTurnRange != null) out.offTurnRange = e.offTurnRange
  if (!base) {
    out.title ??= ''
    out.key ??= ''
    out.triggerMode ??= 'keyword'
    out.offKeywords ??= []
    out.turnRange ??= 5
    out.offTurnRange ??= 5
  }
  return out
}

// 원본에 없거나 null이던 칸에 채워 보내는 값. 저장 본문이 예전부터 보내던 모양이다 (사이트가 받아 준 것으로 확인된 저장).
// 원본에 값이 있으면 그 값을 그대로 보낸다. 새 작품의 기본값은 edenCreateBody가 따로 정한다.
const WORK_DEFAULTS: Obj = {
  description: '',
  subtitle: '',
  work_type: 'original',
  genre: [],
  tags: [],
  categories: [],
  hashtags: [],
  template_type: 'default',
  prompt_version: 'v1',
  image_source_mode: 'mixed',
  lorebook: [],
  start_scenarios: [],
  selected_scenario_id: null,
  character_presets: [],
  selected_preset_id: null,
  recommended_personas: [],
  is_nsfw: false,
  cover_image_url: null
}
const CHARACTER_DEFAULTS: Obj = {
  character_info: '',
  character_details: '',
  is_main_character: false,
  scenario_settings: '',
  start_scenario: null
}

/** 원본 칸을 그대로 두고, 없거나 null인 칸만 defaults 값으로 채운 사본 */
function withDefaults(o: Obj, defaults: Obj): Obj {
  const out: Obj = { ...o }
  for (const [key, value] of Object.entries(defaults))
    if (out[key] == null) out[key] = structuredClone(value)
  return out
}

/** 저장으로 나갈 모양의 작품 칸. 편집기는 빈 제작자 코멘트를 null로 보낸다 */
const settleWork = (w: Obj): Obj => ({
  ...withDefaults(w, WORK_DEFAULTS),
  creator_comment: text(w.creator_comment) || null
})
const settleCharacter = (c: Obj): Obj => withDefaults(c, CHARACTER_DEFAULTS)

/**
 * 통째 저장(PUT /api/works/{id}) 본문. 편집기의 본문 조립 함수와 같은 모양이다
 * (2026-11-10 사이트 코드와 시험 작품 저장으로 확인). 공개 상태(visibility·status)는
 * 읽은 값 그대로 보내고, 캐릭터마다 이미지 목록을 같이 보낸다.
 * 작품·캐릭터의 bgm·character_voice는 읽기 응답에 없어 보내지 않는다.
 * 칸 값은 원본에 있던 그대로 보낸다. 원본에 없거나 null이던 칸은 예전부터 보내던 기본값으로 채운다
 * (WORK_DEFAULTS·CHARACTER_DEFAULTS: null로 오는 subtitle·캐릭터 scenario_settings는 빈 글).
 * 이 밖의 변환은 편집기가 빈 제작자 코멘트를 null로 보낸다는 것뿐이다.
 * 공개 상태는 기본값이 없다. 모르면 WORK_SHAPE로 멈춘다.
 */
export function edenSaveBody(raw: unknown): Obj {
  if (!isObj(raw) || !isObj(raw.work)) throw new Error('WORK_SHAPE')
  const w = settleWork(raw.work)
  const images = isObj(raw.images) ? raw.images : {}
  const visibility = strOrNull(w.visibility)
  const status = strOrNull(w.status)
  if (
    !visibility ||
    !status ||
    typeof w.scenario_settings !== 'string' ||
    typeof w.title !== 'string'
  )
    throw new Error('WORK_SHAPE')
  return {
    title: w.title,
    description: w.description,
    subtitle: w.subtitle,
    work_type: w.work_type,
    genre: w.genre,
    tags: w.tags,
    categories: w.categories,
    hashtags: w.hashtags,
    scenario_settings: w.scenario_settings,
    template_type: w.template_type,
    prompt_version: w.prompt_version,
    lorebook: w.lorebook,
    start_scenarios: w.start_scenarios,
    selected_scenario_id: w.selected_scenario_id,
    character_presets: w.character_presets,
    selected_preset_id: w.selected_preset_id,
    recommended_personas: w.recommended_personas,
    image_source_mode: w.image_source_mode,
    creator_comment: w.creator_comment,
    is_nsfw: w.is_nsfw,
    visibility,
    status,
    cover_image_url: w.cover_image_url,
    characters: list(raw.characters).map((original, order) => {
      const c = settleCharacter(original)
      const id = strOrNull(c.id)
      if (!id || typeof c.character_name !== 'string') throw new Error('WORK_SHAPE')
      return {
        id,
        character_name: c.character_name,
        character_info: c.character_info,
        character_details: c.character_details,
        is_main_character: c.is_main_character,
        // 캐릭터에 따로 적힌 값이 있을 때만 그 값, 없으면 작품의 값을 따른다 (편집기 본문 모양)
        template_type: c.template_type ?? w.template_type,
        character_order: order,
        scenario_settings: c.scenario_settings,
        start_scenario: c.start_scenario,
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
