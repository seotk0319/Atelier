// 엘린 작품 본문 읽기·저장. 주소와 필드는 2026-11-10 엘린 편집기 공개 스크립트에서 읽었고, 같은 날 실제 계정 호출(읽기 스냅샷, 새 작품·삭제)로 확인했다. 확인 정도는 features 표의 verified.
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
  VISIBILITIES,
  at,
  bytes,
  checkImageFile,
  elynCommit,
  elynExtras,
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
import { matchOld } from './match-old'
import type {
  LocalImage,
  LoreEntry,
  WorkAdapter,
  WorkBody,
  WorkDraft,
  WorkFeature,
  WorkFetch,
  WorkIo,
  WorkListItem,
  WorkSend,
  WorkWrite
} from './types'
import { feature, keyList } from './shared'

const READ_ONE = new RegExp(C_PATH + UUID + '$', 'i')
const READ_PATHS = [
  new RegExp(C_PATH + UUID + '/revisions/status$', 'i'),
  new RegExp(C_PATH + UUID + '/revisions/' + REV + '$', 'i')
]
const WRITE_PATHS: Record<string, RegExp[]> = {
  POST: [new RegExp(C_PATH + UUID + '/revisions/' + REV + '/submit$', 'i')],
  DELETE: [new RegExp(C_PATH + UUID + '$', 'i')]
}

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
/**
 * 칸 검사. only를 주면 그 칸(폼 칸 이름)만 본다 — 고칠 때는 바뀐 칸만, 새 작품은 전부.
 * 바뀌지 않은 칸은 사이트가 받아 준 옛 값일 수 있어 막지 않는다.
 */
function checkFields(form: Obj, only?: string[]): void {
  const on = (key: string): boolean => !only || only.includes(key)
  if (on('name')) {
    const name = text(form.name)
    if (!name || !within(name, 20, 35)) throw new Error('BAD_FIELD title 1~20자')
  }
  if (on('creatorNotes')) {
    const notes = text(form.creatorNotes)
    if (!notes || !within(notes, 9000, 12000)) throw new Error('BAD_FIELD description 1~9000자')
  }
  if (on('description')) {
    const main = text(form.description)
    if (nonSpace(main) < 50 || bytes(main) > 300_000)
      throw new Error('BAD_FIELD main 공백 빼고 50자 이상, 300,000바이트 이하')
  }
  if (on('tags')) {
    const tags = tagText(form.tags)
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
    if (tags.length > 10 || tags.some((t) => bytes(t) > 40))
      throw new Error('BAD_FIELD hashtags 10개 이하, 각 40바이트 이하')
  }
}
/**
 * 원본에 없던(바뀌었거나 새로 더한) 항목의 자리 번호. 같은 모양의 옛 항목이 있으면 그대로인 항목이다
 * (순서만 바뀐 것도 그대로). 같은 모양이 여럿이면 옛 항목 수만큼만 그대로로 본다.
 */
function touched(now: Obj[], before: Obj[]): Set<number> {
  const left = before.map((e) => JSON.stringify(e))
  const out = new Set<number>()
  now.forEach((e, i) => {
    const k = left.indexOf(JSON.stringify(e))
    if (k < 0) out.add(i)
    else left.splice(k, 1)
  })
  return out
}
/** before를 주면(고칠 때) 바뀌었거나 새로 더한 첫 메시지만 본다. 개수는 늘었을 때만 막는다 */
function checkStarts(form: Obj, before?: Obj[]): void {
  const messages = list(form.firstMessages)
  if (messages.length < 1 || (messages.length > 10 && messages.length > (before?.length ?? 0)))
    throw new Error('START_LIMIT')
  const check = before ? touched(messages, before) : null
  for (const [i, m] of messages.entries()) {
    if (check && !check.has(i)) continue
    const message = text(m.message)
    if (!message || !within(message, 2000, 5500))
      throw new Error('BAD_START start_scenarios[' + i + '].content 1~2000자')
  }
}
const countNames = (lores: Obj[]): Map<string, number> => {
  const out = new Map<string, number>()
  for (const e of lores) {
    const name = text(e.name).trim()
    out.set(name, (out.get(name) ?? 0) + 1)
  }
  return out
}
/** before를 주면(고칠 때) 바뀌었거나 새로 더한 항목만 본다. 개수는 늘었을 때만, 이름 중복은 새로 생겼을 때만 막는다 */
function checkLorebook(form: Obj, before?: Obj[]): void {
  const lores = list(isObj(form.lorebook) ? form.lorebook.lores : null)
  if (lores.length > 250 && lores.length > (before?.length ?? 0)) throw new Error('LOREBOOK_LIMIT')
  const check = before ? touched(lores, before) : null
  const now = countNames(lores)
  const was = countNames(before ?? [])
  for (const [i, e] of lores.entries()) {
    if (check && !check.has(i)) continue
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
    const seen = now.get(name.trim()) ?? 0
    if (seen > 1 && seen > (was.get(name.trim()) ?? 0))
      throw new Error('BAD_LOREBOOK ' + where + '.title 중복')
  }
}

