// 크랙(뤼튼) 연결부가 같이 쓰는 주소·모양·변환 (crack.ts와 crack-media.ts가 함께 쓴다).
// 근거: 2026-11-10 크랙 웹 공개 스크립트 (character-web prod main-arm64-f421ab9)
//   _app 묶음: API 기준 주소 = NEXT_PUBLIC_API_GATEWAY_URL(https://crack-api.wrtn.ai) + "/crack-api"
//   pages/builder/story 묶음: 편집 데이터 GET /stories/me/{id}, 서버 응답 → 편집 폼 변환 z(), 폼 → 저장 본문 F()/rj
//   4875 묶음(모듈 10184): POST /stories/v2(새 작품), PATCH /stories/{id}/v2(수정 등록), POST /stories/profile-image
// 응답은 모두 {result:"SUCCESS", data} 모양이고, 사이트의 axios는 본문(result·data)을 그대로 돌려준다.
import { randomInt } from 'node:crypto'
import type { FileRules } from './types'
import { EXTRA_LIST_MAX, EXTRA_TEXT_MAX, at, isObj, list, strOrNull, strings, text } from './shared'
export { at, isObj, list, strOrNull, strings, text }

export const CRACK_ORIGIN = 'https://crack-api.wrtn.ai'
export const CRACK_API = CRACK_ORIGIN + '/crack-api'
// 작품 번호: 24자리 16진수(ObjectId). 알림 쪽(model.mjs)도 /detail/{24자리}로 본다
export const OID = '[a-f0-9]{24}'
export const OID_RE = new RegExp('^' + OID + '$')

// 편집기 프로필 이미지 규칙: jpeg·png·webp·gif, 5MB(5,242,880바이트), 2:3으로 잘라 올린다
export const CRACK_IMAGE_RULES: FileRules = {
  extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif'],
  maxBytes: 5_242_880
}

export type Obj = Record<string, unknown>

export function crackWorkId(id: string): string {
  if (!OID_RE.test(id)) throw new Error('BAD_WORK_ID')
  return id
}

/** 크랙 API 주소이고 경로가 맞는지. query를 주면 쿼리도 그 검사로 본다 (주지 않으면 쿼리가 없어야 한다) */
export function crackPlain(
  url: string,
  paths: RegExp[],
  query?: (q: URLSearchParams) => boolean
): boolean {
  try {
    const u = new URL(url)
    return (
      u.origin === CRACK_ORIGIN &&
      !u.username &&
      !u.password &&
      !u.hash &&
      (query ? query(u.searchParams) : !u.search) &&
      paths.some((re) => re.test(u.pathname))
    )
  } catch {
    return false
  }
}

/** 서버 오류 본문에서 짧은 코드·문구만 꺼낸다 (본문 전체는 남기지 않는다) */
export function crackError(reply: unknown): string {
  if (!isObj(reply)) return ''
  const code = text(reply.code)
  const message = text(reply.message)
  return (code ? code + ' ' : '') + message.slice(0, 80)
}
export async function crackJson(res: Response): Promise<unknown> {
  if (res.status === 401 || res.status === 403) throw new Error('LOGIN_REQUIRED')
  if (res.status === 404) throw new Error('WORK_NOT_FOUND')
  if (!res.ok) throw new Error('WORK_READ_FAILED ' + res.status)
  return res.json()
}
/** {result, data} 응답에서 data를 꺼낸다 */
export function crackData(body: unknown): unknown {
  if (!isObj(body) || !('data' in body)) throw new Error('WORK_SHAPE')
  return body.data
}

// ───────────── 원본 ─────────────

export interface CrackRaw {
  id: string
  /** GET /stories/me/{id}의 data (편집기가 편집 폼을 채우는 원본) */
  story: Obj
}
export function crackRaw(raw: unknown): CrackRaw {
  if (!isObj(raw) || !strOrNull(raw.id) || !isObj(raw.story)) throw new Error('WORK_SHAPE')
  return raw as unknown as CrackRaw
}

