// 챗플 작품(콘텐츠) 본문 읽기·저장. 주소와 필드는 2026-11-10 챗플 공개 스크립트에서 읽었다 (실제 호출 전).
// API 기준 주소 https://api.chatple.live (페이지 설정 apiBase). 로그인은 Login-At 헤더 + 사이트 쿠키.
//   GET    /v1/login/me                               → result.login.mem_no
//   GET    /v1/contents/creator/{mem_no}              → result.contents[] (프로필 "제작 캐릭터")
//   GET    /v1/contents/{id}/edit                     → result {content, pending_edit, …} (편집 화면 불러오기)
//   PUT    /v1/contents/{id}                          콘텐츠 저장 (JSON, 편집 화면 '수정 완료'가 만드는 본문)
//   PUT    /v1/characters/{character_idx}             캐릭터 저장 {name, one_line_intro, description, variables}
//   DELETE /v1/contents/{id}                          콘텐츠 삭제
// 근거 파일: CXQvW6rm.js(콘텐츠 API), Bt9kDi_a.js(/studio/:id/edit 불러오기 rr()·저장 lr()), C1r0dXOF.js(캐릭터 API),
//           DfA0AHNf.js(입력 한도·ny 정리), CyBwIHaa.js(공개 상태 표시).
// 글 칸: title=title(콘텐츠 이름), subtitle=one_line_intro(한줄 소개), description=introduction(콘텐츠 소개),
//        main=content(공통 프롬프트), creator_comment=creator_comment(크리에이터 코멘트).
// 시작 상황 = 도입부: content=first_message(도입부 내용), situation=content(도입부 설명), sub_prompt=prompt_content(도입부 전용 프롬프트).
// 로어북 = 메모리북 (키워드 1~5개, 내용 450자). 캐릭터는 콘텐츠와 따로 저장되는 캐릭터 목록이다.
// 공개 콘텐츠(flag_use 0)를 저장하면 사이트가 수정본을 다시 심사한다(pending_edit). 심사 중이면 저장하지 않는다.
import { matchOld } from './match-old'
import type { LoreEntry, WorkAdapter, WorkBody, WorkFetch, WorkListItem, WorkWrite } from './types'

const API = 'https://api.chatple.live'
type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
const list = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter(isObj) : [])
const text = (v: unknown): string => (typeof v === 'string' ? v : '')
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []
const idText = (v: unknown): string | null =>
  typeof v === 'number' && Number.isInteger(v) && v > 0
    ? String(v)
    : typeof v === 'string' && /^\d+$/.test(v)
      ? v
      : null

function at(index: unknown, length: number): number {
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= length)
    throw new Error('BAD_INDEX')
  return index
}
function workId(id: string): string {
  if (!/^\d{1,12}$/.test(id) || Number(id) <= 0) throw new Error('BAD_WORK_ID')
  return id
}
/** 챗플 API 주소이고 경로가 맞는지. 쿼리는 받지 않는다 */
function plain(url: string, paths: RegExp[]): boolean {
  try {
    const u = new URL(url)
    return (
      u.origin === API &&
      !u.username &&
      !u.password &&
      !u.hash &&
      !u.search &&
      paths.some((re) => re.test(u.pathname))
    )
  } catch {
    return false
  }
}
async function json(res: Response): Promise<Obj> {
  if (res.status === 401 || res.status === 403) throw new Error('LOGIN_REQUIRED')
  if (res.status === 404) throw new Error('WORK_NOT_FOUND')
  const body: unknown = await res.json().catch(() => null)
  const r = isObj(body) && isObj(body.result) ? body.result : null
  if (r && r.name === 'AUTH_ERROR') throw new Error('LOGIN_REQUIRED')
  if (!res.ok || !r) throw new Error('WORK_READ_FAILED ' + res.status)
  return r
}

// 편집 화면의 글자 수 한도 (DfA0AHNf he(...) 표)
const LIMITS = {
  title: 20,
  one_line_intro: 200,
  introduction: 1000,
  content: 7000,
  creator_comment: 1000,
  characterName: 20,
  characterIntro: 200,
  characterDescription: 1000,
  startTitle: 30,
  startContent: 2000,
  memoryTitle: 30,
  memoryContent: 450,
  memoryKeywords: 5
}
const FIELDS: Record<string, keyof typeof LIMITS> = {
  title: 'title',
  subtitle: 'one_line_intro',
  description: 'introduction',
  main: 'content',
  creator_comment: 'creator_comment'
}
// 비우면 편집 화면이 저장을 막는 칸 (DfA0AHNf L())
const REQUIRED = new Set(['title', 'one_line_intro', 'introduction', 'content'])
const VISIBILITY: Record<number, string> = { 0: 'public', 1: 'private', 2: 'link' }
const FLAG_USE: Record<string, number> = { public: 0, private: 1, link: 2 }

/** 편집 화면이 저장 직전에 하는 정리 (DfA0AHNf ny): //✎ … ✎// 메모를 지우고 빈 줄 셋 이상을 둘로 */
export const tidy = (s: string): string =>
  s ? s.replace(/[ \t]*\/\/✎[\s\S]*?✎\/\/[ \t]*/g, '').replace(/\n{3,}/g, '\n\n') : ''

