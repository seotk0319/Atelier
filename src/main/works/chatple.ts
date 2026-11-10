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

function visibilityOf(c: Obj): string | null {
  return VISIBILITY[Number(c.flag_use ?? 0)] ?? null
}
/** CyBwIHaa 표시와 같은 기준: 비공개·링크는 그대로, 공개는 심사 상태 */
function statusOf(c: Obj, pending: Obj | null): string {
  const use = Number(c.flag_use ?? 0)
  if (use === 1) return 'private'
  if (use === 2) return 'link'
  if (pending && Number(pending.status) === 1) return 'edit-in-review'
  if (pending && Number(pending.status) === 3) return 'edit-rejected'
  const review = Number(c.review_status ?? 0)
  if (review === 2 || Number(c.flag_public) === 1) return 'approved'
  return review === 3 ? 'rejected' : 'in-review'
}

/** 편집 화면 저장 본문 (Bt9kDi_a lr()의 _). 불러오기 rr()가 만든 폼을 거친 값과 같게 옮겼다 */
export function chatpleBody(c: Obj): Obj {
  const starts = list(c.starts)
  const startIndex = new Map<number, number>()
  starts.forEach((s, i) => {
    const idx = Number(s.idx)
    if (Number.isInteger(idx) && idx > 0) startIndex.set(idx, i)
  })
  const kept = starts
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => text(s.title).trim() && text(s.first_message).trim())
  const memorybooks = list(c.memorybooks)
    .filter((m) => text(m.content).trim())
    .map((m) => {
      // 불러올 때 도입부 번호를 도입부 자리(0부터)로 바꾸고, 저장 때 그 자리를 보낸다
      const targets = (Array.isArray(m.target_start_idxs) ? m.target_start_idxs : [])
        .map((n) => startIndex.get(Number(n)) ?? -1)
        .filter((n) => n >= 0)
      return {
        idx: idText(m.idx) ? Number(m.idx) : undefined,
        title: text(m.title).trim(),
        keywords: keywordsOf(m)
          .map((k) => k.trim())
          .filter(Boolean)
          .slice(0, LIMITS.memoryKeywords),
        content: tidy(text(m.content)).trim().slice(0, LIMITS.memoryContent),
        target_start_idxs: targets.length ? targets : undefined
      }
    })
    .filter((m) => m.keywords.length > 0 && m.content.length > 0)
    .map((m, i) => ({ ...m, sort_no: i }))
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
  const contentType = Number(c.content_type ?? 0) || 0
  const nullable = (v: unknown): number | '' =>
    v === null || v === undefined || v === '' ? '' : Number(v)
  return {
    title: text(c.title),
    content: text(c.content) || undefined,
    // 대표 이미지는 보내지 않는다 (편집 화면도 새 파일이 없으면 빼고 보낸다)
    avatar_url: undefined,
    creation_type: text(c.creation_type ?? c.creationType) || 'roleplay',
    flag_use: Number(c.flag_use ?? 0),
    // 불러오기 rr()와 같다: false·0이 아니면 성인 1 (값이 없을 때도 1)
    flag_adult: c.flag_adult !== false && c.flag_adult !== 0 ? 1 : 0,
    one_line_intro: text(c.one_line_intro) || undefined,
    introduction: tidy(text(c.introduction)),
    creator_comment: text(c.creator_comment) || undefined,
    character_tendency: text(c.character_tendency) || 'all',
    genre: text(c.genre) || undefined,
    content_type: [0, 4, 5].includes(contentType) ? contentType : undefined,
    rec_view_mode: nullable(c.rec_view_mode),
    rec_tier_idx: nullable(c.rec_tier_idx),
    character_idxs: characterIdxs.length ? characterIdxs : undefined,
    hashtags: hashtags.length ? hashtags : undefined,
    starts: kept.length
      ? kept.map(({ s, i }) => {
          const suggestions = strings(s.recommend_suggestion)
            .map((g) => g.trim())
            .filter(Boolean)
          const isDefault = Number(s.flag_default ?? 0) === 1
          return {
            idx: idText(s.idx) ? Number(s.idx) : undefined,
            title: text(s.title).trim(),
            content: tidy(text(s.content)).trim(),
            prompt_content: text(s.prompt_content),
            first_message: text(s.first_message) || undefined,
            start_image_url: text(s.start_image_url) || null,
            secret: text(s.secret) || undefined,
            writing_style: text(s.writing_style) || undefined,
            sort_no: typeof s.sort_no === 'number' ? s.sort_no : i,
            flag_default: isDefault ? 1 : 0,
            recommend_suggestion: suggestions.length ? suggestions.slice(0, 3) : undefined,
            flag_public: isDefault || Number(s.flag_public ?? 1) !== 0 ? 1 : 0
          }
        })
      : undefined,
    memorybooks
  }
}