/** 편집 데이터 읽기. 지워진 작품(status deleted)은 없는 작품으로 본다 */
export async function crackReadRaw(
  read: (url: string) => Promise<Response>,
  id: string
): Promise<CrackRaw> {
  const wid = crackWorkId(id)
  const story = crackData(await crackJson(await read(CRACK_API + '/stories/me/' + wid)))
  if (!isObj(story)) throw new Error('WORK_SHAPE')
  if (story.status === 'deleted') throw new Error('WORK_NOT_FOUND')
  return { id: wid, story }
}

// ───────────── 편집 폼 (편집기 z() 그대로) ─────────────

// 편집기 nanoid (폼 안에서만 쓰는 번호)
const ALPHABET = 'useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict'
export const nanoid = (n = 21): string =>
  Array.from({ length: n }, () => ALPHABET[randomInt(64)]).join('')

/** 편집기 S(): 비었으면(undefined·길이 0) 보내지 않는다 */
export function S<T extends string | unknown[]>(v: T | undefined | null): T | undefined {
  return v === undefined || v === null || v.length === 0 ? undefined : v
}
/** 편집기 nf(): 공백뿐이면 보내지 않는다 */
/** 편집기 S()를 모양 모르는 값에 쓸 때 (문자열·배열이 아니면 그대로 둔다) */
export const Sany = (v: unknown): unknown =>
  v === undefined || v === null || ((typeof v === 'string' || Array.isArray(v)) && v.length === 0)
    ? undefined
    : v
export const nf = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim().length > 0 ? v : undefined

export interface FormKeyword {
  id: string
  name: string
  prompt: string
  keywords: string[]
  /** 이 노트가 적용되는 시작 설정 (폼 번호) */
  startingSetId: string[]
}
export interface FormSituationImage extends Obj {
  startingSetId: string[]
}
export interface FormStartingSet {
  id: string
  /** 원본 startingSets에서의 자리 (새로 더한 시작 설정은 없다) */
  origin?: number
  baseSetId?: string
  name: string
  initialMessages: string[]
  playGuide: string
  situationPrompt: string
  replySuggestions: string[]
  parameters?: Obj[]
  ending?: { endings: Obj[] }
  imageMatrix: { categories: string[]; situations: string[] }
}
export interface CrackForm {
  portraitImageUrl: string
  name: string
  description: string
  detailDescription: string
  simpleDescription: string
  promptTemplate: string
  storyDetails: string
  customPrompt: unknown
  chatExamples: { user: string; character: string }[]
  startingSets: FormStartingSet[]
  _situationImages: FormSituationImage[]
  _keywordBook: FormKeyword[]
  shortcutCommands: Obj[]
  visibility: string
  isAdult: unknown
  genreId: unknown
  target: unknown
  chatType: unknown
  defaultCrackerModel: unknown
  chatModelId: unknown
  tags: string[]
  isCommentBlocked: unknown
  originContentTitle: unknown
  fanficAgreement: unknown
  creatorRecommendedMaxOutput: Obj
  addonCategories: Obj[] | undefined
  fanfic: Obj | undefined
  isMovingPortraitImage: boolean
  situationImageVersion: string
}

const keywordKey = (k: Obj): string =>
  text(k.name) + '_' + text(k.prompt) + '_' + strings(k.keywords).join(',')
const imageKey = (e: Obj): string =>
  JSON.stringify([e.category ?? '', e.situation, e.keyword ?? '', e.imageUrl])

/**
 * 시작 설정마다 따로 저장된 키워드북·상황 이미지를 편집기처럼 하나로 모은다.
 * 같은 내용(이름·정보·키워드)이면 한 항목으로 합치고 적용 대상 시작 설정을 모은다 (편집기 z()의 순서 규칙 그대로).
 */
