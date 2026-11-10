// 엘린 연결부가 같이 쓰는 주소·모양·저장 함수 (elyn.ts와 elyn-media.ts가 함께 쓴다).
// 근거: 2026-11-10 엘린 편집기 공개 스크립트(characterToFormSchema / normalizeLorebookForForm /
// normalizeDraftForm / buildCharacterFormData / buildJsonData, charactersApi.saveCharacterDraft·submitCharacterRevision).
import type { FileRules, LocalImage, WorkFetch, WorkSend, WorkWrite } from './types'

export const ELYN_ORIGIN = 'https://api.elyn.ai'
export const ELYN_BASE = ELYN_ORIGIN + '/api/v1/characters/'
export const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
export const UUID_RE = new RegExp('^' + UUID + '$', 'i')
// 판(revision) 번호 모양은 코드에 없다. uuid 또는 정수만 받는다.
export const REV = '(?:' + UUID + '|[0-9]{1,18})'
export const REV_RE = new RegExp('^' + REV + '$', 'i')
/** 작품 주소 경로의 앞부분 (정규식 조각) */
export const C_PATH = '^/api/v1/characters/'

// 편집기가 받는 이미지 (IMAGE_UPLOAD_ACCEPT: webp·jpg·jpeg·png). 한 번에 올리는 묶음은
// 10개·20MiB까지다 (IMAGE_UPLOAD_CHUNK_MAX_FILES / _BYTES). 파일 하나의 서버 한도는 코드에 없다.
export const ELYN_IMAGE_RULES: FileRules = {
  extensions: ['webp', 'jpg', 'jpeg', 'png'],
  maxBytes: 20 * 1024 * 1024
}
export const ELYN_BATCH_FILES = 10
export const ELYN_BATCH_BYTES = 20 * 1024 * 1024

export type Obj = Record<string, unknown>
export const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
export const list = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter(isObj) : [])
export const text = (v: unknown): string => (typeof v === 'string' ? v : '')
export const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)
export const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []
export const bytes = (s: string): number => new TextEncoder().encode(s).length

