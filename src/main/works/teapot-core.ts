// 티팟 연결부가 같이 쓰는 주소·모양·호출 함수 (teapot.ts가 쓴다).
// 근거: 2026-11-10 teapotchat.com 공개 스크립트(로그인 없이 받은 Next 묶음, 실제 호출 전).
//   Firebase 프로젝트 chat-ai-7a275, 함수 지역 asia-northeast3 (2278 묶음: getFunctions(app,"asia-northeast3")).
//   편집기 저장 파일(체크포인트)은 모두 호출형 함수(httpsCallable)로 읽고 쓴다 (9184 묶음 48249 모듈):
//     listCheckpoints {characterId, summaryOnly:true} → {success, summary_only, checkpoints[]}
//     getCheckpoint   {characterId, checkpointId}     → {checkpoint:{…, snapshot}}
//     createCheckpoint {characterId, name, snapshot}  → {checkpoint:{id}}
//     updateCheckpoint {characterId, cpId, snapshot}
//     createDraft {} → {draftId},  deleteNewCharacter {characterId}
//   호출형 함수 규약(함수 SDK): POST https://{지역}-{프로젝트}.cloudfunctions.net/{이름}
//     본문 {"data":…}, 응답 {"result":…} (옛 모양 {"data":…}), 실패 {"error":{status, message}}.
//   내 작품 목록은 Firestore REST runQuery (9184 묶음 47431 runProjectedQuery, 함수 I = fetchCreatorHomeCharacterList):
//     POST …/documents/users/{uid}:runQuery  {structuredQuery:{select, from:[{collectionId}], where is_deleted==false,
//     orderBy time_created DESC}}  collectionId = OC_draft / OC_buffer / OC (여기서는 앞의 둘만)
import type { FileRules, WorkFetch, WorkWrite } from './types'

export const PROJECT = 'chat-ai-7a275'
export const FUNCTIONS = 'https://asia-northeast3-' + PROJECT + '.cloudfunctions.net/'
export const FIRESTORE = 'https://firestore.googleapis.com'
const DOCUMENTS = FIRESTORE + '/v1/projects/' + PROJECT + '/databases/(default)/documents/'
const JSON_TYPE = 'application/json'

// 읽기 함수와 쓰기 함수. 이 밖의 함수(submitCharacter 등록·심사, cloneNewCharacter, autoSaveCheckpoint,
// deleteCheckpoint, renameCheckpoint)는 부르지 않는다.
export const READ_FUNCTIONS = ['listCheckpoints', 'getCheckpoint'] as const
export const WRITE_FUNCTIONS = [
  'createCheckpoint',
  'updateCheckpoint',
  'createDraft',
  'deleteNewCharacter'
] as const
export type ReadFunction = (typeof READ_FUNCTIONS)[number]
export type WriteFunction = (typeof WRITE_FUNCTIONS)[number]

// 작품 번호(draftId·characterId)와 저장 파일 번호. 사이트 코드에 생성 규칙이 없어 Firestore 문서 번호 모양으로 넓게 받는다.
export const ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const UID_RE = /^[A-Za-z0-9_-]{1,128}$/

// 편집기 업로드 규칙 (86701 모듈 C2 = 5,242,880바이트). 이미지 올리기는 막혀 있다 (teapot.ts 머리말).
export const TEAPOT_IMAGE_RULES: FileRules = {
  extensions: ['webp', 'png', 'jpg', 'jpeg'],
  maxBytes: 5_242_880
}

export type Obj = Record<string, unknown>
export const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
export const list = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter(isObj) : [])
export const text = (v: unknown): string => (typeof v === 'string' ? v : '')
export const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)
export const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []

export function teapotWorkId(id: string): string {
  if (!ID_RE.test(id)) throw new Error('BAD_WORK_ID')
  return id
}
export function at(index: unknown, length: number): number {
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= length)
    throw new Error('BAD_INDEX')
  return index
}

/** 로그인한 계정 (Firebase ID 토큰의 sub). 목록은 계정 번호가 주소에 들어가 이것 없이는 못 읽는다 */
export interface TeapotAccount {
  uid: string
}
export function accountUid(account: TeapotAccount | undefined): string {
  const uid = account?.uid
  if (typeof uid !== 'string' || !UID_RE.test(uid)) throw new Error('TEAPOT_UID_REQUIRED')
  return uid
}

// ── 호출형 함수 ──