function gather<T extends { startingSetId: string[] }>(
  sets: Obj[],
  ids: string[],
  pick: (set: Obj) => Obj[],
  keyOf: (e: Obj) => string,
  make: (e: Obj, setId: string) => T
): T[] {
  const order: string[] = []
  const byKey = new Map<string, T>()
  sets.forEach((set, t) => {
    const items = pick(set)
    items.forEach((item, n) => {
      const key = keyOf(item)
      const found = byKey.get(key)
      if (found) {
        found.startingSetId = [...new Set([...found.startingSetId, ids[t]])]
        return
      }
      byKey.set(key, make(item, ids[t]))
      // 뒤에 오는 항목 중 이미 자리 잡은 것이 있으면 그 앞에 끼운다
      let place = order.length
      for (let k = n + 1; k < items.length; k++) {
        const j = order.indexOf(keyOf(items[k]))
        if (j !== -1) {
          place = j
          break
        }
      }
      order.splice(place, 0, key)
    })
  })
  return order.map((k) => byKey.get(k)).filter((v): v is T => v !== undefined)
}

/** 서버 편집 데이터 → 편집기 폼 (편집기 z()) */
export function crackForm(story: Obj): CrackForm {
  const rawSets = list(story.startingSets)
  const startingSets: FormStartingSet[] = rawSets.map((e, origin) => ({
    id: text(e._id) || nanoid(),
    origin,
    ...(typeof e.baseSetId === 'string' ? { baseSetId: e.baseSetId } : {}),
    name: text(e.name),
    initialMessages: strings(e.initialMessages),
    playGuide: text(e.playGuide),
    situationPrompt: text(e.situationPrompt),
    replySuggestions: strings(e.replySuggestions),
    ...(Array.isArray(e.parameters)
      ? {
          parameters: list(e.parameters).map((p) => ({
            name: p.name,
            unit: p.unit,
            min: p.min,
            max: p.max,
            initialValue: p.initialValue,
            prompt: p.prompt,
            iconUrl: p.iconUrl,
            colorHexCode: p.colorHexCode,
            levels: Array.isArray(p.levels)
              ? list(p.levels).map((l) => ({
                  name: l.name,
                  levelMinValue: l.levelMinValue,
                  levelMaxValue: l.levelMaxValue,
                  levelPrompt: l.levelPrompt
                }))
              : undefined
          }))
        }
      : {}),
    ...(isObj(e.ending)
      ? {
          ending: {
            endings: list(e.ending.endings).map((x) => ({
              baseEndingId: x.baseEndingId,
              name: text(x.name),
              conditionPrompt: text(x.conditionPrompt),
              epilogueExample: text(x.epilogueExample),
              hint: text(x.hint),
              imageUrl: x.imageUrl,
              blurredImageUrl: x.blurredImageUrl,
              rarity: x.rarity,
              condition: formCondition(x.condition)
            }))
          }
        }
      : {}),
    imageMatrix: {
      categories: (Array.isArray(e.imageMatrix && (e.imageMatrix as Obj).categories)
        ? ((e.imageMatrix as Obj).categories as unknown[])
        : []
      ).map((c) => (typeof c === 'string' ? c : text(isObj(c) ? c.name : ''))),
      situations: (Array.isArray(e.imageMatrix && (e.imageMatrix as Obj).situations)
        ? ((e.imageMatrix as Obj).situations as unknown[])
        : []
      ).map((c) => (typeof c === 'string' ? c : text(isObj(c) ? c.name : '')))
    }
  }))
  const ids = startingSets.map((s) => s.id)
  const _situationImages = gather<FormSituationImage>(
    rawSets,
    ids,
    (s) => list(s.situationImages),
    imageKey,
    (e, setId) => ({ ...e, startingSetId: [setId] })
  )
  const _keywordBook = gather<FormKeyword>(
    rawSets,
    ids,
    (s) => list(s.keywordBook),
    keywordKey,
    (e, setId) => ({
      id: nanoid(),
      name: text(e.name),
      prompt: text(e.prompt),
      keywords: strings(e.keywords),
      startingSetId: [setId]
    })
  )
  const max = isObj(story.creatorRecommendedMaxOutput) ? story.creatorRecommendedMaxOutput : null
  const template = isObj(story.promptTemplate)
    ? text(story.promptTemplate.template)
    : text(story.promptTemplate)
  return {
    portraitImageUrl: isObj(story.portraitImage)
      ? text(story.portraitImage.gif) || text(story.portraitImage.origin)
      : '',
    name: text(story.name),
    description: text(story.detailDescription),
    detailDescription: text(story.detailDescription),
    simpleDescription: text(story.simpleDescription),
    promptTemplate: template || 'default',
    storyDetails: text(story.storyDetails),
    customPrompt: story.customPrompt,
    chatExamples: list(story.chatExamples).map((e) => ({
      user: text(e.user),
      character: text(e.character)
    })),
    startingSets,
    _situationImages,
    _keywordBook,
    shortcutCommands: list(story.shortcutCommands).map((e) => ({
      id: e.id,
      shortcutId: e.shortcutId,
      name: e.name,
      description: e.description,
      prompt: e.prompt,
      createdAt: e.createdAt,
      sourceShortcutCommandId: e.sourceShortcutCommandId
    })),
    visibility: text(story.visibility) || 'private',
    isAdult: story.isAdult,
    genreId: story.genreId || '',
    target: story.target ? story.target : '',
    chatType: story.chatType ? story.chatType : '',
    defaultCrackerModel:
      story.defaultCrackerModel === 'superchat' || story.defaultCrackerModel === 'superchatPlus'
        ? 'superchat_2_0'
        : story.defaultCrackerModel || '',
    chatModelId: story.chatModelId || '',
    tags: strings(story.tags),
    isCommentBlocked: story.isCommentBlocked,
    originContentTitle: story.originContentTitle,
    fanficAgreement: story.fanficAgreement,
    creatorRecommendedMaxOutput: max
      ? max.type === 'TOTAL'
        ? { type: 'TOTAL', totalMultiplier: max.totalMultiplier, modelMultipliers: [] }
        : { type: 'PER_MODEL', totalMultiplier: 'default', modelMultipliers: max.modelMultipliers }
      : { type: 'TOTAL', totalMultiplier: 'default', modelMultipliers: [] },
    addonCategories: Array.isArray(story.addonCategories)
      ? list(story.addonCategories).map((c) => ({
          categoryName: c.categoryName,
          isDefault: c.isDefault,
          addons: list(c.addons).map((a) => ({
            _id: a._id,
            name: a.name,
            description: a.description,
            prompt: a.prompt
          }))
        }))
      : undefined,
    fanfic:
      isObj(story.fanfic) && story.fanfic.sourceSeriesId
        ? { sourceSeriesId: story.fanfic.sourceSeriesId }
        : undefined,
    isMovingPortraitImage: !!story.isMovingPortraitImage,
    situationImageVersion:
      story.situationImageVersion !== 'v2' &&
      rawSets.some((s) => list(s.situationImages).length > 0)
        ? 'v1'
        : 'v2'
  }
}