const FIELDS: Record<string, string> = {
  title: 'name',
  description: 'creatorNotes',
  main: 'description'
}
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
  // 읽을 때 ', '로 이은 글 그대로면 키워드를 다시 쪼개지 않는다 (쉼표가 든 키워드, 앞뒤 공백이 있는 키워드가 깨진다)
  // 전체 교체에서 keys를 적지 않았으면(given에 없음) 짝지은 옛 항목의 키워드를 그대로 둔다
  const keysOmitted = !!base && !!entry.given && !entry.given.includes('keys')
  if (
    entry.keys !== undefined &&
    !keysOmitted &&
    !(base && entry.keys === strings(base.trigger_strings).join(', '))
  )
    out.trigger_strings = keyList(entry.keys)
  if (entry.mode) out.condition = entry.mode
  if (typeof turns === 'number') out.scan_turns = turns
  return out
}
/**
 * 제목이 바뀐 채 자리로만 이어진 옛 항목은, 내용이 같거나 키워드가 하나라도 겹칠 때만 숨은 설정을 물려준다.
 * (옛 항목을 지우고 다른 항목을 같은 자리에 넣은 경우에 지워진 항목의 설정이 새 항목에 붙지 않게)
 */
function sameEntry(old: Obj, entry: Partial<LoreEntry>): boolean {
  if (text(old.name) === entry.title) return true
  if (entry.content !== undefined && entry.content === text(old.content)) return true
  if (entry.given && !entry.given.includes('keys')) return true
  const oldKeys = strings(old.trigger_strings).map((k) => k.trim())
  return keyList(entry.keys ?? '').some((k) => oldKeys.includes(k))
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

const NOT_ON_SITE = (note: string): WorkFeature => feature('no', 'no', 'no', 'no', note)

const FEATURES: Record<string, WorkFeature> = {
  title: feature('yes', 'yes', 'yes', 'partial', '1~20자(또는 35바이트)'),
  description: feature('yes', 'yes', 'yes', 'partial', '소개 1~9,000자(12,000바이트)'),
  main_prompt: feature('yes', 'yes', 'yes', 'partial', '공백 뺀 50자 이상, 30만 바이트 이하'),
  first_message: feature('yes', 'yes', 'yes', 'partial', '1~10개, 각 2,000자(5,500바이트)'),
  start_scenarios: feature('yes', 'yes', 'partial', 'partial', '제목 없음, 0번 삭제 불가'),
  lorebook: feature('yes', 'partial', 'partial', 'partial', '새·고친 항목만 내용 800자 검사'),
  characters: NOT_ON_SITE('캐릭터 칸 없음(작품 하나=캐릭터 하나)'),
  example_dialogue: NOT_ON_SITE('전용 칸 없음'),
  user_persona: NOT_ON_SITE('전용 칸 없음'),
  output_rules: NOT_ON_SITE('전용 칸 없음, 메인 본문에 씀'),
  situation_images: feature(
    'yes',
    'partial',
    'partial',
    'partial',
    '갤러리 100장, slug 12자, 설명 고치기 없음'
  ),
  cover: feature('yes', 'yes', 'partial', 'partial', '대표 필수, 교체만 가능'),
  tags: feature('yes', 'yes', 'partial', 'no', '10개·각 40바이트, 만들 때만 입력'),
  visibility: feature('yes', 'yes', 'partial', 'partial', 'public 전환 미확인'),
  create_work: feature('yes', 'no', 'yes', 'yes', '비공개로만, 대표 이미지 필수'),
  delete_work: feature('yes', 'no', 'yes', 'yes', '계획 후 제목 확인'),
  versioning_review: feature('yes', 'yes', 'no', 'partial', '공개작 저장=검수 요청, 취소 없음'),
  language_editions: feature('yes', 'partial', 'no', 'no', '첫 언어 하나만 읽고 저장'),
  bgm_voice: NOT_ON_SITE('편집 패널에 칸 없음'),
  jsx_html: feature('yes', 'partial', 'no', 'no', '컴포넌트 개수만 읽음, 사이트에서 직접'),
  model_settings: feature('yes', 'yes', 'no', 'no', '읽기만, 고치기는 사이트에서 직접'),
  comments_stats: feature('yes', 'no', 'no', 'no', '댓글은 알림 쪽 별도, 통계는 못 읽음')
}

export const elynWorks: WorkAdapter = {
  id: 'elyn',
  // 서버가 만드는 작품 보기·판 상태 (고칠 수 있는 값은 form에 있다) (2026-11-13 실제 저장에서 확인)
  rawIgnore: [/^character\b/, /^status\b/, /^revision\b/],
  label: '엘린',
  features: FEATURES,
  guide: {
    save: '판 저장 후 제출이다. 공개 작품은 저장하면 검수 요청이 되고, 검수 중에는 저장이 막힌다(IN_REVIEW). 비공개 작품은 바로 반영된다.',
    manual: [],
    unverified: [
      '공개작 저장과 검수 흐름',
      'public 전환',
      '소개·첫 메시지가 여러 언어인 작품을 저장할 때 다른 언어 값이 남는지(저장은 한 언어만 보낸다)'
    ]
  },
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
    // 목록과 같은 수정 시각. 판 번호·판 상태는 extras(revision_version, revision_status)에 있다
    const locales = new Set(
      [r.character.creatorNotes, r.character.firstMessage].flatMap((v) =>
        list(v).flatMap((e) => strOrNull(e.locale) ?? [])
      )
    )
    return {
      id: r.id,
      title: text(f.name),
      visibility: strOrNull(f.visibility),
      status: null,
      updatedAt:
        strOrNull(r.character.updatedAt) ??
        strOrNull(r.character.updated_at) ??
        (rev ? (strOrNull(rev.updated_at) ?? strOrNull(rev.updatedAt)) : null),
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
      characters: [],
      extras: elynExtras(r),
      unsupported: [
        '로어북 항목별 첫 메시지 스캔·그룹·선행 조건',
        'JSX 스크립트 코드',
        '통계(좋아요·대화·댓글 수)',
        ...(locales.size > 1 ? ['다른 언어의 소개·첫 메시지'] : [])
      ]
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

    const changedKeys: string[] = []
    for (const [name, value] of Object.entries(changes.fields ?? {})) {
      const key = FIELDS[name]
      if (!key || typeof value !== 'string') throw new Error('BAD_FIELD')
      if (f[key] !== value) changedKeys.push(key)
      f[key] = value
    }
    // 바뀐 칸만 본다 (안 건드린 칸의 옛 값 때문에 저장이 막히지 않게)
    if (changedKeys.length) checkFields(f, changedKeys)

    const book = isObj(f.lorebook) ? f.lorebook : { lores: [] }
    let lores = list(book.lores)
    const loreOld = [...lores]
    const loreBefore = JSON.stringify(lores)
    if (changes.lorebook) {
      // 제목이 같은 옛 항목의 숨은 설정만 물려받는다. 짝이 없는 새 항목은 기본값으로 시작한다
      const whole = changes.lorebook
      const picked = matchOld(
        whole.map((e) => e.title),
        loreOld,
        (o) => text(o.name),
        // 내용까지 견준다: 그 자리 항목을 지우고 새로 넣은 것이 지운 항목의 숨은 설정을 물려받지 않게
        { contents: whole.map((e) => e.content), contentOf: (o) => text(o.content) }
      )
      lores = whole.map((e, i) => {
        const old = picked[i]
        return loreFrom(e, old && sameEntry(old, e) ? old : undefined)
      })
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
    if (JSON.stringify(lores) !== loreBefore) checkLorebook(f, loreOld)

    let messages = list(f.firstMessages)
    const startsOld = [...messages]
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
    if (JSON.stringify(messages) !== startsBefore) checkStarts(f, startsOld)

    // 공개 범위를 모르면 저장 때가 아니라 계획 단계에서 멈춘다 (elynCommit도 같은 검사를 한다)
    if (!text(f.visibility)) throw new Error('BAD_VISIBILITY')

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
