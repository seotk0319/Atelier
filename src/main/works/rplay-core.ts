// 알플레이(rplay.live) 스토리챗 연결부가 같이 쓰는 주소·모양·요청 함수.
// 근거: 2026-11-10 rplay.live 공개 스크립트 (실제 호출 전).
//   API 묶음(js/DNLa6r8FjI.js): C = "https://chat-api.rplay.live" + "/story-chat", 계정 쪽은 "https://api.rplay.live"
//   요청 가로채기: GET은 쿼리에, POST는 본문에 platformType·lang·requestorOid·loginType을 붙인다.
//   axios 0.x 쿼리 규칙: 배열은 key[]=값 반복, 객체는 JSON 글, null·undefined 값은 빠진다.
// storyengine.live 빌드는 API가 https://api.storyengine.live 로 다르다(로그인도 따로). 여기서는 rplay.live만 쓴다.
import type { WorkFetch } from './types'

export const RPLAY_API = 'https://api.rplay.live'
export const RPLAY_CHAT_ORIGIN = 'https://chat-api.rplay.live'
export const RPLAY_CHAT = RPLAY_CHAT_ORIGIN + '/story-chat'

export const HEX = '[a-f0-9]{24}'
export const HEX_RE = new RegExp('^' + HEX + '$')
const LOGIN_TYPE_RE = /^[a-z][a-z0-9-]{0,20}$/

export type Obj = Record<string, unknown>
export const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
export const list = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter(isObj) : [])
export const text = (v: unknown): string => (typeof v === 'string' ? v : '')
export const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)
export const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []
/** 몽고 ObjectId는 문자열이거나 {$oid}로 올 수 있다 */
export const oidOf = (v: unknown): string => {
  const s = typeof v === 'string' ? v : isObj(v) ? text(v.$oid) : ''
  return HEX_RE.test(s) ? s : ''
}

export function rplayWorkId(id: string): string {
  if (!HEX_RE.test(id)) throw new Error('BAD_WORK_ID')
  return id
}
export function at(index: unknown, length: number): number {
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= length)
    throw new Error('BAD_INDEX')
  return index
}

// ───────────── 로그인 계정 ─────────────

/**
 * 알플레이는 모든 요청에 로그인 계정 번호(requestorOid)와 로그인 종류(loginType)를 붙인다.
 * 그 값은 사이트가 로그인 응답에서 받아 브라우저 저장소에 두는 값이라, 계정 번호 없이 "나"를 돌려주는
 * 주소는 사이트 코드에서 찾지 못했다. 그래서 통로 함수(read/write/send)에 붙은 rplayAccount로 받는다
 * (붙이는 쪽은 공용 코드: 알림 연결이 저장한 /account/getuser 주소의 requestorOid·loginType).
 */
export interface RplayAccount {
  oid: string
  loginType: string
}
type AccountSource = { rplayAccount?: () => Promise<RplayAccount | null> | RplayAccount | null }

export async function rplayAccount(...sources: unknown[]): Promise<RplayAccount | null> {
  for (const s of sources) {
    const get = (s as AccountSource | null | undefined)?.rplayAccount
    if (typeof get !== 'function') continue
    const a = await get()
    if (a && HEX_RE.test(a.oid) && LOGIN_TYPE_RE.test(a.loginType)) return a
  }
  return null
}
export async function needAccount(...sources: unknown[]): Promise<RplayAccount> {
  const a = await rplayAccount(...sources)
  if (!a) throw new Error('RPLAY_ACCOUNT_REQUIRED')
  return a
}

/** 사이트 요청 가로채기가 붙이는 값 (gaClientId 등 비어 있는 값은 빠진다) */
export const accountParams = (a: RplayAccount | null): [string, string][] => [
  ['platformType', 'rplay'],
  ['lang', 'ko'],
  ...(a
    ? ([
        ['requestorOid', a.oid],
        ['loginType', a.loginType]
      ] as [string, string][])
    : [])
]
export const accountBody = (a: RplayAccount): Obj => ({
  platformType: 'rplay',
  lang: 'ko',
  requestorOid: a.oid,
  loginType: a.loginType
})

// axios 0.x buildURL의 encode와 같은 모양
const enc = (s: string): string =>
  encodeURIComponent(s)
    .replace(/%3A/gi, ':')
    .replace(/%24/g, '$')
    .replace(/%2C/gi, ',')
    .replace(/%20/g, '+')
    .replace(/%5B/gi, '[')
    .replace(/%5D/gi, ']')
export const withQuery = (base: string, params: [string, string][]): string =>
  base + '?' + params.map(([k, v]) => enc(k) + '=' + enc(v)).join('&')

// ───────────── 허용 주소 ─────────────