// ───────────── 읽기 전용 설정 (extras·unsupported) ─────────────

const shortText = (v: unknown): string | undefined =>
  typeof v === 'string' && v && v.length <= EXTRA_TEXT_MAX ? v : undefined
const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined)
const sum = (sets: Obj[], pick: (set: Obj) => number): number =>
  sets.reduce((n, set) => n + pick(set), 0)

/**
 * 공통 칸에 들지 않는 크랙 설정. 원본에 실제로 있는 칸만, 짧은 값은 그대로·긴 글은 글자 수·목록은 개수로 싣는다.
 * 조회·좋아요·댓글 수 같은 통계와 서버가 따로 바꾸는 값(검수 결과·배지·공개 시각)은 계획 뒤 변화 검사(PLAN_STALE)를 깨므로 싣지 않는다.
 * 작품 본문·표지 주소·제작자 계정 정보도 싣지 않는다.
 */
export function crackExtras(
  story: Obj,
  form: CrackForm
): { extras: Record<string, unknown>; unsupported: string[] } {
  const extras: Record<string, unknown> = {}
  const put = (key: string, value: unknown): void => {
    if (value !== undefined) extras[key] = value
  }
  const rawSets = list(story.startingSets)

  // 분류·대상·모델
  if (isObj(story.genre)) {
    put('genre_name', shortText(story.genre.name))
    put('genre_type', shortText(story.genre.type))
  }
  put('genre_id', shortText(story.genreId))
  put('target', shortText(story.target))
  put('chat_type', shortText(story.chatType))
  put('is_adult', bool(story.isAdult))
  put('is_converted_to_adult', bool(story.isConvertedToAdult))
  put(
    'prompt_template',
    shortText(isObj(story.promptTemplate) ? story.promptTemplate.template : story.promptTemplate)
  )
  put('default_cracker_model', shortText(story.defaultCrackerModel))
  put('chat_model_id', shortText(story.chatModelId))
  put('model', shortText(story.model))
  if (isObj(story.creatorRecommendedMaxOutput)) {
    const max = story.creatorRecommendedMaxOutput
    put('max_output_type', shortText(max.type))
    if (max.type === 'PER_MODEL')
      put(
        'max_output_model_count',
        Array.isArray(max.modelMultipliers) ? max.modelMultipliers.length : 0
      )
    else put('max_output_multiplier', shortText(max.totalMultiplier))
  }
  put('country_code', shortText(story.countryCode))

  // 태그
  if (Array.isArray(story.tags)) {
    const tags = strings(story.tags)
    if (tags.length <= EXTRA_LIST_MAX && tags.every((t) => t.length <= EXTRA_TEXT_MAX))
      put('tags', tags)
    else put('tag_count', tags.length)
  }

  // 표지·화면 설정
  if (isObj(story.portraitImage)) put('has_cover', !!form.portraitImageUrl)
  put('cover_is_moving', bool(story.isMovingPortraitImage))
  put('is_comment_blocked', bool(story.isCommentBlocked))
  put('situation_image_version', shortText(story.situationImageVersion))

  // 버전 (저장으로만 바뀐다). 공개 시각·검수 결과·배지는 서버가 검수 뒤 따로 바꿀 수 있어 싣지 않는다
  // (계획과 저장 사이에 바뀌면 PLAN_STALE이 거짓으로 난다)
  if (isObj(story.updateInfo)) {
    const version = story.updateInfo.version
    put('version', typeof version === 'number' ? version : undefined)
  }
  put('created_at', shortText(story.createdAt))
  const images = rawSets.flatMap((s) => list(s.situationImages))

  // 독점·2차 창작
  if (isObj(story.original)) {
    put('is_original', bool(story.original.isOriginal))
    put('is_edit_blocked', bool(story.original.isEditBlocked))
    put('is_fanfic_enabled', bool(story.original.isFanficEnabled))
  }
  if (isObj(story.onlyContent)) {
    put('only_content', bool(story.onlyContent.isOnlyContent))
    put('only_content_locked', bool(story.onlyContent.isLocked))
  }
  if (isObj(story.fanfic)) put('fanfic_source_linked', !!story.fanfic.sourceSeriesId)
  put('origin_content_title', shortText(story.originContentTitle))
  put('fanfic_agreement', bool(story.fanficAgreement))

  // 개수 (내용은 싣지 않는다)
  const replies = sum(rawSets, (s) => strings(s.replySuggestions).length)
  const stats = sum(rawSets, (s) => list(s.parameters).length)
  const endings = sum(rawSets, (s) => (isObj(s.ending) ? list(s.ending.endings).length : 0))
  const shortcuts = list(story.shortcutCommands).length
  const addonCategories = list(story.addonCategories)
  const addonCount = addonCategories.reduce((n, c) => n + list(c.addons).length, 0)
  const examples = list(story.chatExamples).length
  if (rawSets.length) {
    put('situation_image_count', images.length)
    put('reply_suggestion_count', replies)
    put('stat_count', stats)
    put('ending_count', endings)
  }
  if (Array.isArray(story.shortcutCommands)) put('shortcut_count', shortcuts)
  if (Array.isArray(story.addonCategories)) {
    put('addon_category_count', addonCategories.length)
    put('addon_count', addonCount)
  }
  if (Array.isArray(story.chatExamples)) put('chat_example_count', examples)
  if (form.startingSets.length > 1 && form._keywordBook.length)
    put(
      'keyword_notes_limited_to_some_sets',
      form._keywordBook.filter((k) => k.startingSetId.length < form.startingSets.length).length
    )

  // 사이트에는 있는데 읽지 못하는 것 (개수만 싣거나 아예 싣지 않은 것)
  const unsupported = ['제작자 노트', '대화·좋아요·댓글 수']
  if (replies) unsupported.push('추천 답변 내용')
  if (stats) unsupported.push('스탯 내용')
  if (endings) unsupported.push('엔딩 내용')
  if (shortcuts) unsupported.push('단축어 내용')
  if (addonCount) unsupported.push('애드온 내용')
  if (examples) unsupported.push('대화 예시 내용')
  if (form.startingSets.length > 1 && form._keywordBook.length)
    unsupported.push('키워드 노트 적용 시작 설정')
  if (rawSets.some((s) => strings(s.initialMessages).length > 1))
    unsupported.push('두 번째 이후 프롤로그')
  return { extras, unsupported }
}

