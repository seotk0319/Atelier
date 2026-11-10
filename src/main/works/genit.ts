// 젠잇 작품 읽기·저장. 주소와 본문 모양은 2026-11-10 젠잇 공개 스크립트(편집기 페이지
// /ko/contents/{id}/edit 의 /_next/static/chunks 9682-…·5718-…)에서 읽었다. 실제 호출로는 아직 확인하지 않았다.
//   GET    /api/auth/user/?lang=ko                                       내 계정 번호 (알림 모아보기와 같은 주소)
//   GET    /api/characters/?creator={내 번호}&creator_dashboard=true&page=N&page_size=20&lang=ko
//                                                                        크리에이터 대시보드의 내 작품 목록 {results, next}
//   GET    /api/characters/{id}/?lang=ko                                 편집기가 여는 작품 원본
//   PATCH  /api/characters/{id}/      FormData                           저장 (genit-form.ts)
//   POST   /api/characters/           FormData                           새 작품
//   DELETE /api/characters/{id}/                                         작품 삭제
// 쓰기는 모두 X-CSRFToken(쿠키 wavechat_csrftoken)을 붙여 send 통로로 보낸다 (편집기 axios 설정과 같다).
// 공통 모양: title=name, subtitle=short_intro, description=description, main=character_prompt,
// 로어북=lorebooks(content=description, keys=keywords, mode=분류), 시작 상황=latest_version.greetings
// (content=content, situation=background), 캐릭터=latest_version.cast_members(details=history, info=introduction).
import { randomUUID } from 'node:crypto'
import {
  basePrompt,
  character,
  GENIT_API,
  GENIT_SITE,
  genitCreateForm,
  genitForm,
  isObj,
  list,
  LORE_CATEGORIES,
  LORE_UNSET,
  PUBLISH_TYPES,
  strings,
  text,
  UUID_RE,
  UUID_SOURCE,
  version,
  type Obj
} from './genit-form'
import {
  GENIT_IMAGE_RULES,
  genitImageGroups,
  genitImageParts,
  genitPlanImages
} from './genit-media'
import type {
  LoreEntry,
  SendRule,
  WorkAdapter,
  WorkBody,
  WorkDraft,
  WorkFetch,
  WorkSend,
  WorkListItem,
  WorkRequest
} from './types'

const CHARACTERS = GENIT_API + '/api/characters/'
const ME = GENIT_API + '/api/auth/user/?lang=ko'
const PAGE = 20
const MAX_PAGES = 30
const DETAIL_PATH = new RegExp('^/api/characters/' + UUID_SOURCE + '/$', 'i')
const CSRF = { domain: 'genit.ai', name: 'wavechat_csrftoken', header: 'x-csrftoken' }
// 편집기 axios가 붙이는 것 중 로그인과 상관있는 것만 (origin·referer는 Django CSRF 확인용, 답글 달기와 같다)
const SEND_HEADERS = ['origin', 'referer', 'accept', 'x-request-id']
const VISIBILITY_CODES: Record<string, number> = { public: 1, link: 2, private: 3 }
const LORE_DEFAULT_CATEGORY = '설정'

function workId(id: string): string {
  if (!UUID_RE.test(id)) throw new Error('BAD_WORK_ID')
  return id.toLowerCase()
}
const characterUrl = (id: string): string => CHARACTERS + id + '/'

function apiUrl(url: string): URL | null {
  try {
    const u = new URL(url)
    return u.origin === GENIT_API && !u.username && !u.password && !u.hash ? u : null
  } catch {
    return null
  }
}
/** 쿼리가 정확히 이 이름들만, 각각 한 번씩 있고 값이 맞는지 */
function exactQuery(u: URL, rules: Record<string, RegExp>): boolean {
  const keys = [...u.searchParams.keys()]
  return (
    keys.length === Object.keys(rules).length &&
    Object.entries(rules).every(
      ([k, re]) => u.searchParams.getAll(k).length === 1 && re.test(u.searchParams.get(k) ?? '')
    )
  )
}
const LIST_QUERY = {
  creator: UUID_RE,
  creator_dashboard: /^true$/,
  ordering: /^-created_at$/,
  page: /^\d{1,3}$/,
  page_size: new RegExp('^' + PAGE + '$'),
  lang: /^ko$/
}

