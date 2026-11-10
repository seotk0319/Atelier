// 엘린 작품 본문 읽기·저장. 주소와 필드는 2026-11-10 엘린 편집기 공개 스크립트에서 읽었다 (실제 호출 전).
//   GET    /api/v1/characters/mine?page=&limit=50            내 작품 목록 {characters, total}
//   GET    /api/v1/characters/{id}?minimal=false             작품 원본 {characters:[…]}
//   GET    /api/v1/characters/{id}/revisions/status          {draft, in_review, latest_approved, rejected, latest_revision, …}
//   GET    /api/v1/characters/{id}/revisions/{rid}           {revision, form}  편집기는 가장 최근 판을 연다
//   POST   /api/v1/characters/{id}/draft                     판 저장 (파일 묶음, elyn-core.ts의 elynCommit)
//   POST   /api/v1/characters/{id}/revisions/{rid}/submit    제출 {visibility, isExclusive}
//   POST   /api/v1/characters/create/simple                  새 작품 (파일 묶음: files=대표 이미지, data)
//   DELETE /api/v1/characters/{id}                           작품 삭제
// 판 저장이 파일 묶음(multipart)이라 저장·새 작품에는 send 통로가 있어야 한다.
// 캐릭터는 작품 하나에 하나라 characters는 비어 있다. 첫 메시지(firstMessages)가 시작 상황이다.
import { randomUUID } from 'node:crypto'
import {
  C_PATH,
  ELYN_BASE,
  ELYN_IMAGE_RULES,
  REV,
  UUID,
  UUID_RE,
  at,
  bytes,
  checkImageFile,
  elynCommit,
  elynJson,
  elynJsonData,
  elynPlain,
  elynRaw,
  elynReadRaw,
  elynWorkId,
  isObj,
  list,
  strOrNull,
  strings,
  tagText,
  text,
  type ElynRaw,
  type Obj
} from './elyn-core'
import {
  elynApplyImages,
  elynImageGroups,
  elynPlanImages,
  elynSendRule,
  elynUploadCover
} from './elyn-media'
import type {
  LocalImage,
  LoreEntry,
  WorkAdapter,
  WorkBody,
  WorkDraft,
  WorkFetch,
  WorkIo,
  WorkListItem,
  WorkSend,
  WorkWrite
} from './types'

const READ_ONE = new RegExp(C_PATH + UUID + '$', 'i')
const READ_PATHS = [
  new RegExp(C_PATH + UUID + '/revisions/status$', 'i'),
  new RegExp(C_PATH + UUID + '/revisions/' + REV + '$', 'i')
]
const WRITE_PATHS: Record<string, RegExp[]> = {
  POST: [new RegExp(C_PATH + UUID + '/revisions/' + REV + '/submit$', 'i')],
  DELETE: [new RegExp(C_PATH + UUID + '$', 'i')]
}
// 편집기의 공개 범위 선택지 (unlisted = 일부 공개)
const VISIBILITIES = ['public', 'unlisted', 'private']

const onlyKeys = (q: URLSearchParams, keys: Record<string, RegExp>): boolean => {
  const seen = [...q.keys()]
  return (
    seen.length === Object.keys(keys).length &&
    new Set(seen).size === seen.length &&
    Object.entries(keys).every(([k, re]) => re.test(q.get(k) ?? ''))
  )
}
function readAllowed(url: string): boolean {
  if (
    elynPlain(url, [/^\/api\/v1\/characters\/mine$/], (q) =>
      onlyKeys(q, { page: /^[1-9][0-9]?$/, limit: /^50$/ })
    )
  )
    return true
  if (elynPlain(url, [READ_ONE], (q) => onlyKeys(q, { minimal: /^false$/ }))) return true
  return elynPlain(url, READ_PATHS)
}

// ── 편집기 입력 규칙 (createCharacterSchema) ──

const nonSpace = (s: string): number => s.replace(/\s/g, '').length
const within = (s: string, chars: number, maxBytes: number): boolean =>
  s.length <= chars || bytes(s) <= maxBytes