/** 엔딩 조건: 편집기 z()가 규칙마다 폼 번호를 붙인다 (서버 값에 번호가 있으면 그 값) */
function formCondition(v: unknown): Obj | undefined {
  if (!isObj(v)) return undefined
  return {
    turnCount: v.turnCount,
    rules: Array.isArray(v.rules)
      ? list(v.rules).map((r) =>
          r.type === 'GROUP'
            ? {
                id: nanoid(),
                type: 'GROUP',
                ruleOperator: r.ruleOperator,
                rules: list(r.rules).map((x) => ({ id: nanoid(), type: 'SINGLE', ...x }))
              }
            : { id: nanoid(), type: 'SINGLE', ...r }
        )
      : undefined,
    groupOperator: v.groupOperator
  }
}
/** 편집기 E(): 엔딩 조건 → 저장 모양 */
function sendCondition(v: unknown): Obj | undefined {
  if (!isObj(v)) return undefined
  const rules = list(v.rules)
  if (!rules.length) return { turnCount: v.turnCount }
  return {
    turnCount: v.turnCount,
    groupOperator: v.groupOperator ?? 'AND',
    rules: rules.map((r) =>
      r.type === 'GROUP'
        ? {
            id: r.id,
            type: 'GROUP',
            ruleOperator: r.ruleOperator ?? 'AND',
            rules: list(r.rules).map((x) => ({
              id: x.id,
              type: 'SINGLE',
              statName: x.statName,
              valueType: x.valueType,
              value: x.value,
              comparisonOperator: x.comparisonOperator
            }))
          }
        : {
            id: r.id,
            type: 'SINGLE',
            statName: r.statName,
            valueType: r.valueType,
            value: r.value,
            comparisonOperator: r.comparisonOperator
          }
    )
  }
}
const trim = (v: unknown): unknown => (typeof v === 'string' ? v.trim() : v)