function headers(): Record<string, string> {
  return {
    origin: GENIT_SITE,
    referer: GENIT_SITE + '/',
    accept: 'application/json',
    'x-request-id': randomUUID()
  }
}

/** 이 연결부가 send 통로로 보내는 요청. 저장·만들기는 파일 묶음, 삭제는 본문 없음 */
export function genitSendRule(method: string, url: string): SendRule | null {
  const u = apiUrl(url)
  if (!u || u.search) return null
  const form: SendRule = { auth: 'session', body: 'form', headers: SEND_HEADERS, csrfCookie: CSRF }
  if (method === 'PATCH' && DETAIL_PATH.test(u.pathname)) return form
  if (method === 'POST' && u.pathname === '/api/characters/') return form
  if (method === 'DELETE' && DETAIL_PATH.test(u.pathname))
    return { auth: 'session', body: 'none', headers: SEND_HEADERS, csrfCookie: CSRF }
  return null
}

async function json(res: Response): Promise<unknown> {
  if (res.status === 401 || res.status === 403) throw new Error('LOGIN_REQUIRED')
  if (res.status === 404) throw new Error('WORK_NOT_FOUND')
  if (!res.ok) throw new Error('WORK_READ_FAILED ' + res.status)
  return res.json()
}
/** 거절 응답에서 원인 코드만 짧게 (본문 전체는 남기지 않는다) */
async function reason(res: Response): Promise<string> {
  const body: unknown = await res.json().catch(() => null)
  if (!isObj(body)) return ''
  const error = isObj(body.error) ? body.error : body
  const code = text(error.code) || text(error.detail) || Object.keys(body).slice(0, 3).join(',')
  return code.slice(0, 60)
}
async function sendOrThrow(
  send: WorkSend | undefined,
  request: WorkRequest,
  fail: string
): Promise<Response> {
  if (!send) throw new Error('NO_SAVE')
  const res = await send(request)
  if (res.status === 401 || res.status === 403) throw new Error('LOGIN_REQUIRED')
  if (res.status === 404) throw new Error('WORK_NOT_FOUND')
  if (!res.ok) throw new Error(fail + ' ' + res.status + ' ' + (await reason(res)))
  return res
}

function at(index: unknown, length: number): number {
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= length)
    throw new Error('BAD_INDEX')
  return index
}
const keywords = (keys: string): string[] =>
  keys
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean)
/** 공통 mode → 젠잇 로어북 분류. 분류 이름이 아니면(keyword 등) 기본값을 쓴다 */
const category = (mode: string | null | undefined, fallback: string): string =>
  mode && LORE_CATEGORIES.includes(mode) ? mode : fallback

const visibilityOf = (v: unknown): string | null => {
  const n = Number(v)
  return PUBLISH_TYPES[n] ?? (v == null || v === '' ? null : 'type' + String(v))
}

// 저장 때 본문 묶음까지 보낼지 (applyChanges가 정해 둔다. 모르면 보낸다)
const CONTENT_CHANGED = new WeakMap<object, boolean>()
const contentKey = (c: Obj): string => {
  const v = version(c)
  return JSON.stringify([c.character_prompt, c.lorebooks, v.greetings, v.cast_members])
}