export async function elynJson(res: Response): Promise<unknown> {
  if (res.status === 401 || res.status === 403) throw new Error('LOGIN_REQUIRED')
  if (res.status === 404) throw new Error('WORK_NOT_FOUND')
  if (!res.ok) throw new Error('WORK_READ_FAILED ' + res.status)
  return res.json()
}
export function elynWorkId(id: string): string {
  if (!UUID_RE.test(id)) throw new Error('BAD_WORK_ID')
  return id.toLowerCase()
}
/** 엘린 API 주소이고 경로가 맞는지. query를 주면 쿼리도 그 검사로 본다 (주지 않으면 쿼리가 없어야 한다) */
export function elynPlain(
  url: string,
  paths: RegExp[],
  query?: (q: URLSearchParams) => boolean
): boolean {
  try {
    const u = new URL(url)
    return (
      u.origin === ELYN_ORIGIN &&
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
export function at(index: unknown, length: number): number {
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= length)
    throw new Error('BAD_INDEX')
  return index
}

// ── 편집기 폼 모양 ──

export const loreForForm = (lorebook: unknown): Obj => ({
  lores: list(isObj(lorebook) ? lorebook.lores : null).map((e) => ({
    name: text(e.name),
    content: text(e.content),
    trigger_strings: strings(e.trigger_strings),
    scan_first_message: e.scan_first_message === true,
    condition: e.condition === 'until_match' ? 'until_match' : 'on_match',
    scan_turns: typeof e.scan_turns === 'number' ? e.scan_turns : 3,
    group: strOrNull(e.group),
    group_priority: typeof e.group_priority === 'number' ? e.group_priority : 0,
    requires: strings(e.requires)
  }))
})
export const tagText = (v: unknown): string => (Array.isArray(v) ? strings(v).join(',') : text(v))
const imageForForm = (e: Obj): Obj => ({
  id: strOrNull(e.id),
  image_url: text(e.image_url),
  slug: text(e.slug),
  description: text(e.description),
  visibility: strOrNull(e.visibility) ?? 'partial'
})

/** 작품 원본 → 편집기 폼 (characterToFormSchema. 판이 하나도 없는 작품) */
export function elynCharacterForm(c: Obj): Obj {
  const messages = strings(list(c.firstMessage)[0]?.messages)
  return {
    name: text(c.name),
    imageUrl: text(c.imageUrl),
    creatorNotes: text(list(c.creatorNotes)[0]?.content),
    tags: tagText(c.tags),
    visibility: text(c.visibility) || 'private',
    target: text(c.target) || 'all',
    isNsfw: c.is_nsfw === true,
    isExclusive: c.isExclusive === true,
    exclusiveLockedUntil: strOrNull(c.exclusiveLockedUntil),
    subImages: list(isObj(c.assetData) ? c.assetData.images : null).map(imageForForm),
    isPaug: c.isPaug === true,
    description: text(c.description),
    favoredModelId: strOrNull(c.favoredModelId) ?? 'none',
    firstMessages: (messages.length ? messages : ['']).map((message) => ({ message })),
    lorebook: loreForForm(c.lorebook),
    customScript: list(isObj(c.customScript) ? c.customScript.components : null)
  }
}

/** 판의 form → 편집기 폼 (normalizeDraftForm + customScriptComponentsFromDraftForm) */
export function elynDraftForm(f: Obj): Obj {
  const form: Obj = { ...f }
  delete form.mainImage
  delete form.customScriptData
  return {
    ...form,
    imageUrl: text(f.imageUrl),
    tags: tagText(f.tags),
    subImages: list(f.subImages).map(imageForForm),
    firstMessages: list(f.firstMessages).map((m) => ({ message: text(m.message) })),
    lorebook: loreForForm(f.lorebook),
    customScript: list(isObj(f.customScriptData) ? f.customScriptData.components : f.customScript)
  }
}

/** 편집기 폼 → 저장 본문의 data (buildJsonData). edit이면 갤러리 이미지 번호를 같이 보낸다 */
export function elynJsonData(form: Obj, language: string, mode: 'edit' | 'create'): Obj {
  const scripts = list(form.customScript)
  const favored = text(form.favoredModelId)
  return {
    name: text(form.name),
    description: text(form.description),
    visibility: text(form.visibility),
    isNsfw: form.isNsfw === true,
    isPaug: form.isPaug === true,
    isExclusive: form.isExclusive === true,
    target: text(form.target) || 'all',
    tags: tagText(form.tags)
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean),
    firstMessages: [
      {
        locale: language,
        messages: list(form.firstMessages)
          .map((m) => text(m.message))
          .filter(Boolean)
      }
    ],
    creatorNotes: [{ locale: language, content: text(form.creatorNotes) }],
    nickname: null,
    assetData: {
      images: list(form.subImages).map((e) => ({
        ...(mode === 'edit' ? { id: strOrNull(e.id) } : {}),
        slug: text(e.slug),
        description: text(e.description),
        visibility: text(e.visibility) || 'partial'
      }))
    },
    lorebook: isObj(form.lorebook) ? form.lorebook : { lores: [] },
    favoredModelId: !favored || favored === 'none' ? null : favored,
    customScript: scripts.length
      ? { version: 1, entryComponent: text(scripts[0].name), components: scripts }
      : null
  }
}

/** 읽어 둔 원본: 작품, 판 상태, 연 판, 그 판의 편집기 폼 */
export interface ElynRaw {
  id: string
  character: Obj
  status: Obj
  revision: Obj | null
  form: Obj
}
export function elynRaw(raw: unknown): ElynRaw {
  if (
    !isObj(raw) ||
    !strOrNull(raw.id) ||
    !isObj(raw.character) ||
    !isObj(raw.status) ||
    !isObj(raw.form)
  )
    throw new Error('WORK_SHAPE')
  return raw as unknown as ElynRaw
}
/**
 * 작품 원본을 편집기처럼 읽는다: 작품 → 판 상태 → (있으면) 가장 최근 판의 폼.
 * 가장 최근 판은 아직 반영되지 않은 임시 판이거나 검수 중인 판일 수 있다.
 */
export async function elynReadRaw(read: WorkFetch, id: string): Promise<ElynRaw> {
  const wid = elynWorkId(id)
  const got = await elynJson(await read(ELYN_BASE + wid + '?minimal=false'))
  const character = list(isObj(got) ? got.characters : null)[0]
  if (!character) throw new Error('WORK_NOT_FOUND')
  if (character.is_my_character === false) throw new Error('NOT_MY_WORK')
  const status = await elynJson(await read(ELYN_BASE + wid + '/revisions/status'))
  if (!isObj(status)) throw new Error('WORK_SHAPE')
  const latest = isObj(status.latest_revision) ? status.latest_revision : null
  const rid = latest ? String(latest.id ?? '') : ''
  if (latest && REV_RE.test(rid)) {
    const rev = await elynJson(await read(ELYN_BASE + wid + '/revisions/' + rid))
    if (!isObj(rev) || !isObj(rev.form)) throw new Error('WORK_SHAPE')
    return {
      id: wid,
      character,
      status,
      revision: isObj(rev.revision) ? rev.revision : latest,
      form: elynDraftForm(rev.form)
    }
  }
  return { id: wid, character, status, revision: null, form: elynCharacterForm(character) }
}
/** 편집기는 화면 언어로 저장한다. 여기서는 작품에 적힌 첫 언어를 따른다 */
export function elynLanguage(raw: ElynRaw): string {
  return (
    strOrNull(list(raw.character.creatorNotes)[0]?.locale) ??
    strOrNull(list(raw.character.firstMessage)[0]?.locale) ??
    'ko'
  )
}

export function checkImageFile(file: LocalImage): void {
  const ext = (file.name.split('.').pop() || '').toLowerCase()
  if (!ELYN_IMAGE_RULES.extensions.includes(ext)) throw new Error('BAD_IMAGE')
  if (file.data.byteLength > ELYN_IMAGE_RULES.maxBytes) throw new Error('IMAGE_TOO_LARGE')
}

const errorText = (reply: unknown): string =>
  isObj(reply)
    ? (text(reply.message) || text(reply.errorCode) || text(reply.detail)).slice(0, 60)
    : ''

/**
 * 판을 저장하고(새 파일 포함) 바로 제출한다. 편집기 저장 버튼과 같은 두 요청이다.
 *   1) POST {id}/draft  파일 묶음: files…(대표 이미지가 있으면 맨 앞, 그다음 새 갤러리 이미지), data
 *   2) POST {id}/revisions/{rid}/submit  {visibility, isExclusive}
 * 비공개·일부 공개는 바로 반영되고, 공개 작품은 검수 요청이 된다 (편집기 안내 문구 기준).
 */
export async function elynCommit(
  io: { write: WorkWrite; send: WorkSend },
  wid: string,
  next: ElynRaw,
  files: LocalImage[]
): Promise<void> {
  // 편집기는 검수 중인 판이 있으면 "검수 요청을 바꿀지" 따로 묻는다. 여기서는 바꾸지 않는다.
  if (isObj(next.status.in_review)) throw new Error('IN_REVIEW')
  const form = next.form
  const res = await io.send({
    method: 'POST',
    url: ELYN_BASE + wid + '/draft',
    form: [
      ...files.map((file) => ({ name: 'files', file })),
      { name: 'data', value: JSON.stringify(elynJsonData(form, elynLanguage(next), 'edit')) }
    ]
  })
  if (res.status === 401 || res.status === 403) throw new Error('LOGIN_REQUIRED')
  if (res.status === 413) throw new Error('IMAGE_TOO_LARGE')
  const saved: unknown = await res.json().catch(() => null)
  if (!res.ok) throw new Error('SAVE_FAILED ' + res.status + ' ' + errorText(saved))
  const rid = isObj(saved) && isObj(saved.revision) ? String(saved.revision.id ?? '') : ''
  if (!REV_RE.test(rid)) throw new Error('SAVE_FAILED revision')

  const submit = await io.write('POST', ELYN_BASE + wid + '/revisions/' + rid + '/submit', {
    visibility: text(form.visibility) || 'public',
    isExclusive: form.isExclusive === true
  })
  if (submit.status === 401 || submit.status === 403) throw new Error('LOGIN_REQUIRED')
  if (submit.status === 429) throw new Error('PUBLISH_RATE_LIMITED')
  if (!submit.ok)
    throw new Error(
      'SUBMIT_FAILED ' + submit.status + ' ' + errorText(await submit.json().catch(() => null))
    )
}