interface ChatpleRaw {
  id: string
  content: Obj
  pendingEdit: Obj | null
  /** 읽었을 때의 캐릭터 (저장 때 바뀐 캐릭터만 따로 보내려고 둔다) */
  baseCharacters: Obj[]
}
function chatpleRaw(raw: unknown): ChatpleRaw {
  if (!isObj(raw) || !idText(raw.id) || !isObj(raw.content)) throw new Error('WORK_SHAPE')
  return raw as unknown as ChatpleRaw
}

/** 메모리북 키워드 (배열, 또는 옛 모양 "a|b") */
const keywordsOf = (m: Obj): string[] =>
  Array.isArray(m.keywords)
    ? strings(m.keywords)
    : typeof m.keyword === 'string'
      ? m.keyword.split('|')
      : []
const characterId = (c: Obj): string | null => idText(c.character_idx ?? c.id)

/** 공개 범위 값(0·1·2). 칸이 없거나 모르는 값이면 null — 모르는 값을 공개(0)로 보지 않는다 */
function useOf(c: Obj): number | null {
  const v = typeof c.flag_use === 'string' && c.flag_use.trim() ? Number(c.flag_use) : c.flag_use
  return typeof v === 'number' && VISIBILITY[v] !== undefined ? v : null
}
function visibilityOf(c: Obj): string | null {
  const use = useOf(c)
  return use === null ? null : VISIBILITY[use]
}
/** CyBwIHaa 표시와 같은 기준: 비공개·링크는 그대로, 공개는 심사 상태 */
function statusOf(c: Obj, pending: Obj | null): string | null {
  const use = useOf(c)
  if (use === null) return null
  if (use === 1) return 'private'
  if (use === 2) return 'link'
  if (pending && Number(pending.status) === 1) return 'edit-in-review'
  if (pending && Number(pending.status) === 3) return 'edit-rejected'
  const review = Number(c.review_status ?? 0)
  if (review === 2 || Number(c.flag_public) === 1) return 'approved'
  return review === 3 ? 'rejected' : 'in-review'
}

/** 수정 시각. `/edit` 응답에는 `upd_dt`가 없고 `update_dt`가 있다 (2026-11-10 스냅샷). 둘 다 없을 때만 등록 시각 */
const updatedOf = (c: Obj): string | null =>
  text(c.update_dt) || text(c.upd_dt) || text(c.reg_dt) || null

/** 사이트에는 있는데 이 연결부가 읽지 못하는 것. 빈 값·빈 목록·0으로 보여도 "없음"이 아니다 */
const UNSUPPORTED = [
  '캐릭터 이미지(앨범)',
  '이미지 주소(대표·도입부)',
  '캐릭터 변수 내용',
  '추천 답변 내용',
  '메모리북의 도입부 연결',
  '통계(조회·대화·좋아요 수)',
  '작품 댓글',
  '임시저장본'
]

/** 0·1·true·false·"0"·"1"이면 불리언, 그 밖에는 null */
function flagOf(v: unknown): boolean | null {
  const n = typeof v === 'string' && v.trim() ? Number(v) : v
  return n === 1 || n === true ? true : n === 0 || n === false ? false : null
}
const countOf = (items: Obj[], pick: (o: Obj) => boolean): number => items.filter(pick).length

/**
 * 공통 칸에 들지 않는 설정. 원본에 칸이 있는 것만 싣고, 긴 글·목록은 길이·개수로 줄인다.
 * 조회·대화·좋아요 수 같은 통계는 읽을 때마다 달라져 계획 뒤 변화 검사(PLAN_STALE)를 깨므로 싣지 않는다.
 * 공유 토큰·표지 주소·계정 정보는 값 없이 있음/없음만 싣는다.
 */