function startFresh(draft: {
  title?: string
  content?: string
  situation?: string
  description?: string
  subPrompt?: string
  dialogue?: string
}): Obj {
  // 젠잇 시작 상황에는 따로 된 첫 대사·보조 프롬프트 칸이 없다
  if (draft.subPrompt !== undefined || draft.dialogue !== undefined) throw new Error('BAD_CHANGES')
  return {
    title: draft.title ?? '',
    content: draft.content ?? '',
    background: draft.situation ?? '',
    volatility_background: '',
    sample_questions: [],
    description: draft.description ?? '',
    cover_image: '',
    is_active: true
  }
}
function castFresh(c: { name: string; details?: string; info?: string }): Obj {
  if (!c.name.trim()) throw new Error('EMPTY_FIELD')
  return {
    name: c.name,
    codename: '',
    history: '',
    introduction: c.details ?? c.info ?? '',
    initial_journal: '',
    background: '',
    aliases: [],
    keywords: [],
    is_active: true
  }
}
function loreFresh(entry: LoreEntry): Obj {
  return {
    title: entry.title,
    description: entry.content,
    display_description: '',
    keywords: keywords(entry.keys),
    category: category(entry.mode, LORE_DEFAULT_CATEGORY),
    recall_cue: '',
    status: '',
    is_active: true,
    is_hidden: true,
    is_pinned: true
  }
}
function checkLore(rows: Obj[]): void {
  for (const l of rows)
    if (
      !text(l.title).trim() ||
      !text(l.description).trim() ||
      // 편집기는 분류가 미설정인 항목이 있으면 저장을 막는다
      !LORE_CATEGORIES.includes(text(l.category))
    )
      throw new Error('BAD_LOREBOOK')
}