function checkFields(form: Obj): void {
  const name = text(form.name)
  if (!name || !within(name, 20, 35)) throw new Error('BAD_FIELD title 1~20자')
  const notes = text(form.creatorNotes)
  if (!notes || !within(notes, 9000, 12000)) throw new Error('BAD_FIELD description 1~9000자')
  const main = text(form.description)
  if (nonSpace(main) < 50 || bytes(main) > 300_000)
    throw new Error('BAD_FIELD main 공백 빼고 50자 이상, 300,000바이트 이하')
  const tags = tagText(form.tags)
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
  if (tags.length > 10 || tags.some((t) => bytes(t) > 40))
    throw new Error('BAD_FIELD hashtags 10개 이하, 각 40바이트 이하')
}
function checkStarts(form: Obj): void {
  const messages = list(form.firstMessages)
  if (messages.length < 1 || messages.length > 10) throw new Error('START_LIMIT')
  for (const [i, m] of messages.entries()) {
    const message = text(m.message)
    if (!message || !within(message, 2000, 5500))
      throw new Error('BAD_START start_scenarios[' + i + '].content 1~2000자')
  }
}
function checkLorebook(form: Obj): void {
  const lores = list(isObj(form.lorebook) ? form.lorebook.lores : null)
  if (lores.length > 250) throw new Error('LOREBOOK_LIMIT')
  const names = new Set<string>()
  for (const [i, e] of lores.entries()) {
    const name = text(e.name)
    const content = text(e.content)
    const where = 'lorebook[' + i + ']'
    if (!name || name.length > 150) throw new Error('BAD_LOREBOOK ' + where + '.title 1~150자')
    if (!content || !within(content, 800, 4500))
      throw new Error('BAD_LOREBOOK ' + where + '.content 1~800자')
    const keys = strings(e.trigger_strings)
    if (keys.some((k) => k.length > 30)) throw new Error('BAD_LOREBOOK ' + where + '.keys 각 30자')
    if (e.condition === 'on_match' && !keys.length)
      throw new Error('BAD_LOREBOOK ' + where + '.keys 1개 이상')
    if (names.has(name.trim())) throw new Error('BAD_LOREBOOK ' + where + '.title 중복')
    names.add(name.trim())
  }
}

const FIELDS: Record<string, string> = {
  title: 'name',
  description: 'creatorNotes',
  main: 'description'
}
const keyList = (keys: string): string[] =>
  keys
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean)
const CONDITIONS = ['on_match', 'until_match']
/** 공통 로어북 항목 → 엘린 lore. mode = condition, turnRange = scan_turns */
function loreFrom(entry: Partial<LoreEntry>, base?: Obj): Obj {
  if (entry.offKeys?.length || (entry.offTurnRange !== undefined && entry.offTurnRange !== null))
    throw new Error('BAD_CHANGES')
  if (entry.mode !== undefined && entry.mode !== null && !CONDITIONS.includes(entry.mode))
    throw new Error('BAD_CHANGES')
  const turns = entry.turnRange
  if (
    turns !== undefined &&
    turns !== null &&
    (!Number.isInteger(turns) || turns < 0 || turns > 999)
  )
    throw new Error('BAD_CHANGES')
  // 편집기의 로어북 추가 버튼과 같은 기본값
  const out: Obj = base
    ? { ...base }
    : {
        name: '',
        content: '',
        trigger_strings: [],
        scan_first_message: false,
        condition: 'on_match',
        scan_turns: 3,
        group: null,
        group_priority: 0,
        requires: []
      }
  if (entry.title !== undefined) out.name = entry.title
  if (entry.content !== undefined) out.content = entry.content
  if (entry.keys !== undefined) out.trigger_strings = keyList(entry.keys)
  if (entry.mode) out.condition = entry.mode
  if (typeof turns === 'number') out.scan_turns = turns
  return out
}
type StartExtras = {
  title?: string
  subPrompt?: string
  dialogue?: string
  situation?: string
  description?: string
}
/** 엘린 첫 메시지는 글 하나뿐이다 (content만 받는다) */
function noStartExtras(s: StartExtras): void {
  for (const key of ['title', 'subPrompt', 'dialogue', 'situation', 'description'] as const)
    if (s[key] !== undefined && s[key] !== '') throw new Error('BAD_CHANGES')
}
/** 공개 범위를 바꿀 수 없는 독점 작품인지 (편집기: isExclusive이고 잠금 기한이 없거나 아직 안 지남) */
const exclusiveLocked = (form: Obj): boolean => {
  if (form.isExclusive !== true) return false
  const until = strOrNull(form.exclusiveLockedUntil)
  return !until || Date.parse(until) > Date.now()
}