function extrasOf(c: Obj, pending: Obj | null): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const put = (key: string, value: unknown, name = key): void => {
    if (value !== undefined) out[name] = value
  }
  const short = (key: string, name = key): void => {
    const v = c[key]
    if (v === null) put(key, null, name)
    else if (typeof v === 'string')
      v.length <= 80 ? put(key, v, name) : put(key, v.length, name + '_length')
  }
  const num = (key: string, name = key): void => {
    const v = c[key]
    if (v === null) put(key, null, name)
    else if (typeof v === 'number' && Number.isFinite(v)) put(key, v, name)
    else if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v)))
      put(key, Number(v), name)
  }
  const flag = (key: string, name = key): void => {
    if (c[key] === null) put(key, null, name)
    else if (c[key] !== undefined) put(key, flagOf(c[key]), name)
  }
  const has = (key: string, name: string): void => {
    if (c[key] !== undefined) put(key, typeof c[key] === 'string' && !!(c[key] as string).trim(), name)
  }

  for (const key of ['genre', 'character_tendency', 'creation_type', 'original_language'])
    short(key)
  if (Array.isArray(c.hashtags)) {
    const tags = (c.hashtags as unknown[])
      .map((h) => (typeof h === 'string' ? h : isObj(h) ? text(h.hashtag) : ''))
      .filter(Boolean)
    if (tags.length <= 20 && tags.every((t) => t.length <= 80)) put('hashtags', tags)
    else put('hashtag_count', tags.length)
  }
  flag('flag_adult', 'is_adult')
  for (const key of ['content_type', 'content_flag', 'rec_view_mode', 'rec_tier_idx'])
    num(key)
  for (const key of ['prompt_profile_idx', 'tier_group_idx', 'scoring_profile_idx']) num(key)
  has('avatar_url', 'has_cover_image')
  has('poster_url', 'has_poster_image')
  has('share_token', 'has_share_token')
  if (c.original_novel_idx !== undefined)
    put('original_novel_idx', c.original_novel_idx !== null, 'has_original_novel')

  num('review_status')
  // 반려 사유는 심사 담당자가 쓴 글이라 작품 글을 인용했을 수 있다: 있음/없음만 싣는다
  has('review_reason', 'has_review_reason')
  short('review_dt')
  short('open_dt')
  short('unpublish_dt')
  put('pending_edit_status', pending ? (Number.isFinite(Number(pending.status)) ? Number(pending.status) : null) : null)
  flag('flag_official', 'is_official')
  flag('is_exclusive')
  flag('is_plus')
  flag('is_original')
  flag('is_novel')
  flag('is_contest')
  flag('flag_lite', 'lite_mode')
  flag('flag_pick_mode', 'pick_mode')
  flag('flag_album_open', 'album_open')
  flag('flag_char_source', 'char_source')
  flag('flag_marketing', 'marketing')

  if (Array.isArray(c.starts)) {
    const starts = list(c.starts)
    put('start_image_count', countOf(starts, (s) => !!text(s.start_image_url).trim()))
    put(
      'recommended_reply_count',
      starts.reduce((n, s) => n + strings(s.recommend_suggestion).filter((g) => g.trim()).length, 0)
    )
    put('unpublished_start_count', countOf(starts, (s) => flag01(s.flag_public) === 0))
    put('start_secret_count', countOf(starts, (s) => !!text(s.secret).trim()))
    put('start_writing_style_count', countOf(starts, (s) => !!text(s.writing_style).trim()))
  }
  if (Array.isArray(c.characters)) {
    const chars = list(c.characters)
    put('character_variable_count', chars.reduce((n, ch) => n + list(ch.variables).length, 0))
    put('character_image_count', countOf(chars, (ch) => !!text(ch.character_avatar_url).trim()))
  }
  if (Array.isArray(c.memorybooks))
    put(
      'memorybook_linked_count',
      countOf(list(c.memorybooks), (m) => Array.isArray(m.target_start_idxs) && m.target_start_idxs.length > 0)
    )
  return out
}

/** 0·1 값 (숫자 또는 숫자 글). 칸이 없거나 null·그 밖의 값이면 null */
function flag01(v: unknown): 0 | 1 | null {
  const n = typeof v === 'string' && v.trim() ? Number(v) : v
  return n === 0 || n === 1 ? n : null
}