export const genitWorks: WorkAdapter = {
  id: 'genit',
  label: '젠잇',
  capabilities: [
    'works_list',
    'work_read',
    'lorebook',
    'start_scenarios',
    'characters',
    'save',
    'images'
  ],

  readAllowed(url) {
    const u = apiUrl(url)
    if (!u) return false
    if (u.pathname === '/api/auth/user/') return exactQuery(u, { lang: /^ko$/ })
    if (u.pathname === '/api/characters/') return exactQuery(u, LIST_QUERY)
    return DETAIL_PATH.test(u.pathname) && exactQuery(u, { lang: /^ko$/ })
  },

  async list(read: WorkFetch): Promise<WorkListItem[]> {
    const me = await json(await read(ME))
    const uid = isObj(me) ? text(me.id) : ''
    if (!UUID_RE.test(uid)) throw new Error('LOGIN_REQUIRED')
    const out: WorkListItem[] = []
    // 정렬 없이 넘기면 쪽마다 순서가 달라 같은 작품이 두 번 오고 다른 작품이 빠진다 (2026-11-10 실제 목록에서 확인)
    const seen = new Set<string>()
    for (let page = 1; page <= MAX_PAGES; page++) {
      const q = new URLSearchParams({
        creator: uid,
        creator_dashboard: 'true',
        ordering: '-created_at',
        page: String(page),
        page_size: String(PAGE),
        lang: 'ko'
      })
      const body = await json(await read(CHARACTERS + '?' + q.toString()))
      const rows = list(isObj(body) ? body.results : null)
      for (const w of rows) {
        const id = text(w.id)
        // 다른 작가 작품이 섞여 오면 버린다
        if (!UUID_RE.test(id) || (w.creator_id !== undefined && w.creator_id !== uid)) continue
        if (seen.has(id.toLowerCase())) continue
        seen.add(id.toLowerCase())
        out.push({
          id: id.toLowerCase(),
          title: text(w.name),
          visibility: visibilityOf(w.publish_type),
          status: w.is_active === false ? 'inactive' : null,
          updatedAt: text(w.updated_at) || text(w.published_at) || null,
          characters: null
        })
      }
      if (!isObj(body) || !body.next || rows.length < PAGE) break
    }
    return out
  },

  async readRaw(read, id) {
    const wid = workId(id)
    const data = await json(await read(characterUrl(wid) + '?lang=ko'))
    if (!isObj(data) || text(data.id).toLowerCase() !== wid) throw new Error('WORK_SHAPE')
    return data
  },

  normalize(raw): WorkBody {
    const c = character(raw)
    const v = version(c)
    return {
      id: text(c.id).toLowerCase(),
      title: text(c.name),
      visibility: visibilityOf(c.publish_type),
      status: c.is_active === false ? 'inactive' : 'active',
      updatedAt: text(c.updated_at) || null,
      fields: {
        title: text(c.name),
        subtitle: text(c.short_intro),
        description: text(c.description),
        main: basePrompt(c.character_prompt).base
      },
      lorebook: list(c.lorebooks).map((l) => ({
        title: text(l.title),
        keys: strings(l.keywords).join(', '),
        content: text(l.description),
        mode: text(l.category) || LORE_UNSET,
        offKeys: [],
        turnRange: null,
        offTurnRange: null
      })),
      startScenarios: list(v.greetings).map((g, i) => ({
        id: typeof g.id === 'number' || typeof g.id === 'string' ? g.id : null,
        title: text(g.title),
        // 젠잇은 기본 표시가 따로 없고 첫 번째가 처음 고르는 시작 상황이다
        isDefault: i === 0,
        content: text(g.content),
        subPrompt: '',
        dialogue: '',
        situation: text(g.background),
        description: text(g.description)
      })),
      characters: list(v.cast_members).map((m, i) => ({
        id: m.id != null ? String(m.id) : null,
        name: text(m.name),
        isMain: i === 0,
        order: typeof m.display_order === 'number' ? m.display_order : i,
        // 젠잇 캐릭터의 글 칸은 소개(introduction) 하나다. 서버는 history를 받아도 돌려주지 않는다
        // (2026-11-10 실제 저장으로 확인).
        details: text(m.introduction),
        info: '',
        imageCount: text(m.profile_url) || text(m.profile_filename) ? 1 : 0
      }))
    }
  },

  applyChanges(raw, changes) {
    const original = character(raw)
    const next = structuredClone(raw) as Obj
    if (!isObj(next.latest_version)) next.latest_version = {}
    const v = next.latest_version as Obj

    if (changes.visibility !== undefined) {
      const code = VISIBILITY_CODES[changes.visibility]
      // 작업 사본(4)은 편집기도 공개 범위를 보내지 않는다
      if (!code || Number(next.publish_type) === 4) throw new Error('BAD_VISIBILITY')
      next.publish_type = code
    }

    const FIELDS: Record<string, string> = {
      title: 'name',
      subtitle: 'short_intro',
      description: 'description',
      main: 'character_prompt'
    }
    for (const [name, value] of Object.entries(changes.fields ?? {})) {
      const key = FIELDS[name]
      if (!key || typeof value !== 'string') throw new Error('BAD_FIELD')
      if ((name === 'main' || name === 'title') && !value.trim()) throw new Error('EMPTY_FIELD')
      if (name === 'main' && basePrompt(original.character_prompt).byModel)
        throw new Error('PROMPT_SHAPE')
      next[key] = value
    }

    // ── 로어북 ──
    const hadLore = list(original.lorebooks).length > 0
    if (changes.lorebook) {
      // 전체 교체: 자리가 같은 항목은 기존 칸(표시 설명·회상 단서 등)을 물려받는다
      const old = list(next.lorebooks)
      next.lorebooks = changes.lorebook.map((entry, i) => {
        const fresh = loreFresh(entry)
        if (!old[i]) return fresh
        return {
          ...old[i],
          title: entry.title,
          description: entry.content,
          keywords: keywords(entry.keys),
          category: category(entry.mode, text(old[i].category) || LORE_DEFAULT_CATEGORY)
        }
      })
    }
    if (changes.lorebookPatch?.length) {
      const rows = list(next.lorebooks)
      for (const patch of changes.lorebookPatch) {
        const row = rows[at(patch.index, rows.length)]
        const p: Partial<LoreEntry> = patch
        if (p.offKeys !== undefined || p.turnRange !== undefined || p.offTurnRange !== undefined)
          throw new Error('BAD_CHANGES')
        if (p.title !== undefined) row.title = p.title
        if (p.content !== undefined) row.description = p.content
        if (p.keys !== undefined) row.keywords = keywords(p.keys)
        if (p.mode !== undefined && p.mode !== null) {
          if (!LORE_CATEGORIES.includes(p.mode)) throw new Error('BAD_LOREBOOK')
          row.category = p.mode
        }
      }
      next.lorebooks = rows
    }
    if (changes.lorebookRemove?.length) {
      const rows = list(next.lorebooks)
      const gone = new Set(changes.lorebookRemove.map((i) => at(i, rows.length)))
      next.lorebooks = rows.filter((_, i) => !gone.has(i))
    }
    if (changes.lorebookAdd?.length)
      next.lorebooks = [...list(next.lorebooks), ...changes.lorebookAdd.map(loreFresh)]
    // 편집기는 로어북이 비면 lorebooks 칸을 보내지 않는다 → 마지막 항목은 지울 수 없다
    if (hadLore && !list(next.lorebooks).length) throw new Error('LOREBOOK_EMPTY')

    // ── 시작 상황 ──
    if (changes.startScenarios?.length) {
      const rows = list(v.greetings)
      for (const patch of changes.startScenarios) {
        const row = rows[at(patch.index, rows.length)]
        if (patch.subPrompt !== undefined || patch.dialogue !== undefined)
          throw new Error('BAD_CHANGES')
        if (patch.title !== undefined) row.title = patch.title
        if (patch.content !== undefined) row.content = patch.content
        if (patch.situation !== undefined) row.background = patch.situation
        if (patch.description !== undefined) row.description = patch.description
      }
      v.greetings = rows
    }
    if (changes.startScenariosRemove?.length) {
      const rows = list(v.greetings)
      const gone = new Set(changes.startScenariosRemove.map((i) => at(i, rows.length)))
      if (gone.has(0)) throw new Error('KEEP_DEFAULT')
      v.greetings = rows.filter((_, i) => !gone.has(i))
    }
    if (changes.startScenariosAdd?.length)
      v.greetings = [...list(v.greetings), ...changes.startScenariosAdd.map(startFresh)]
    // 편집기는 제목이나 본문이 빈 시작 상황을 저장에서 빼 버린다 → 바뀐 시작 상황에 그런 것이 있으면 막는다
    if (
      JSON.stringify(v.greetings) !== JSON.stringify(version(original).greetings) &&
      list(v.greetings).some((g) => !text(g.title).trim() || !text(g.content).trim())
    )
      throw new Error('BAD_CHANGES')

    // ── 캐릭터 ──
    if (changes.characters?.length) {
      const rows = list(v.cast_members)
      for (const patch of changes.characters) {
        const row = rows[at(patch.index, rows.length)]
        if (patch.name !== undefined) {
          if (!patch.name.trim()) throw new Error('EMPTY_FIELD')
          row.name = patch.name
        }
        // 글 칸이 하나라 details와 info를 같이 주면 받지 않는다
        if (patch.details !== undefined && patch.info !== undefined) throw new Error('BAD_CHANGES')
        const intro = patch.details ?? patch.info
        if (intro !== undefined) row.introduction = intro
      }
      v.cast_members = rows
    }
    if (changes.charactersRemove?.length) {
      const rows = list(v.cast_members)
      const gone = new Set(changes.charactersRemove.map((i) => at(i, rows.length)))
      if (gone.has(0)) throw new Error('KEEP_DEFAULT')
      v.cast_members = rows.filter((_, i) => !gone.has(i))
    }
    if (changes.charactersAdd?.length)
      v.cast_members = [...list(v.cast_members), ...changes.charactersAdd.map(castFresh)]

    const content = contentKey(next) !== contentKey(original)
    // 본문 묶음을 보낼 때는 로어북 전체가 같이 가므로 전체가 편집기 규칙(제목·내용·분류)을 지켜야 한다
    if (content) checkLore(list(next.lorebooks))
    CONTENT_CHANGED.set(next, content)
    return next
  },

  async save(_write, id, next, io) {
    const wid = workId(id)
    if (text(character(next).id).toLowerCase() !== wid) throw new Error('WORK_SHAPE')
    const content = CONTENT_CHANGED.get(next as object) ?? true
    await sendOrThrow(
      io?.send,
      {
        method: 'PATCH',
        url: characterUrl(wid),
        form: genitForm(next, { content }),
        headers: headers()
      },
      'SAVE_FAILED'
    )
  },

  visibilities: ['public', 'link', 'private'],

  async remove(_write, id, io) {
    await sendOrThrow(
      io?.send,
      { method: 'DELETE', url: characterUrl(workId(id)), headers: headers() },
      'DELETE_FAILED'
    )
  },

  async create(_write, draft, read, io) {
    const form = genitCreateForm(genitDraft(draft))
    if (!io) throw new Error('NO_CREATE')
    const res = await io.send({ method: 'POST', url: CHARACTERS, form, headers: headers() })
    if (res.status === 401 || res.status === 403) throw new Error('LOGIN_REQUIRED')
    if (!res.ok) throw new Error('CREATE_FAILED ' + res.status + ' ' + (await reason(res)))
    const reply: unknown = await res.json().catch(() => null)
    // 편집기는 만들기 응답의 id로 새 작품 화면으로 옮겨 간다
    for (const holder of isObj(reply) ? [reply, reply.data].filter(isObj) : []) {
      const found = text(holder.id)
      if (UUID_RE.test(found)) return found.toLowerCase()
    }
    if (read) {
      const fresh = (await genitWorks.list(read)).filter((w) => w.title === draft.title)
      if (fresh.length === 1) return fresh[0].id
    }
    throw new Error('CREATED_ID_UNKNOWN')
  },

  checkDraft(draft) {
    genitDraft(draft)
  },

  sendRule: genitSendRule,
  imageRules: GENIT_IMAGE_RULES,
  imageGroups: genitImageGroups,
  planImages: genitPlanImages,
  async applyImages(io, id, raw, changes) {
    const wid = workId(id)
    const parts = genitImageParts(raw, changes)
    await sendOrThrow(
      io.send,
      { method: 'PATCH', url: characterUrl(wid), form: genitForm(raw, parts), headers: headers() },
      'IMAGE_UPLOAD_FAILED'
    )
  }
}