type Check = (v: string) => boolean
interface Route {
  origin: string
  path: RegExp
  /** 반드시 있어야 하는 쿼리 (값 하나) */
  required: Record<string, Check>
  /** 있어도 되는 쿼리 (값 하나) */
  optional?: Record<string, Check>
  /** 같은 이름이 여러 번 오는 쿼리: 정확히 이 값들이 이 순서로 */
  repeated?: Record<string, string[]>
}
const hex: Check = (v) => HEX_RE.test(v)
const ACCOUNT_REQUIRED: Record<string, Check> = {
  platformType: (v) => v === 'rplay',
  lang: (v) => v === 'ko'
}
const ACCOUNT_OPTIONAL: Record<string, Check> = {
  requestorOid: hex,
  loginType: (v) => LOGIN_TYPE_RE.test(v)
}

export function routeAllowed(url: string, routes: Route[]): boolean {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false
  }
  if (u.username || u.password || u.hash) return false
  return routes.some((r) => {
    if (u.origin !== r.origin || !r.path.test(u.pathname)) return false
    const seen = new Map<string, string[]>()
    for (const [k, v] of u.searchParams) seen.set(k, [...(seen.get(k) ?? []), v])
    for (const [k, values] of seen) {
      const fixed = r.repeated?.[k]
      if (fixed) {
        if (values.length !== fixed.length || values.some((v, i) => v !== fixed[i])) return false
        continue
      }
      const check = r.required[k] ?? r.optional?.[k]
      if (!check || values.length !== 1 || !check(values[0])) return false
    }
    // requestorOid와 loginType은 함께만 온다
    if (seen.has('requestorOid') !== seen.has('loginType')) return false
    return (
      Object.keys(r.required).every((k) => seen.has(k)) &&
      Object.keys(r.repeated ?? {}).every((k) => seen.has(k))
    )
  })
}

/** chat-content의 options: 편집기가 쓰는 두 값만 */
const contentOptions: Check = (v) => {
  try {
    const o: unknown = JSON.parse(v)
    return (
      isObj(o) &&
      Object.keys(o).length > 0 &&
      Object.entries(o).every(
        ([k, b]) => (k === 'withIsCompiling' || k === 'preferMainCanvas') && b === true
      )
    )
  } catch {
    return false
  }
}

export const LIST_FILTER = ['work_in_progress_storyChat', 'publishedStoryChat']

export const READ_ROUTES: Route[] = [
  // 스튜디오 목록 (getUserContentList → getUserInfo(userOid, filter))
  {
    origin: RPLAY_API,
    path: /^\/account\/getuser$/,
    required: { userOid: hex, ...ACCOUNT_REQUIRED },
    optional: ACCOUNT_OPTIONAL,
    repeated: { 'filter[]': LIST_FILTER }
  },
  // 작품 정보 (getStoryChat)
  {
    origin: RPLAY_CHAT_ORIGIN,
    path: /^\/story-chat\/chat-content$/,
    required: {
      contentOid: hex,
      options: contentOptions,
      omitComments: (v) => v === 'true',
      ...ACCOUNT_REQUIRED
    },
    optional: ACCOUNT_OPTIONAL
  },
  // 캔버스 (getChatCompositionCanvas)
  {
    origin: RPLAY_CHAT_ORIGIN,
    path: /^\/story-chat\/chat-canvas$/,
    required: { canvasOid: hex, includeMetadata: (v) => v === 'true', ...ACCOUNT_REQUIRED },
    optional: ACCOUNT_OPTIONAL
  },
  // 제목·소개 언어별 상태 (getStoryChatLocalization)
  {
    origin: RPLAY_CHAT_ORIGIN,
    path: new RegExp('^/story-chat/localization/' + HEX + '$'),
    required: ACCOUNT_REQUIRED,
    optional: ACCOUNT_OPTIONAL
  },
  // 이미지 해시 목록 (getStoryChatImageHashes, 새 인물 노드 해시가 겹치지 않게)
  {
    origin: RPLAY_CHAT_ORIGIN,
    path: /^\/story-chat\/image-hashes$/,
    required: { contentOid: hex, ...ACCOUNT_REQUIRED },
    optional: ACCOUNT_OPTIONAL
  }
]

export const WRITE_PATHS = [
  /^\/story-chat\/chat-content$/,
  /^\/story-chat\/chat-canvas$/,
  /^\/story-chat\/chat-canvas\/metadata$/,
  new RegExp('^/story-chat/localization/' + HEX + '/edit$')
]

// ───────────── 응답 ─────────────

/** 서버 오류 글에서 코드처럼 생긴 부분만 남긴다 */
export async function failure(res: Response): Promise<string> {
  const body = await res.text().catch(() => '')
  let code = ''
  try {
    const j: unknown = JSON.parse(body)
    if (isObj(j)) code = text(j.error) || text(j.code)
  } catch {
    code = ''
  }
  return code.replace(/[^A-Za-z0-9_. -]/g, '').slice(0, 60)
}