/** 이 시작 설정에 적용되는 항목인지 (편집기: baseSetId 또는 폼 번호가 적용 대상에 있으면) */
const appliesTo = (set: FormStartingSet, ids: string[]): boolean =>
  (!!set.baseSetId && ids.includes(set.baseSetId)) || ids.includes(set.id)

/**
 * 폼 → 저장 본문의 시작 설정 (편집기 F(form, keep)).
 * keep=true(수정 등록·임시저장): 빈 시작 상황·추천 답변도 그대로 보낸다. false(새 작품): 비었으면 뺀다.
 */
export function sendStartingSets(form: CrackForm, keep: boolean): Obj[] {
  return form.startingSets.map((a) => {
    const params = a.parameters
    return {
      baseSetId: a.baseSetId,
      name: a.name,
      initialMessages: a.initialMessages,
      situationPrompt: keep ? a.situationPrompt : S(a.situationPrompt),
      replySuggestions: keep ? a.replySuggestions : S(a.replySuggestions),
      playGuide: S(a.playGuide),
      imageMatrix:
        S(a.imageMatrix.categories) || S(a.imageMatrix.situations) ? a.imageMatrix : undefined,
      situationImages: form._situationImages
        .filter((e) => appliesTo(a, e.startingSetId))
        .map((e) => ({
          situation: e.situation,
          keyword: e.keyword || '',
          imageUrl: e.imageUrl,
          blurredImageUrl: e.blurredImageUrl,
          hint: e.hint,
          category: e.category,
          memo: e.memo
        })),
      keywordBook: form._keywordBook
        .filter((e) => appliesTo(a, e.startingSetId))
        .map((e) => ({ name: e.name, prompt: e.prompt, keywords: e.keywords })),
      parameters: keep
        ? params?.map((p) => ({
            name: trim(p.name),
            unit: trim(p.unit),
            min: p.min,
            max: p.max,
            prompt: p.prompt,
            initialValue: p.initialValue,
            iconUrl: p.iconUrl,
            colorHexCode: p.colorHexCode,
            levels: Array.isArray(p.levels)
              ? list(p.levels).map((l) => ({
                  name: trim(l.name),
                  levelMinValue: l.levelMinValue,
                  levelMaxValue: l.levelMaxValue,
                  levelPrompt: l.levelPrompt
                }))
              : undefined
          }))
        : S(params)?.map((p) => ({
            name: S(trim(p.name) as string),
            unit: S(trim(p.unit) as string),
            min: p.min,
            max: p.max,
            prompt: S(p.prompt as string),
            initialValue: p.initialValue,
            iconUrl: S(p.iconUrl as string),
            colorHexCode: S(p.colorHexCode as string),
            levels: Array.isArray(p.levels)
              ? S(
                  list(p.levels).map((l) => ({
                    name: trim(l.name),
                    levelMinValue: l.levelMinValue,
                    levelMaxValue: l.levelMaxValue,
                    levelPrompt: l.levelPrompt
                  }))
                )
              : undefined
          })),
      ending:
        a.ending && a.ending.endings.length
          ? {
              endings: a.ending.endings.map((x) => ({
                baseEndingId: x.baseEndingId,
                name: trim(x.name),
                conditionPrompt: x.conditionPrompt,
                epilogueExample: x.epilogueExample,
                hint: x.hint,
                imageUrl: x.imageUrl,
                blurredImageUrl: x.blurredImageUrl,
                rarity: x.rarity,
                condition: sendCondition(x.condition)
              }))
            }
          : undefined
    }
  })
}