const GENIT_TYPES = ['simulation', 'character']

/** 새 작품 내용 → 만들기 칸. 편집기가 막는 것(빈 제목·빈 시작 상황·분류 없는 로어북)은 먼저 막는다 */
export function genitDraft(draft: WorkDraft): Parameters<typeof genitCreateForm>[0] {
  const bad = (what: string): never => {
    throw new Error('BAD_DRAFT ' + what)
  }
  const o = draft.options ?? {}
  if (!draft.title.trim()) bad('title')
  if (!draft.main.trim()) bad('main')
  const type = o.type === undefined ? 'simulation' : o.type
  if (typeof type !== 'string' || !GENIT_TYPES.includes(type))
    bad('options.type simulation/character')
  const gender = o.gender === undefined ? 'male' : o.gender
  if (typeof gender !== 'string' || !/^[a-z_]{1,20}$/.test(gender)) bad('options.gender')
  if (draft.coverUrl)
    bad(
      'cover_file (젠잇은 비공개 작품에 대표 이미지가 없어도 되고, 만든 뒤 images_plan으로 올린다)'
    )

  const starts = draft.startScenarios ?? []
  if (!starts.length) bad('start_scenarios 1개 이상')
  const greetings = starts.map((s, i) => {
    const g = startFresh(s)
    if (!text(g.title).trim() || !text(g.content).trim())
      bad('start_scenarios[' + i + '] title·content')
    // 편집기의 새 작품 저장(hS) 모양
    return {
      title: g.title,
      content: g.content,
      background: g.background,
      volatility_background: '',
      sample_questions: [],
      description: g.description,
      cover_image: '',
      is_active: true,
      display_order: i
    }
  })
  const lorebooks = (draft.lorebook ?? []).map((entry, i) => {
    const l = loreFresh(entry)
    if (!text(l.title).trim() || !text(l.description).trim())
      bad('lorebook[' + i + '] title·content')
    return {
      title: l.title,
      description: l.description,
      display_description: '',
      keywords: l.keywords,
      is_active: true,
      is_hidden: true,
      is_pinned: true,
      category: l.category,
      recall_cue: '',
      status: ''
    }
  })
  const cast = draft.characters.map((c, i) => ({ ...castFresh(c), display_order: i }))
  return {
    name: draft.title,
    description: draft.description ?? '',
    shortIntro: draft.subtitle ?? '',
    prompt: draft.main,
    greetings,
    lorebooks,
    cast,
    type: type as string,
    gender: gender as string,
    adult: draft.adult
  }
}