export const elynWorks: WorkAdapter = {
  id: 'elyn',
  label: '엘린',
  capabilities: ['works_list', 'work_read', 'lorebook', 'start_scenarios', 'save', 'images'],

  readAllowed,
  writeAllowed: (method, url) => !!WRITE_PATHS[method] && elynPlain(url, WRITE_PATHS[method]),

  async list(read: WorkFetch): Promise<WorkListItem[]> {
    const out: WorkListItem[] = []
    for (let page = 1; page <= 30; page++) {
      const body = await elynJson(await read(ELYN_BASE + 'mine?page=' + page + '&limit=50'))
      if (!isObj(body) || !Array.isArray(body.characters)) throw new Error('WORK_LIST_SHAPE')
      const rows = list(body.characters)
      for (const w of rows) {
        const id = strOrNull(w.id)
        if (id)
          out.push({
            id,
            title: text(w.name),
            visibility: strOrNull(w.visibility),
            status: null,
            updatedAt: strOrNull(w.updatedAt) ?? strOrNull(w.updated_at),
            characters: null
          })
      }
      const total = typeof body.total === 'number' ? body.total : 0
      if (rows.length < 50 || page * 50 >= total) break
    }
    return out
  },

  // 편집기처럼 가장 최근 판이 있으면 그 판의 폼을 연다 (elyn-core.ts)
  readRaw: elynReadRaw,

  normalize(raw): WorkBody {
    const r = elynRaw(raw)
    const f = r.form
    const rev = r.revision
    const version = rev ? (rev.version_number ?? rev.versionNumber ?? '?') : null
    return {
      id: r.id,
      title: text(f.name),
      visibility: strOrNull(f.visibility),
      status: null,
      // 수정 시각 대신 판 번호와 판 상태(draft / in_review / approved …)를 보여 준다
      updatedAt: rev
        ? ['v' + String(version), text(rev.status)].filter(Boolean).join(' ')
        : (strOrNull(r.character.updatedAt) ?? strOrNull(r.character.updated_at)),
      fields: Object.fromEntries(Object.entries(FIELDS).map(([k, key]) => [k, text(f[key])])),
      lorebook: list(isObj(f.lorebook) ? f.lorebook.lores : null).map((e) => ({
        title: text(e.name),
        keys: strings(e.trigger_strings).join(', '),
        content: text(e.content),
        mode: strOrNull(e.condition),
        offKeys: [],
        turnRange: typeof e.scan_turns === 'number' ? e.scan_turns : null,
        offTurnRange: null
      })),
      startScenarios: list(f.firstMessages).map((m, i) => ({
        id: null,
        title: '',
        isDefault: i === 0,
        content: text(m.message),
        subPrompt: '',
        dialogue: '',
        situation: '',
        description: ''
      })),
      characters: []
    }
  },

  applyChanges(raw, changes) {
    elynRaw(raw)
    const next = structuredClone(raw) as ElynRaw
    const f = next.form

    if (changes.visibility !== undefined) {
      if (!VISIBILITIES.includes(changes.visibility)) throw new Error('BAD_VISIBILITY')
      if (changes.visibility !== f.visibility) {
        if (exclusiveLocked(f)) throw new Error('VISIBILITY_LOCKED')
        f.visibility = changes.visibility
        // 편집기: 공개가 아니면 독점 표시를 끈다
        if (changes.visibility !== 'public') f.isExclusive = false
      }
    }

    let fieldsChanged = false
    for (const [name, value] of Object.entries(changes.fields ?? {})) {
      const key = FIELDS[name]
      if (!key || typeof value !== 'string') throw new Error('BAD_FIELD')
      f[key] = value
      fieldsChanged = true
    }
    if (fieldsChanged) checkFields(f)

    const book = isObj(f.lorebook) ? f.lorebook : { lores: [] }
    let lores = list(book.lores)
    const loreBefore = JSON.stringify(lores)
    if (changes.lorebook) {
      const old = lores
      lores = changes.lorebook.map((e, i) => loreFrom(e, old[i]))
    }
    for (const patch of changes.lorebookPatch ?? []) {
      const i = at(patch.index, lores.length)
      lores[i] = loreFrom(patch, lores[i])
    }
    if (changes.lorebookRemove?.length) {
      const gone = new Set(changes.lorebookRemove.map((i) => at(i, lores.length)))
      lores = lores.filter((_, i) => !gone.has(i))
    }
    for (const entry of changes.lorebookAdd ?? []) lores.push(loreFrom(entry))
    f.lorebook = { ...book, lores }
    if (JSON.stringify(lores) !== loreBefore) checkLorebook(f)

    let messages = list(f.firstMessages)
    const startsBefore = JSON.stringify(messages)
    for (const patch of changes.startScenarios ?? []) {
      const i = at(patch.index, messages.length)
      noStartExtras(patch)
      if (patch.content !== undefined) messages[i] = { message: patch.content }
    }
    if (changes.startScenariosRemove?.length) {
      const gone = new Set(changes.startScenariosRemove.map((i) => at(i, messages.length)))
      if (gone.has(0)) throw new Error('KEEP_DEFAULT')
      messages = messages.filter((_, i) => !gone.has(i))
    }
    for (const draft of changes.startScenariosAdd ?? []) {
      noStartExtras(draft)
      messages.push({ message: draft.content ?? '' })
    }
    f.firstMessages = messages
    if (JSON.stringify(messages) !== startsBefore) checkStarts(f)

    // 엘린은 작품 하나에 캐릭터 하나다
    if (
      changes.characters?.length ||
      changes.charactersAdd?.length ||
      changes.charactersRemove?.length
    )
      throw new Error('NO_CHARACTERS')
    return next
  },

  /** 판 저장(파일 묶음) → 제출. 판 저장이 파일 묶음이라 send 통로(io)가 있어야 한다 */
  async save(
    write: WorkWrite,
    id: string,
    next: unknown,
    channel?: WorkSend | WorkIo
  ): Promise<void> {
    const send = sendOf(channel)
    if (!send) throw new Error('SAVE_NEEDS_SEND')
    await elynCommit({ write, send }, elynWorkId(id), elynRaw(next), [])
  },

  visibilities: VISIBILITIES,

  async remove(write, id) {
    const res = await write('DELETE', ELYN_BASE + elynWorkId(id))
    if (res.status === 401 || res.status === 403) throw new Error('LOGIN_REQUIRED')
    if (res.status === 404) throw new Error('WORK_NOT_FOUND')
    if (!res.ok) throw new Error('DELETE_FAILED ' + res.status)
  },

  /**
   * 새 작품 (항상 비공개). 대표 이미지 파일이 만들기 요청에 같이 가야 해서 send 통로가 있어야 한다.
   * draft.coverUrl은 uploadImage가 돌려준 표시(elyn-pending:…)여야 한다.
   */
  async create(
    _write: WorkWrite,
    draft: WorkDraft,
    read?: WorkFetch,
    channel?: WorkSend | WorkIo
  ): Promise<string> {
    const send = sendOf(channel)
    if (!send) throw new Error('CREATE_NEEDS_SEND')
    const form = elynCreateForm(draft)
    const cover = takePending(draft.coverUrl)
    const before = read ? new Set((await elynWorks.list(read)).map((w) => w.id)) : null
    const res = await send({
      method: 'POST',
      url: ELYN_BASE + 'create/simple',
      form: [
        { name: 'files', file: cover },
        { name: 'data', value: JSON.stringify(elynJsonData(form, 'ko', 'create')) }
      ]
    })
    if (res.status === 401 || res.status === 403) throw new Error('LOGIN_REQUIRED')
    if (res.status === 413) throw new Error('IMAGE_TOO_LARGE')
    if (res.status === 429) throw new Error('PUBLISH_RATE_LIMITED')
    const reply: unknown = await res.json().catch(() => null)
    if (!res.ok)
      throw new Error(
        'CREATE_FAILED ' + res.status + ' ' + text(isObj(reply) ? reply.message : '').slice(0, 60)
      )
    // 편집기는 응답의 character.id를 쓴다
    const made = isObj(reply) && isObj(reply.character) ? text(reply.character.id) : ''
    if (UUID_RE.test(made)) return made.toLowerCase()
    if (read && before) {
      const fresh = (await elynWorks.list(read)).filter(
        (w) => !before.has(w.id) && w.title === draft.title
      )
      if (fresh.length === 1) return elynWorkId(fresh[0].id)
    }
    throw new Error('CREATED_ID_UNKNOWN')
  },

  checkDraft(draft) {
    elynCreateForm(draft)
  },

  sendRule: elynSendRule,
  imageRules: ELYN_IMAGE_RULES,
  imageGroups: elynImageGroups,
  planImages: elynPlanImages,
  applyImages: elynApplyImages,
  /**
   * 엘린은 이미지만 따로 올리는 주소가 없다 (대표 이미지는 만들기 요청에 파일로 같이 간다).
   * 파일을 앱 안에 30분 맡아 두고 그 표시(elyn-pending:…)를 돌려준다. create가 이 표시로 파일을 꺼낸다.
   */
  async uploadImage(_io, file) {
    checkImageFile(file)
    sweepPending()
    const key = PENDING_PREFIX + randomUUID()
    pending.set(key, { file, expires: Date.now() + 30 * 60_000 })
    return key
  },
  coverRules: ELYN_IMAGE_RULES,
  coverUrl: (raw) => strOrNull(elynRaw(raw).form.imageUrl),
  uploadCover: elynUploadCover
}