/** 읽기 함수 요청 본문. 이 모양 그대로만 허용한다 (readPostAllowed) */
export function readBody(name: ReadFunction, characterId: string, checkpointId?: string): string {
  return JSON.stringify({
    data:
      name === 'listCheckpoints'
        ? { characterId, summaryOnly: true }
        : { characterId, checkpointId }
  })
}
export function readBodyAllowed(url: string, body: string): boolean {
  const name = url.startsWith(FUNCTIONS) ? url.slice(FUNCTIONS.length) : ''
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return false
  }
  if (!isObj(parsed) || Object.keys(parsed).length !== 1 || !isObj(parsed.data)) return false
  const d = parsed.data
  const id = text(d.characterId)
  if (!ID_RE.test(id)) return false
  if (name === 'listCheckpoints') return body === readBody('listCheckpoints', id)
  if (name === 'getCheckpoint') {
    const cp = text(d.checkpointId)
    return ID_RE.test(cp) && body === readBody('getCheckpoint', id, cp)
  }
  return false
}

/** 호출형 함수 응답 → result. 실패는 짧은 오류 이름으로 바꾼다 (본문 내용은 붙이지 않는다) */
export async function callResult(res: Response, failure: string): Promise<unknown> {
  const body: unknown = await res.json().catch(() => null)
  if (!res.ok) {
    const status = isObj(body) && isObj(body.error) ? text(body.error.status) : ''
    if (res.status === 401 || status === 'UNAUTHENTICATED') throw new Error('LOGIN_REQUIRED')
    if (res.status === 403 || status === 'PERMISSION_DENIED') throw new Error('LOGIN_REQUIRED')
    if (res.status === 404 || status === 'NOT_FOUND') throw new Error('WORK_NOT_FOUND')
    throw new Error(failure + ' ' + res.status + (status ? ' ' + status : ''))
  }
  if (!isObj(body)) throw new Error(failure + ' SHAPE')
  // 함수 SDK와 같이 data가 없으면 result를 본다
  return body.data !== undefined ? body.data : body.result
}

export async function callRead(
  read: WorkFetch,
  name: ReadFunction,
  characterId: string,
  checkpointId?: string
): Promise<unknown> {
  const res = await read(FUNCTIONS + name, {
    method: 'POST',
    contentType: JSON_TYPE,
    body: readBody(name, characterId, checkpointId)
  })
  return callResult(res, 'WORK_READ_FAILED')
}

export async function callWrite(
  write: WorkWrite,
  name: WriteFunction,
  data: Obj
): Promise<unknown> {
  const res = await write('POST', FUNCTIONS + name, { data })
  return callResult(res, 'SAVE_FAILED ' + name)
}

// ── Firestore REST (내 작품 목록) ──

// 사이트는 공개 문서 OC에서 통계·공개일도 읽지만 목록 칸에는 필요 없어 초안·버퍼만 읽는다
export const LIST_COLLECTIONS = ['OC_draft', 'OC_buffer'] as const
export type ListCollection = (typeof LIST_COLLECTIONS)[number]
// 사이트가 고른 칸 그대로 (9184 묶음 E 목록: 초안·버퍼)
const DRAFT_FIELDS = [
  'char_name',
  'oneline_description',
  'image',
  'is_nsfw',
  'conv_type',
  'model',
  'prompt_char_count',
  'creator_uid',
  'creator_handle',
  'creator_name',
  'creator_image',
  'creator_profile',
  'creator_contract_status',
  'creator_contract_type',
  'contract_status',
  'contract_type',
  'genre',
  'hash_tags',
  'target',
  'publicity',
  'is_deleted',
  'worldview_id',
  'worldview_name',
  'worldview_image',
  'messages_last_1d',
  'messages_last_7d',
  'messages_last_14d',
  'messages_last_28d',
  'random_seed',
  'time_created',
  'time_updated',
  'time_published',
  'status',
  'active_checkpoint_id',
  'published_checkpoint_id'
]

export const listUrl = (uid: string): string => DOCUMENTS + 'users/' + uid + ':runQuery'
/** 목록 요청 본문 (runProjectedQuery가 만드는 모양과 같은 순서) */
export function listQuery(collection: ListCollection): string {
  return JSON.stringify({
    structuredQuery: {
      select: {
        fields: DRAFT_FIELDS.map((fieldPath) => ({ fieldPath }))
      },
      from: [{ collectionId: collection }],
      where: {
        fieldFilter: {
          field: { fieldPath: 'is_deleted' },
          op: 'EQUAL',
          value: { booleanValue: false }
        }
      },
      orderBy: [{ field: { fieldPath: 'time_created' }, direction: 'DESCENDING' }]
    }
  })
}
const LIST_URL_RE = new RegExp(
  '^' +
    (DOCUMENTS + 'users/').replace(/[.*+?^${}()|[\]\\/]/g, '\\$&') +
    '([A-Za-z0-9_-]{1,128}):runQuery$'
)
/** 내 작품 목록 조회인지: 주소의 계정 문서 아래 세 모음만, 사이트와 같은 본문 모양만 */
export function listReadAllowed(url: string, body: string): boolean {
  if (!LIST_URL_RE.test(url)) return false
  try {
    const u = new URL(url)
    if (u.origin !== FIRESTORE || u.search || u.hash || u.username || u.password) return false
  } catch {
    return false
  }
  return LIST_COLLECTIONS.some((c) => body === listQuery(c))
}