/** 편집 화면 저장 본문 (Bt9kDi_a lr()의 _). 불러오기 rr()가 만든 폼을 거친 값과 같게 옮겼다 */
export function chatpleBody(c: Obj): Obj {
  const starts = list(c.starts)
  const startIndex = new Map<number, number>()
  starts.forEach((s, i) => {
    const idx = Number(s.idx)
    if (Number.isInteger(idx) && idx > 0) startIndex.set(idx, i)
  })
  // 편집 화면은 제목·첫 메시지가 빈 도입부, 내용·키워드가 빈 메모리북을 저장에서 빼고 메모리북 내용·키워드는 450자·5개로
  // 자른다. 여기서는 그러지 않는다: 사용자가 바꾸지 않은 항목이 말없이 사라지거나 잘려 나가지 않게 원본 그대로 보내고,
  // 바꾼·새 항목의 빈 값·초과는 applyChanges의 check가 미리 막는다.
  const memorybooks = list(c.memorybooks).map((m, i) => {
    // 불러올 때 도입부 번호를 도입부 자리(0부터)로 바꾸고, 저장 때 그 자리를 보낸다
    const targets = (Array.isArray(m.target_start_idxs) ? m.target_start_idxs : [])
      .map((n) => startIndex.get(Number(n)) ?? -1)
      .filter((n) => n >= 0)
    return {
      idx: idText(m.idx) ? Number(m.idx) : undefined,
      title: text(m.title).trim(),
      keywords: keywordsOf(m)
        .map((k) => k.trim())
        .filter(Boolean),
      content: tidy(text(m.content)).trim(),
      target_start_idxs: targets.length ? targets : undefined,
      sort_no: i
    }
  })
  const characterIdxs = [
    ...new Set(
      list(c.characters)
        .map(characterId)
        .filter((v): v is string => !!v)
        .map(Number)
    )
  ]
  const hashtags = Array.isArray(c.hashtags)
    ? (c.hashtags as unknown[])
        .map((h) => (typeof h === 'string' ? h : isObj(h) ? text(h.hashtag) : ''))
        .filter(Boolean)
    : []
  // 공개 범위를 모르면 공개(0)로 보내지 않고 멈춘다
  const use = useOf(c)
  if (use === null) throw new Error('UNKNOWN_VISIBILITY')
  // 0·4·5만 보낸다 (편집 화면 lr()). 칸이 없거나 null이면 예전 기본값 0, 0·4·5가 아닌 값은 칸을 뺀다
  const contentType =
    c.content_type === null || c.content_type === undefined || c.content_type === ''
      ? 0
      : Number(c.content_type)
  const nullable = (v: unknown): number | '' =>
    v === null || v === undefined || v === '' ? '' : Number(v)
  return {
    title: text(c.title),
    content: text(c.content) || undefined,
    // 대표 이미지는 보내지 않는다 (편집 화면도 새 파일이 없으면 빼고 보낸다)
    avatar_url: undefined,
    // 원본에 칸이 없거나 비어 있을 때만 예전 기본값('roleplay'·'all'). 값이 있으면 그대로
    creation_type: text(c.creation_type ?? c.creationType) || 'roleplay',
    flag_use: use,
    // 불러오기 rr()와 같다: false·0·"0"이 아니면 성인 1 (값이 없을 때도 1)
    flag_adult: flagOf(c.flag_adult) === false ? 0 : 1,
    one_line_intro: text(c.one_line_intro) || undefined,
    introduction: tidy(text(c.introduction)),
    creator_comment: text(c.creator_comment) || undefined,
    character_tendency: text(c.character_tendency) || 'all',
    genre: text(c.genre) || undefined,
    content_type: [0, 4, 5].includes(contentType) ? contentType : undefined,
    // 읽은 값이 null이면 빈 문자열로 보낸다 (편집 화면 lr()의 `??""`)
    rec_view_mode: nullable(c.rec_view_mode),
    rec_tier_idx: nullable(c.rec_tier_idx),
    character_idxs: characterIdxs.length ? characterIdxs : undefined,
    hashtags: hashtags.length ? hashtags : undefined,
    starts: starts.length
      ? starts.map((s, i) => {
          const suggestions = strings(s.recommend_suggestion)
            .map((g) => g.trim())
            .filter(Boolean)
          const isDefault = Number(s.flag_default ?? 0) === 1
          // 도입부 공개 여부도 모르면 공개(1)로 채우지 않고 멈춘다. 기본 도입부도 원본 값 그대로 보낸다
          const open = flag01(s.flag_public)
          if (open === null) throw new Error('UNKNOWN_START_PUBLIC starts[' + i + ']')
          return {
            idx: idText(s.idx) ? Number(s.idx) : undefined,
            title: text(s.title).trim(),
            content: tidy(text(s.content)).trim(),
            prompt_content: text(s.prompt_content),
            first_message: text(s.first_message),
            start_image_url: text(s.start_image_url) || null,
            secret: text(s.secret) || undefined,
            writing_style: text(s.writing_style) || undefined,
            sort_no: typeof s.sort_no === 'number' ? s.sort_no : i,
            flag_default: isDefault ? 1 : 0,
            recommend_suggestion: suggestions.length ? suggestions : undefined,
            flag_public: open
          }
        })
      : undefined,
    memorybooks
  }
}

/** 캐릭터 저장 본문 (Bt9kDi_a Ve()) */
function characterBody(c: Obj): Obj {
  // 변수는 MCP가 고치지 않는다: 개수를 자르거나 값을 다듬지 않고 읽은 값 그대로 되돌려 보낸다.
  // 원본에 칸이 없거나 null일 때만 예전 기본값(소개 null, 기본값 0, 최소·최대 null, 순서는 자리 번호)
  const vars = list(c.variables).map((v, i) => ({
    idx: v.idx,
    name: v.name,
    description: v.description ?? null,
    default_value: v.default_value ?? 0,
    min_value: v.min_value ?? null,
    max_value: v.max_value ?? null,
    sort_no: typeof v.sort_no === 'number' ? v.sort_no : i
  }))
  return {
    name: text(c.character_name).trim(),
    one_line_intro: text(c.character_intro).trim(),
    description: text(c.character_description).trim(),
    variables: vars.length ? vars : undefined
  }
}

/** 바뀐 칸만 검사하려고 쓰는 기준: 바꾸기 전(정리까지 마친) 내용, 그리고 새로 만든 메모리북이 이어받은 옛 항목 */
interface Baseline {
  content: Obj
  origin: Map<Obj, Obj | undefined>
}

/**
 * 바뀌었거나 새로 더한 칸만 검사한다. 사용자가 건드리지 않은 옛 값은 사이트가 받아 준 값이므로
 * 한도를 넘거나 비어 있어도 막지 않고 그대로 보낸다.
 */