/** 캐릭터 저장 본문 (Bt9kDi_a Ve()) */
function characterBody(c: Obj): Obj {
  const vars = list(c.variables)
    .slice(0, 3)
    .map((v, i) => ({
      idx: v.idx,
      name: text(v.name).trim(),
      description: text(v.description).trim() || null,
      default_value: typeof v.default_value === 'number' ? v.default_value : 0,
      min_value: v.min_value ?? null,
      max_value: v.max_value ?? null,
      sort_no: i
    }))
  return {
    name: text(c.character_name).trim(),
    one_line_intro: text(c.character_intro).trim(),
    description: text(c.character_description).trim(),
    variables: vars.length ? vars : undefined
  }
}

function check(c: Obj): void {
  for (const [name, key] of Object.entries(FIELDS)) {
    const value = text(c[key])
    if ((REQUIRED.has(key) && !value.trim()) || value.length > LIMITS[key])
      throw new Error('BAD_FIELD ' + name + (REQUIRED.has(key) ? ' 1~' : ' ~') + LIMITS[key] + '자')
  }
  for (const [i, s] of list(c.starts).entries()) {
    const where = 'BAD_START start_scenarios[' + i + ']'
    if (!text(s.title).trim() || text(s.title).length > LIMITS.startTitle)
      throw new Error(where + '.title 1~30자')
    if (!text(s.first_message).trim()) throw new Error(where + '.content 비울 수 없음')
    if (text(s.content).length > LIMITS.startContent) throw new Error(where + '.situation ~2000자')
  }
  for (const [i, m] of list(c.memorybooks).entries()) {
    const where = 'BAD_LOREBOOK lorebook[' + i + ']'
    // 내용이나 키워드가 빈 메모리북은 편집 화면이 저장에서 빼 버린다 → 지워진 것처럼 보이므로 받지 않는다
    if (!text(m.content).trim() || text(m.content).length > LIMITS.memoryContent)
      throw new Error(where + '.content 1~450자')
    const keys = keywordsOf(m).filter((k) => k.trim())
    if (!keys.length || keys.length > LIMITS.memoryKeywords) throw new Error(where + '.keys 1~5개')
    if (text(m.title).length > LIMITS.memoryTitle) throw new Error(where + '.title ~30자')
  }
  const names = new Set<string>()
  for (const [i, ch] of list(c.characters).entries()) {
    const where = 'BAD_CHARACTER characters[' + i + ']'
    const name = text(ch.character_name).trim()
    if (!name || name.length > LIMITS.characterName) throw new Error(where + '.name 1~20자')
    if (names.has(name)) throw new Error(where + '.name 같은 이름')
    names.add(name)
    if (text(ch.character_intro).length > LIMITS.characterIntro)
      throw new Error(where + '.info ~200자')
    const d = text(ch.character_description)
    if (!d.trim() || d.length > LIMITS.characterDescription)
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
  if (entry.title !== undefined) out.title = entry.title
  if (entry.content !== undefined) out.content = entry.content
  if (entry.keys !== undefined) {
    out.keywords = keyList(entry.keys)
    delete out.keyword
  }
  return out
}

/** 저장 본문을 거친 모양으로 원본을 맞춘다 (편집 화면이 저장 때 하는 정리와 같다) */
function canon(c: Obj): void {
  c.introduction = tidy(text(c.introduction))
  c.starts = list(c.starts).map((s) => ({
    ...s,
    title: text(s.title).trim(),
    content: tidy(text(s.content)).trim()
  }))
  c.memorybooks = list(c.memorybooks).map((m) => ({
    ...m,
    title: text(m.title).trim(),
    content: tidy(text(m.content)).trim().slice(0, LIMITS.memoryContent),
    keywords: keywordsOf(m)
      .map((k) => k.trim())
      .filter(Boolean)
      .slice(0, LIMITS.memoryKeywords)
  }))
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
  capabilities: ['works_list', 'work_read', 'lorebook', 'start_scenarios', 'characters', 'save'],

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
          updatedAt: text(c.upd_dt) || text(c.reg_dt) || null,
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
      updatedAt: text(c.upd_dt) || text(c.reg_dt) || null,
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
      }))
    }
  },

  applyChanges(raw, changes) {
    const base = chatpleRaw(raw)
    // 수정본이 다시 심사 중이면 편집 화면도 그 상태를 먼저 보여 준다. 겹쳐 보내지 않는다.
    if (base.pendingEdit && Number(base.pendingEdit.status) === 1) throw new Error('IN_REVIEW')
    const next = structuredClone(base)
    const c = next.content
    canon(c)

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
      const old = books
      books = changes.lorebook.map((e, i) => memoryFrom(e, old[i]))
    }
    for (const patch of changes.lorebookPatch ?? []) {
      const i = at(patch.index, books.length)
      books[i] = memoryFrom(patch, books[i])
    }
    if (changes.lorebookRemove?.length) {
      const gone = new Set(changes.lorebookRemove.map((i) => at(i, books.length)))
      books = books.filter((_, i) => !gone.has(i))
    }
    for (const entry of changes.lorebookAdd ?? []) books.push(memoryFrom(entry, undefined))
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
    // 저장 본문과 같은 모양으로 한 번 더 맞춘다 (빈 줄 정리·자르기)
    canon(c)
    check(c)
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