/** Firestore REST 값 하나를 JS 값으로 */
export function fsValue(v: unknown): unknown {
  if (!isObj(v)) return null
  if ('nullValue' in v) return null
  if ('booleanValue' in v) return v.booleanValue === true
  if ('integerValue' in v) return Number(v.integerValue)
  if ('doubleValue' in v) return v.doubleValue
  if ('timestampValue' in v) return text(v.timestampValue)
  if ('stringValue' in v) return text(v.stringValue)
  if ('arrayValue' in v)
    return (
      isObj(v.arrayValue) && Array.isArray(v.arrayValue.values) ? v.arrayValue.values : []
    ).map(fsValue)
  if ('mapValue' in v) return fsFields(isObj(v.mapValue) ? v.mapValue.fields : null)
  return null
}
export function fsFields(fields: unknown): Obj {
  return isObj(fields)
    ? Object.fromEntries(Object.entries(fields).map(([k, x]) => [k, fsValue(x)]))
    : {}
}
/** runQuery 응답 → [{id, data}] (문서 없는 줄은 건너뛴다) */
export async function runQueryDocs(res: Response): Promise<{ id: string; data: Obj }[]> {
  if (res.status === 401 || res.status === 403) throw new Error('LOGIN_REQUIRED')
  if (!res.ok) throw new Error('WORK_READ_FAILED ' + res.status)
  const body: unknown = await res.json().catch(() => null)
  if (!Array.isArray(body)) throw new Error('WORK_LIST_SHAPE')
  return list(body).flatMap((row) => {
    const doc = isObj(row.document) ? row.document : null
    const name = doc ? text(doc.name) : ''
    const id = name.slice(name.lastIndexOf('/') + 1)
    return doc && ID_RE.test(id) ? [{ id, data: fsFields(doc.fields) }] : []
  })
}

// ── 시각 ──

/** 함수 응답의 시각(문자열, {_seconds,_nanoseconds}, {seconds,nanoseconds}) → ISO 문자열 (19758 모듈과 같은 해석) */
export function isoTime(v: unknown): string | null {
  if (typeof v === 'string') return v || null
  if (isObj(v)) {
    const s = typeof v._seconds === 'number' ? v._seconds : v.seconds
    const n = typeof v._nanoseconds === 'number' ? v._nanoseconds : v.nanoseconds
    if (typeof s === 'number' && Number.isFinite(s))
      return new Date(s * 1000 + (typeof n === 'number' ? n : 0) / 1e6).toISOString()
  }
  return null
}
export const timeOf = (v: unknown): number => {
  const iso = isoTime(v)
  const t = iso ? Date.parse(iso) : NaN
  return Number.isFinite(t) ? t : 0
}

/** 저장 파일 상태 (19758 모듈): ACCEPTED 등록완료 / PENDING 심사중 / REJECTED 반려 / AUTO_SAVED 자동저장 / 없음 */
export function cpStatus(v: unknown): string | null {
  const s = typeof v === 'string' ? v : ''
  if (s === 'ACCEPTED' || s === '등록완료') return 'ACCEPTED'
  if (s === 'PENDING' || s === '심사중') return 'PENDING'
  if (s === 'REJECTED' || s === '반려됨') return 'REJECTED'
  if (s === 'AUTO_SAVED' || s === '자동저장') return 'AUTO_SAVED'
  return null
}
/** 자동 저장 파일인지 (편집기: 이름 "자동 저장" 또는 AUTO_SAVED) */
export const isAuto = (cp: Obj): boolean =>
  cp.name === '자동 저장' || cpStatus(cp.cp_status) === 'AUTO_SAVED'

/** 공개도 (편집기 ex·f 표): "0" 비공개 / "1" 공개 / "3" 링크 공개 / "2" 시리즈 */
export function teapotVisibility(v: unknown): string {
  const p = typeof v === 'string' ? v : '0'
  return p === '1' ? 'public' : p === '3' ? 'link' : p === '2' ? 'series' : 'private'
}