/** 편집기 eu: 권장 최대 답변 길이 */
function maxOutput(form: CrackForm): Obj | undefined {
  const e = form.creatorRecommendedMaxOutput
  if (!e) return undefined
  return e.type === 'TOTAL'
    ? { type: 'TOTAL', totalMultiplier: e.totalMultiplier }
    : { type: 'PER_MODEL', modelMultipliers: e.modelMultipliers }
}
/** 편집기 M(): 애드온 */
function addons(v: Obj[] | undefined): Obj[] | undefined {
  if (!v || !v.length) return undefined
  return v.map((c) => ({
    categoryName: c.categoryName,
    isDefault: c.isDefault ?? false,
    addons: list(c.addons).map((a) => ({
      ...(a._id ? { _id: a._id } : {}),
      name: a.name,
      description: a.description,
      prompt: a.prompt
    }))
  }))
}
const sendChatExamples = (v: CrackForm['chatExamples']): Obj[] =>
  v
    .filter((e) => e.character.trim().length > 0 || e.user.trim().length > 0)
    .map((e) => ({ user: e.user, character: e.character }))

export const hasSituationImages = (form: CrackForm): boolean => form._situationImages.length > 0

/**
 * 공개 방식 선언 (편집기 publishDeclaration). 비공개로 두면 보내지 않는다.
 * 공개·링크 공개는 편집기 「공개 방식 설정」 창의 「즉시 공개」와 같다: 검수 대상(상황 이미지)이 있으면
 * 실패 정책(기본 do_not_publish = 한 장이라도 통과 못 하면 공개 보류)을 같이 보낸다. 예약 공개는 쓰지 않는다.
 */
export function publishDeclaration(
  visibility: string,
  moderated: boolean,
  stored: unknown
): Obj | undefined {
  if (visibility === 'private') return undefined
  if (!moderated) return {}
  const policy = isObj(stored) ? text(stored.failurePolicy) : ''
  return { failurePolicy: policy || 'do_not_publish' }
}

/**
 * 수정 등록 본문을 지을 수 있는 원본인지. 읽기 모양(crackForm)은 공개 상태·템플릿이 없으면 비공개·기본 템플릿으로
 * 채운다. 원본에 없는 값을 지어 보내지 않고 멈춘다. 계획 단계·이미지 올리기 전에도 불러 저장 때 뒤늦게 걸리지 않게 한다.
 */