function check(c: Obj, base: Baseline): void {
  const was = base.content
  for (const [name, key] of Object.entries(FIELDS)) {
    const value = text(c[key])
    if (value === text(was[key])) continue
    if ((REQUIRED.has(key) && !value.trim()) || value.length > LIMITS[key])
      throw new Error('BAD_FIELD ' + name + (REQUIRED.has(key) ? ' 1~' : ' ~') + LIMITS[key] + '자')
  }
  const oldStarts = list(was.starts)
  for (const [i, s] of list(c.starts).entries()) {
    const o: Obj = oldStarts[i] ?? {}
    const where = 'BAD_START start_scenarios[' + i + ']'
    if (
      text(s.title) !== text(o.title) &&
      (!text(s.title).trim() || text(s.title).length > LIMITS.startTitle)
    )
      throw new Error(where + '.title 1~30자')
    if (text(s.first_message) !== text(o.first_message) && !text(s.first_message).trim())
      throw new Error(where + '.content 비울 수 없음')
    if (text(s.content) !== text(o.content) && text(s.content).length > LIMITS.startContent)
      throw new Error(where + '.situation ~2000자')
  }
  for (const [i, m] of list(c.memorybooks).entries()) {
    // 원본 그대로 남은 옛 항목은 검사하지 않는다
    if (!base.origin.has(m)) continue
    const o = base.origin.get(m)
    const where = 'BAD_LOREBOOK lorebook[' + i + ']'
    // 내용이나 키워드가 빈 메모리북은 편집 화면이 저장에서 빼 버린다 → 지워진 것처럼 보이므로 받지 않는다
    if (!o || text(m.content) !== text(o.content))
      if (!text(m.content).trim() || text(m.content).length > LIMITS.memoryContent)
        throw new Error(where + '.content 1~450자')
    const keys = keywordsOf(m).filter((k) => k.trim())
    if (!o || JSON.stringify(keys) !== JSON.stringify(keywordsOf(o).filter((k) => k.trim())))
      if (!keys.length || keys.length > LIMITS.memoryKeywords)
        throw new Error(where + '.keys 1~5개')
    if ((!o || text(m.title) !== text(o.title)) && text(m.title).length > LIMITS.memoryTitle)
      throw new Error(where + '.title ~30자')
  }
  const oldChars = list(was.characters)
  const chars = list(c.characters)
  for (const [i, ch] of chars.entries()) {
    const o: Obj = oldChars[i] ?? {}
    const where = 'BAD_CHARACTER characters[' + i + ']'
    if (text(ch.character_name) !== text(o.character_name)) {
      const name = text(ch.character_name).trim()
      if (!name || name.length > LIMITS.characterName) throw new Error(where + '.name 1~20자')
      if (chars.some((other, j) => j !== i && text(other.character_name).trim() === name))
        throw new Error(where + '.name 같은 이름')
    }
    if (
      text(ch.character_intro) !== text(o.character_intro) &&
      text(ch.character_intro).length > LIMITS.characterIntro
    )
      throw new Error(where + '.info ~200자')
    const d = text(ch.character_description)
    if (d !== text(o.character_description) && (!d.trim() || d.length > LIMITS.characterDescription))
      throw new Error(where + '.details 1~1000자')
  }
}

const keyList = (keys: string): string[] =>
  keys
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean)
/** 공통 로어북 → 메모리북. 챗플 메모리북은 제목·키워드·내용뿐이다 (발동 방식·턴·제외 키워드 없음) */
function memoryFrom(entry: Partial<LoreEntry>, base: Obj | undefined): Obj {
  if (
    (entry.mode !== undefined && entry.mode !== null) ||
    (entry.turnRange !== undefined && entry.turnRange !== null) ||
    (entry.offTurnRange !== undefined && entry.offTurnRange !== null) ||
    (entry.offKeys !== undefined && entry.offKeys.length > 0)
  )
    throw new Error('BAD_CHANGES')
  const out: Obj = base ? { ...base } : { title: '', keywords: [], content: '' }
  // 전체 교체로 받은 항목은 given에 없는 칸을 "안 줬다"로 보고 옛 값을 그대로 둔다 (빈 값으로 비우지 않는다)
  const given = (name: string): boolean => !entry.given || entry.given.includes(name)
  if (entry.title !== undefined && given('title')) out.title = entry.title
  if (entry.content !== undefined && given('content')) out.content = entry.content
  // work_read가 쉼표로 이어 붙여 준 keys를 그대로 돌려받은 경우는 원본 키워드를 그대로 둔다
  // (쉼표가 든 키워드가 쉼표에서 갈라지지 않게). 그 밖에는 쉼표로 나눈다
  if (
    entry.keys !== undefined &&
    given('keys') &&
    !(base && entry.keys === keywordsOf(base).join(', '))
  ) {
    out.keywords = keyList(entry.keys)
    delete out.keyword
  }
  return out
}

/**
 * 저장 본문을 거친 모양으로 원본을 맞춘다 (편집 화면이 저장 때 하는 정리 중 메모 삭제·빈 줄·공백 정리).
 * 항목 객체를 그 자리에서 고치므로 항목의 정체(===)가 유지된다. 450자·5개로 자르지는 않는다(check가 바뀐 항목만 막는다).
 */
