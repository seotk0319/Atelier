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
// 편집기의 공개 범위 선택지 (unlisted = 일부 공개)
export const VISIBILITIES = ['public', 'unlisted', 'private']

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
    // 값이 없으면 비워 둔다. 저장 때 elynCommit이 공개 범위를 확인하고 멈춘다 (임의로 private·public을 넣지 않는다)
    visibility: text(c.visibility),
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

const shortText = (v: unknown): string | null => {
  const s = strOrNull(v)
  return s && s.length <= 80 ? s : null
}
/** 짧은 글 목록(20개 이하, 각 80자 이하)은 그대로, 아니면 개수만 싣는다 */
function putList(out: Obj, key: string, countKey: string, items: string[]): void {
  if (items.length <= 20 && items.every((s) => s.length <= 80)) out[key] = items
  else out[countKey] = items.length
}
const putText = (out: Obj, key: string, v: unknown): void => {
  const s = shortText(v)
  if (s) out[key] = s
}
const putNumber = (out: Obj, key: string, v: unknown): void => {
  if (typeof v === 'number') out[key] = v
}

/**
 * 공통 칸에 들지 않는 설정 (work_read의 extras, 읽기 전용). 폼에 있는 칸만 싣고(판이 없는 작품은 편집기가 채우는
 * 기본값 false·all·none 포함), 긴 글·목록은 개수로 줄인다.
 * 좋아요·대화·댓글 수처럼 읽을 때마다 달라지는 값은 싣지 않는다 (계획 뒤 변화 검사가 깨진다).
 */
export function elynExtras(r: ElynRaw): Obj {
  const f = r.form
  const c = r.character
  const out: Obj = {}
  putList(
    out,
    'tags',
    'tag_count',
    tagText(f.tags)
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
  )
  if (typeof f.isNsfw === 'boolean') out.is_nsfw = f.isNsfw
  putText(out, 'target', f.target)
  if (typeof f.isPaug === 'boolean') out.is_paug = f.isPaug
  putText(out, 'favored_model_id', f.favoredModelId)
  if (isObj(c.favoredModel)) putText(out, 'favored_model_name', c.favoredModel.name)
  if (typeof f.isExclusive === 'boolean') out.is_exclusive = f.isExclusive
  putText(out, 'exclusive_locked_until', f.exclusiveLockedUntil)
  if (typeof c.isOfficialPartner === 'boolean') out.is_official_partner = c.isOfficialPartner
  out.has_cover = !!text(f.imageUrl)
  out.gallery_image_count = list(f.subImages).length
  out.custom_script_component_count = list(f.customScript).length
  if (isObj(c.statusData)) {
    for (const [from, to] of [
      ['global_status', 'status_data_global_count'],
      ['character_status', 'status_data_character_count'],
      ['user_status', 'status_data_user_count']
    ] as const)
      if (Array.isArray(c.statusData[from])) out[to] = (c.statusData[from] as unknown[]).length
  }

  // 로어북 항목별로는 못 읽는 칸(첫 메시지 스캔·그룹·선행 조건)은 개수로만 알린다
  const lores = list(isObj(f.lorebook) ? f.lorebook.lores : null)
  out.lorebook_scan_first_message_count = lores.filter((e) => e.scan_first_message === true).length
  out.lorebook_grouped_count = lores.filter((e) => strOrNull(e.group)).length
  out.lorebook_requires_count = lores.filter((e) => strings(e.requires).length > 0).length

  // 판·심사 상태 (저장·심사로만 바뀐다)
  const rev = r.revision
  if (rev) {
    const version = rev.version_number ?? rev.versionNumber
    if (typeof version === 'number') out.revision_version = version
    else putText(out, 'revision_version', version)
    putText(out, 'revision_status', rev.status)
    putText(out, 'revision_submitted_at', rev.submitted_at)
    putText(out, 'revision_reviewed_at', rev.reviewed_at)
  }
  out.has_draft_revision = isObj(r.status.draft)
  out.has_in_review_revision = isObj(r.status.in_review)
  out.has_rejected_revision = isObj(r.status.rejected)
  if (isObj(r.status.latest_approved))
    putNumber(out, 'latest_approved_version', r.status.latest_approved.version_number)
  putNumber(out, 'active_revision_version', r.status.active_revision_version)

  putText(out, 'created_at', c.createdAt)
  putText(out, 'public_at', c.publicAt)
  if (Array.isArray(c.creatorNotes))
    putList(
      out,
      'creator_notes_locales',
      'creator_notes_locale_count',
      list(c.creatorNotes).flatMap((e) => strOrNull(e.locale) ?? [])
    )
  if (Array.isArray(c.firstMessage))
    putList(
      out,
      'first_message_locales',
      'first_message_locale_count',
      list(c.firstMessage).flatMap((e) => strOrNull(e.locale) ?? [])
    )
  return out
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
  // 공개 범위를 모르면(비어 있으면) 판을 저장하기 전에 멈춘다. public·private로 채워 보내지 않는다.
  // 사이트가 준 값이면 우리가 모르는 값이어도 그대로 보낸다 (바꾸려는 값은 applyChanges가 세 값만 받는다).
  const visibility = text(form.visibility)
  if (!visibility) throw new Error('BAD_VISIBILITY')
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
    visibility,
    isExclusive: form.isExclusive === true
  })
  if (submit.status === 401 || submit.status === 403) throw new Error('LOGIN_REQUIRED')
  if (submit.status === 429) throw new Error('PUBLISH_RATE_LIMITED')
  if (!submit.ok)
    throw new Error(
      'SUBMIT_FAILED ' + submit.status + ' ' + errorText(await submit.json().catch(() => null))
    )
}