/** 공용 도구가 넘기는 네 번째 인자(send 함수 또는 통로 묶음)에서 send를 꺼낸다 */
const sendOf = (channel: WorkSend | WorkIo | undefined): WorkSend | null =>
  typeof channel === 'function' ? channel : (channel?.send ?? null)

// ── 새 작품 ──

const PENDING_PREFIX = 'elyn-pending:'
const pending = new Map<string, { file: LocalImage; expires: number }>()
function sweepPending(): void {
  const now = Date.now()
  for (const [k, v] of pending) if (v.expires < now) pending.delete(k)
}
function takePending(key: string | undefined): LocalImage {
  sweepPending()
  const hit = key ? pending.get(key) : undefined
  if (!key || !hit) throw new Error('COVER_REQUIRED')
  pending.delete(key)
  return hit.file
}

const TARGETS = ['all', 'male', 'female']
/** 새 작품 폼 (항상 비공개). 편집기의 입력 규칙을 플랫폼에 닿기 전에 확인한다 */
export function elynCreateForm(draft: WorkDraft): Obj {
  const o = draft.options ?? {}
  if (draft.characters.length) throw new Error('NO_CHARACTERS')
  const target = o.target === undefined ? 'all' : o.target
  if (typeof target !== 'string' || !TARGETS.includes(target))
    throw new Error('BAD_DRAFT options.target all/male/female')
  const starts = draft.startScenarios ?? []
  for (const s of starts) noStartExtras(s)
  const form: Obj = {
    // 편집기의 새 작품 기본값 (defaultCharacterFormValues)
    name: draft.title,
    imageUrl: '',
    creatorNotes: draft.description ?? '',
    tags: (draft.hashtags ?? []).join(','),
    visibility: 'private',
    target,
    isNsfw: draft.adult,
    isExclusive: false,
    exclusiveLockedUntil: null,
    subImages: [],
    isPaug: false,
    description: draft.main,
    favoredModelId: 'none',
    firstMessages: starts.map((s) => ({ message: s.content ?? '' })),
    lorebook: { lores: (draft.lorebook ?? []).map((e) => loreFrom(e)) },
    customScript: []
  }
  checkFields(form)
  checkStarts(form)
  checkLorebook(form)
  return form
}