function canon(c: Obj): void {
  c.introduction = tidy(text(c.introduction))
  c.starts = list(c.starts)
  for (const s of list(c.starts)) {
    s.title = text(s.title).trim()
    s.content = tidy(text(s.content)).trim()
  }
  c.memorybooks = list(c.memorybooks)
  for (const m of list(c.memorybooks)) {
    m.title = text(m.title).trim()
    m.content = tidy(text(m.content)).trim()
    m.keywords = keywordsOf(m)
      .map((k) => k.trim())
      .filter(Boolean)
  }
}

async function memNo(read: WorkFetch): Promise<number> {
  const r = await json(await read(API + '/v1/login/me'))
  const login = isObj(r.login) ? r.login : {}
  const no = Number(login.mem_no)
  if (!Number.isInteger(no) || no <= 0) throw new Error('LOGIN_REQUIRED')
  return no
}

async function failure(res: Response, what: string): Promise<Error> {
  if (res.status === 401 || res.status === 403) return new Error('LOGIN_REQUIRED')
  const body: unknown = await res.json().catch(() => null)
  const r = isObj(body) && isObj(body.result) ? body.result : {}
  if (r.name === 'AUTH_ERROR') return new Error('LOGIN_REQUIRED')
  const code = [text(r.name), text(r.code)].filter(Boolean).join(':')
  return new Error(what + ' ' + res.status + (code ? ' ' + code.slice(0, 60) : ''))
}
/** 챗플은 HTTP 200에도 본문 statusCode로 실패를 알릴 수 있다 (is_api_error) */
async function ok(res: Response, what: string): Promise<void> {
  if (!res.ok) throw await failure(res, what)
  const body: unknown = await res
    .clone()
    .json()
    .catch(() => null)
  if (isObj(body) && typeof body.statusCode === 'number' && body.statusCode >= 400)
    throw new Error(what + ' ' + body.statusCode + ' ' + text(body.code).slice(0, 20))
}