export function crackShapeCheck(story: Obj): void {
  if (!text(story.visibility)) throw new Error('WORK_SHAPE visibility')
  if (
    !(isObj(story.promptTemplate) ? text(story.promptTemplate.template) : text(story.promptTemplate))
  )
    throw new Error('WORK_SHAPE promptTemplate')
}

/**
 * 수정 등록 본문 (편집기 publish의 수정 경로, PATCH /stories/{id}/v2).
 * 업데이트 노트(releaseNote)는 공개 글이라 보내지 않는다. expectedBaseSnapshotId로 다른 곳 수정과 겹치면 서버가 422로 막는다.
 */
export function crackPatchBody(story: Obj): Obj {
  crackShapeCheck(story)
  const form = crackForm(story)
  const fanficTemplate = form.promptTemplate === 'fanfic'
  return {
    portraitImageUrl: S(form.portraitImageUrl),
    name: form.name,
    description: form.description,
    detailDescription: form.detailDescription,
    simpleDescription: form.simpleDescription,
    promptTemplate: form.promptTemplate,
    storyDetails: form.storyDetails,
    customPrompt: form.customPrompt,
    chatExamples: sendChatExamples(form.chatExamples),
    startingSets: form.startingSets.length ? sendStartingSets(form, true) : undefined,
    visibility: form.visibility,
    genreId: Sany(form.genreId),
    target: Sany(form.target),
    chatType: form.chatType,
    defaultCrackerModel: form.defaultCrackerModel,
    chatModelId: form.chatModelId,
    isCommentBlocked: form.isCommentBlocked,
    tags: form.tags,
    originContentTitle: form.originContentTitle,
    fanficAgreement: form.fanficAgreement,
    isMovingPortraitImage: form.isMovingPortraitImage,
    situationImageVersion: form.situationImageVersion,
    shortcutCommands: form.shortcutCommands.length
      ? form.shortcutCommands.map((e) => ({
          // 원본에 번호가 있으면 그대로 돌려보낸다 (없을 때만 새로 붙인다)
          id: typeof e.id === 'string' && e.id ? e.id : nanoid(),
          shortcutId: e.shortcutId,
          name: e.name,
          description: e.description,
          prompt: e.prompt,
          createdAt: e.createdAt,
          sourceShortcutCommandId: e.sourceShortcutCommandId
        }))
      : undefined,
    addonCategories: fanficTemplate ? undefined : addons(form.addonCategories),
    expectedBaseSnapshotId: story.snapshotId,
    creatorRecommendedMaxOutput: maxOutput(form),
    publishDeclaration: publishDeclaration(
      form.visibility,
      hasSituationImages(form),
      story.publishDeclaration
    )
  }
}

/**
 * 새 작품 본문 (편집기 publish의 새 작품 경로, POST /stories/v2).
 * 폼 전체(...o)에 storyId와 정리한 값들을 얹는다. 비공개라 공개 방식 선언은 없다.
 */
export function crackCreateBody(form: CrackForm, storyId: string): Obj {
  const { _situationImages, _keywordBook, ...rest } = form
  void _situationImages
  void _keywordBook
  return {
    ...rest,
    model: 'sonnet',
    shortcutCommands: [],
    storyId,
    portraitImageUrl: S(form.portraitImageUrl),
    customPrompt: nf(form.customPrompt),
    chatExamples: S(sendChatExamples(form.chatExamples)),
    startingSets: sendStartingSets(form, false),
    target: Sany(form.target),
    tags: form.tags,
    genreId: Sany(form.genreId),
    addonCategories: undefined,
    fanfic: undefined,
    creatorRecommendedMaxOutput: maxOutput(form)
  }
}

/** 공통 공개 상태 ↔ 크랙 visibility (public / linkonly / private) */
export const toCommon = (v: unknown): string | null =>
  v === 'linkonly' ? 'link' : typeof v === 'string' && v ? v : null
export const fromCommon = (v: string): string => (v === 'link' ? 'linkonly' : v)