/** 읽기 응답. 알플레이는 만료를 500 {"error":"jwt expired"}로도 알린다 */
export async function rplayJson(res: Response): Promise<unknown> {
  if (res.status === 401) throw new Error('LOGIN_REQUIRED')
  if (res.status === 404) throw new Error('WORK_NOT_FOUND')
  if (!res.ok) {
    const code = await failure(res)
    if (/jwt expired/i.test(code)) throw new Error('LOGIN_REQUIRED')
    if (res.status === 403) throw new Error('FORBIDDEN ' + code)
    throw new Error('WORK_READ_FAILED ' + res.status + ' ' + code)
  }
  return res.json()
}
/** 쓰기 응답 */
export async function rplayWritten(res: Response, what: string): Promise<Obj> {
  if (res.status === 401) throw new Error('LOGIN_REQUIRED')
  if (!res.ok) {
    const code = await failure(res)
    if (/jwt expired/i.test(code)) throw new Error('LOGIN_REQUIRED')
    if (res.status === 409) throw new Error(what + '_CONFLICT ' + code)
    throw new Error(what + '_FAILED ' + res.status + ' ' + code)
  }
  const body: unknown = await res.json().catch(() => null)
  return isObj(body) ? body : {}
}
/** 모양이 다를 때는 칸 이름만 남긴다 */
export const shapeError = (what: string, v: unknown): Error =>
  new Error(what + ' ' + (isObj(v) ? Object.keys(v).slice(0, 10).join(',') : typeof v))

// ───────────── 원본 ─────────────

/** 읽어 둔 작품 원본 */
export interface RplayRaw {
  id: string
  /** GET /story-chat/chat-content (작품 정보) */
  content: Obj
  /** GET /story-chat/localization/{id} 의 storyChat (제목·소개·언어 상태) */
  localization: Obj | null
  canvasOid: string
  /** GET /story-chat/chat-canvas 의 canvas (nodes·connections …) */
  canvas: Obj
  /** 같은 응답의 metadataSet (키 = 노드의 metadataOid) */
  metadataSet: Record<string, Obj>
  /** applyChanges가 남기는 바꾸기 전 모습 (저장할 때 무엇이 달라졌는지 견준다) */
  base?: RplayBase
}
export interface RplayBase {
  info: Obj
  content: Obj
  nodes: Obj[]
  connections: Obj[]
  metadataSet: Record<string, Obj>
}
export function rplayRaw(raw: unknown): RplayRaw {
  if (
    !isObj(raw) ||
    !HEX_RE.test(text(raw.id)) ||
    !isObj(raw.content) ||
    !HEX_RE.test(text(raw.canvasOid)) ||
    !isObj(raw.canvas) ||
    !isObj(raw.metadataSet)
  )
    throw new Error('WORK_SHAPE')
  return raw as unknown as RplayRaw
}

/** 제목·소개를 읽는 곳: 언어 상태 응답이 있으면 그것, 없으면 작품 정보 */
export const infoOf = (r: RplayRaw): Obj => r.localization ?? r.content
export const nodesOf = (r: RplayRaw): Obj[] =>
  list(r.canvas.nodes).filter((n) => n.deleted !== true)
export const metaOf = (r: RplayRaw, node: Obj): Obj => r.metadataSet[text(node.metadataOid)] ?? {}

export const contentUrl = (id: string, a: RplayAccount | null): string =>
  withQuery(RPLAY_CHAT + '/chat-content', [
    ['contentOid', id],
    ['options', JSON.stringify({ withIsCompiling: true, preferMainCanvas: true })],
    ['omitComments', 'true'],
    ...accountParams(a)
  ])

/** 편집기가 여는 순서: 작품 정보 → 언어 상태 → 캔버스(노드 내용 포함) */
export async function rplayReadRaw(read: WorkFetch, id: string): Promise<RplayRaw> {
  const wid = rplayWorkId(id)
  const a = await rplayAccount(read)
  const content = await rplayJson(await read(contentUrl(wid, a)))
  if (!isObj(content)) throw shapeError('WORK_SHAPE', content)
  if (content.deleted === true) throw new Error('WORK_NOT_FOUND')
  const canvasOid = oidOf(content.canvasOid)
  if (!canvasOid) throw shapeError('WORK_SHAPE canvasOid', content)
  const loc = await rplayJson(
    await read(withQuery(RPLAY_CHAT + '/localization/' + wid, accountParams(a)))
  )
  const localization = isObj(loc) && isObj(loc.storyChat) ? loc.storyChat : null
  const got = await rplayJson(
    await read(
      withQuery(RPLAY_CHAT + '/chat-canvas', [
        ['canvasOid', canvasOid],
        ['includeMetadata', 'true'],
        ...accountParams(a)
      ])
    )
  )
  if (!isObj(got) || !isObj(got.canvas)) throw shapeError('WORK_SHAPE canvas', got)
  const metadataSet: Record<string, Obj> = {}
  for (const [k, v] of Object.entries(isObj(got.metadataSet) ? got.metadataSet : {}))
    if (isObj(v)) metadataSet[k] = v
  return { id: wid, content, localization, canvasOid, canvas: got.canvas, metadataSet }
}