export const chatpleWorks: WorkAdapter = {
  id: 'chatple',
  label: '챗플',
  guide: {
    save: '공개 작품은 저장하면 수정본이 재심사에 들어가고, 재심사 중에는 저장이 막힌다(IN_REVIEW). 쓰기는 실제 계정에서 한 번도 해 보지 않았다. 로어북 전체 교체는 제목(과 내용)이 같은 항목만 번호·도입부 연결을 이어받으니, 이름 바꿈이나 삭제가 섞이면 lorebook_patch·lorebook_remove로 한다.',
    manual: ['새 작품', '이미지·표지', '도입부·캐릭터 추가와 삭제'],
    unverified: ['쓰기 전부(본문 저장·공개 전환·작품 삭제). 실제 계정에서는 목록과 읽기만 확인했다']
  },
  capabilities: ['works_list', 'work_read', 'lorebook', 'start_scenarios', 'characters', 'save'],
  features: {
    title: { site: 'yes', read: 'yes', write: 'yes', verified: 'partial', note: '1~20자, 읽기만 실측' },
    description: {
      site: 'yes',
      read: 'yes',
      write: 'yes',
      verified: 'partial',
      note: '한줄 소개 200자·소개 1000자'
    },
    main_prompt: { site: 'yes', read: 'yes', write: 'yes', verified: 'partial', note: '7000자, 읽기만 실측' },
    first_message: {
      site: 'yes',
      read: 'yes',
      write: 'partial',
      verified: 'partial',
      note: 'JSON 블록일 수 있고 형식 검사 없음'
    },
    start_scenarios: {
      site: 'yes',
      read: 'yes',
      write: 'partial',
      verified: 'partial',
      note: '고치기만, 추가·삭제는 사이트에서 직접'
    },
    lorebook: {
      site: 'yes',
      read: 'yes',
      write: 'partial',
      verified: 'partial',
      note: '키 5개·450자, 발동·턴 칸 없음'
    },
    characters: {
      site: 'yes',
      read: 'yes',
      write: 'partial',
      verified: 'partial',
      note: '이름·소개·설명만 고침, 추가·삭제는 사이트에서 직접'
    },
    example_dialogue: { site: 'no', read: 'no', write: 'no', verified: 'no', note: '원본에 칸 없음' },
    user_persona: { site: 'no', read: 'no', write: 'no', verified: 'no', note: '원본에 칸 없음' },
    output_rules: { site: 'no', read: 'no', write: 'no', verified: 'no', note: '공통 프롬프트에 포함' },
    situation_images: {
      site: 'yes',
      read: 'partial',
      write: 'partial',
      verified: 'partial',
      note: '첫 메시지의 주소 글만, 올리기는 사이트에서 직접'
    },
    cover: {
      site: 'yes',
      read: 'partial',
      write: 'no',
      verified: 'no',
      note: '있음 여부만 읽음, 올리기는 사이트에서 직접'
    },
    tags: {
      site: 'yes',
      read: 'partial',
      write: 'no',
      verified: 'no',
      note: '해시태그는 읽기만, 저장 때 그대로 되돌림'
    },
    visibility: { site: 'yes', read: 'yes', write: 'yes', verified: 'partial', note: '공개·비공개·링크, 쓰기 미확인' },
    create_work: { site: 'yes', read: 'no', write: 'no', verified: 'no', note: '사이트에서 직접(이미지 필요)' },
    delete_work: { site: 'yes', read: 'no', write: 'yes', verified: 'no', note: '코드만 있고 실계정 미시험' },
    versioning_review: {
      site: 'yes',
      read: 'partial',
      write: 'no',
      verified: 'partial',
      note: '상태 읽기만, 공개작 저장은 재심사'
    },
    language_editions: { site: 'unknown', read: 'no', write: 'no', verified: 'no', note: '이 연결부에 판본 없음' },
    bgm_voice: { site: 'no', read: 'no', write: 'no', verified: 'no', note: '원본에 칸 없음' },
    jsx_html: { site: 'no', read: 'no', write: 'no', verified: 'no', note: '원본에 칸 없음' },
    model_settings: {
      site: 'unknown',
      read: 'partial',
      write: 'no',
      verified: 'no',
      note: '추천 등급·프롬프트 번호만 읽음, 뜻 모름'
    },
    comments_stats: {
      site: 'yes',
      read: 'no',
      write: 'no',
      verified: 'no',
      note: '통계는 원본에만 있고 댓글 API 근거 없음'
    }
  },

  readAllowed: (url) =>
    plain(url, [
      /^\/v1\/login\/me$/,
      /^\/v1\/contents\/creator\/\d{1,12}$/,
      /^\/v1\/contents\/\d{1,12}\/edit$/
    ]),
  writeAllowed(method, url) {
    if (method === 'PUT')
      return plain(url, [/^\/v1\/contents\/\d{1,12}$/, /^\/v1\/characters\/\d{1,12}$/])
    if (method === 'DELETE') return plain(url, [/^\/v1\/contents\/\d{1,12}$/])
    return false
  },

  async list(read): Promise<WorkListItem[]> {
    const no = await memNo(read)
    const r = await json(await read(API + '/v1/contents/creator/' + no))
    if (!Array.isArray(r.contents)) throw new Error('WORK_LIST_SHAPE')
    const seen = new Set<string>()
    return list(r.contents).flatMap((c) => {
      const id = idText(c.idx)
      if (!id || seen.has(id)) return []
      seen.add(id)
      return [
        {
          id,
          title: text(c.title),
          visibility: visibilityOf(c),
          status: statusOf(c, isObj(c.pending_edit) ? c.pending_edit : null),
          updatedAt: updatedOf(c),
          characters: null
        }
      ]
    })
  },

  async readRaw(read, id) {
    const wid = workId(id)
    const r = await json(await read(API + '/v1/contents/' + wid + '/edit'))
    if (!isObj(r.content)) throw new Error('WORK_SHAPE')
    return {
      id: wid,
      content: r.content,
      pendingEdit: isObj(r.pending_edit) ? r.pending_edit : null,
      baseCharacters: list(r.content.characters)
    }
  },

  normalize(raw): WorkBody {
    const r = chatpleRaw(raw)
    const c = r.content
    return {
      id: r.id,
      title: text(c.title),
      visibility: visibilityOf(c),
      status: statusOf(c, r.pendingEdit),
      updatedAt: updatedOf(c),
      fields: Object.fromEntries(Object.entries(FIELDS).map(([k, key]) => [k, text(c[key])])),
      lorebook: list(c.memorybooks).map((m) => ({
        title: text(m.title),
        keys: keywordsOf(m).join(', '),
        content: text(m.content),
        mode: null,
        offKeys: [],
        turnRange: null,
        offTurnRange: null
      })),
      startScenarios: list(c.starts).map((s) => ({
        id: idText(s.idx),
        title: text(s.title),
        isDefault: Number(s.flag_default ?? 0) === 1,
        content: text(s.first_message),
        subPrompt: text(s.prompt_content),
        dialogue: '',
        situation: text(s.content),
        description: ''
      })),
      characters: list(c.characters).map((ch, i) => ({
        id: characterId(ch),
        name: text(ch.character_name),
        isMain: i === 0,
        order: i,
        details: text(ch.character_description),
        info: text(ch.character_intro),
        imageCount: 0
      })),
      extras: extrasOf(c, r.pendingEdit),
      unsupported: [...UNSUPPORTED]
    }
  },

  applyChanges(raw, changes) {
    const base = chatpleRaw(raw)
    // 수정본이 다시 심사 중이면 편집 화면도 그 상태를 먼저 보여 준다. 겹쳐 보내지 않는다.
    if (base.pendingEdit && Number(base.pendingEdit.status) === 1) throw new Error('IN_REVIEW')
    const next = structuredClone(base)
    const c = next.content
    canon(c)
    // 바뀐 칸만 검사하려고, 정리까지 마친 바꾸기 전 모양을 따로 둔다
    const baseline: Baseline = { content: structuredClone(c), origin: new Map() }
    const origin = baseline.origin
    const build = (entry: Partial<LoreEntry>, old: Obj | undefined): Obj => {
      const made = memoryFrom(entry, old)
      // 이미 바뀐 항목을 또 고쳐도 검사 기준은 처음 원본이다
      origin.set(made, old && origin.has(old) ? origin.get(old) : old)
      return made
    }

    if (changes.visibility !== undefined) {
      const use = FLAG_USE[changes.visibility]
      if (use === undefined) throw new Error('BAD_VISIBILITY')
      c.flag_use = use
    }
    for (const [name, value] of Object.entries(changes.fields ?? {})) {
      const key = FIELDS[name]
      if (!key || typeof value !== 'string') throw new Error('BAD_FIELD')
      c[key] = key === 'introduction' ? tidy(value) : value
    }

    let books = list(c.memorybooks)
    if (changes.lorebook) {
      // 제목으로 옛 항목과 짝짓는다. 짝이 없는 새 항목은 옛 항목의 번호·도입부 연결을 물려받지 않는다
      const old = books
      const pairs = matchOld(
        changes.lorebook.map((e) => text(e.title).trim()),
        old,
        (m) => text(m.title).trim(),
        // 챗플 메모리북은 제목이 비어 있는 것이 보통이라 내용까지 견줘 짝짓는다
        {
          contents: changes.lorebook.map((e) => tidy(text(e.content)).trim()),
          contentOf: (m) => tidy(text(m.content)).trim()
        }
      )
      books = changes.lorebook.map((e, i) => build(e, pairs[i]))
    }
    for (const patch of changes.lorebookPatch ?? []) {
      const i = at(patch.index, books.length)
      books[i] = build(patch, books[i])
    }
    if (changes.lorebookRemove?.length) {
      const gone = new Set(changes.lorebookRemove.map((i) => at(i, books.length)))
      books = books.filter((_, i) => !gone.has(i))
    }
    for (const entry of changes.lorebookAdd ?? []) books.push(build(entry, undefined))
    c.memorybooks = books

    const starts = list(c.starts)
    for (const patch of changes.startScenarios ?? []) {
      const i = at(patch.index, starts.length)
      if (
        (patch.dialogue !== undefined && patch.dialogue !== '') ||
        (patch.description !== undefined && patch.description !== '')
      )
        throw new Error('BAD_CHANGES')
      const s = { ...starts[i] }
      if (patch.title !== undefined) s.title = patch.title
      if (patch.content !== undefined) s.first_message = patch.content
      if (patch.situation !== undefined) s.content = patch.situation
      if (patch.subPrompt !== undefined) s.prompt_content = patch.subPrompt
      starts[i] = s
    }
    // 도입부를 더하거나 빼면 편집 화면이 캐릭터 이미지(앨범)를 도입부마다 따로 맞춘다. 그 흐름은 옮기지 않았다.
    if (changes.startScenariosAdd?.length || changes.startScenariosRemove?.length)
      throw new Error('START_STRUCTURE_UNSUPPORTED')
    c.starts = starts

    const chars = list(c.characters)
    for (const patch of changes.characters ?? []) {
      const i = at(patch.index, chars.length)
      const ch = { ...chars[i] }
      if (patch.name !== undefined) ch.character_name = patch.name
      if (patch.info !== undefined) ch.character_intro = patch.info
      if (patch.details !== undefined) ch.character_description = patch.details
      chars[i] = ch
    }
    // 새 캐릭터는 /characters/batch로 먼저 만들고 앨범까지 맞춰야 해서 막아 둔다. 빼기도 같은 이유.
    if (changes.charactersAdd?.length || changes.charactersRemove?.length)
      throw new Error('CHARACTER_STRUCTURE_UNSUPPORTED')
    c.characters = chars
    // 저장 본문과 같은 모양으로 한 번 더 맞춘다 (메모 삭제·빈 줄 정리)
    canon(c)
    // 저장 본문에서 공개 범위를 모르는 채로 보내지 않게 여기서 먼저 멈춘다
    if (useOf(c) === null) throw new Error('UNKNOWN_VISIBILITY')
    check(c, baseline)
    // 저장 본문이 모르는 값(도입부 공개 여부)으로 멈추는 일은 쓰기 전에 알려야 한다:
    // save()는 캐릭터를 먼저 저장하므로 거기서 터지면 작품이 일부만 저장된다
    chatpleBody(c)
    return next
  },

  async save(write: WorkWrite, id, next) {
    const r = chatpleRaw(next)
    const wid = workId(id)
    // 편집 화면 순서: 바뀐 캐릭터를 먼저 저장하고, 그다음 콘텐츠를 저장한다
    const before = new Map(r.baseCharacters.map((ch) => [characterId(ch), characterBody(ch)]))
    for (const ch of list(r.content.characters)) {
      const cid = characterId(ch)
      if (!cid) continue
      const body = characterBody(ch)
      if (JSON.stringify(before.get(cid)) === JSON.stringify(body)) continue
      await ok(await write('PUT', API + '/v1/characters/' + cid, body), 'CHARACTER_SAVE_FAILED')
    }
    await ok(await write('PUT', API + '/v1/contents/' + wid, chatpleBody(r.content)), 'SAVE_FAILED')
  },

  visibilities: ['public', 'private', 'link'],

  async remove(write, id) {
    const res = await write('DELETE', API + '/v1/contents/' + workId(id))
    if (res.status === 404) throw new Error('WORK_NOT_FOUND')
    await ok(res, 'DELETE_FAILED')
  }
}
