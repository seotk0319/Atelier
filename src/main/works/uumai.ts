// 우마이 작품 본문 읽기·저장. 주소와 필드는 2026-11-10 우마이 공개 스크립트에서 읽었다 (실제 호출 전).
//   GET    /v1/creator/work?sort=latest[&after=]          스튜디오 작품 목록 {data, meta:{next}}
//   GET    /v1/creator/work/{id}/snapshot                 {snapshots, draftSnapshotId, publishedSnapshotId}
//   GET    /v1/creator/work/{id}/snapshot/{sid}           스냅샷 (편집기가 여는 값)
//   POST   /v1/creator/work/save                          저장. isPublish false = 임시저장(초안), true = 발행
//   DELETE /v1/creator/work/{id}                          작품 삭제
// 저장은 늘 "임시저장(초안)"이다. 이미 발행한 작품이면 사이트에 보이는 발행본은 그대로고, 사이트에서 '작품 등록'을
// 눌러야 반영된다. 공개 상태(visibility)를 바꿀 때만 편집기의 '작품 등록'과 같이 발행한다.
// 캐릭터 칸은 없다(작품 하나 = 프롬프트 하나). 인트로가 시작 상황이다.
// 글 칸: title=title(작품명), subtitle=description(짧은 작품소개), description=detailDescription(상세 작품소개),
//        main=prompt(상세 프롬프트), play_guide=playGuide(플레이 가이드).
import { randomUUID } from 'node:crypto'
import {
  PUBLISH_STATUS,
  UUMAI_API,
  UUID,
  UUID_RE,
  arrangeLorebooks,
  at,
  isObj,
  list,
  strOrNull,
  strings,
  text,
  uumaiJson,
  uumaiPendingDraft,
  uumaiPlain,
  uumaiRaw,
  uumaiReadRaw,
  uumaiSave,
  uumaiSaveBody,
  uumaiStatus,
  uumaiVisibility,
  uumaiWorkId,
  type Obj,
  type UumaiRaw
} from './uumai-core'
import {
  UUMAI_IMAGE_RULES,
  uumaiApplyImages,
  uumaiCoverUrl,
  uumaiImageGroups,
  uumaiPlanImages,
  uumaiSendRule,
  uumaiUploadCover
} from './uumai-media'
import { compileUumaiJsx, JSX_MAX_FILES } from './uumai-jsx'
import type { LoreEntry, WorkAdapter, WorkBody, WorkDraft, WorkListItem } from './types'

const READ_PATHS = [
  /^\/v1\/creator\/work$/,
  new RegExp('^/v1/creator/work/' + UUID + '/snapshot$', 'i'),
  new RegExp('^/v1/creator/work/' + UUID + '/snapshot/' + UUID + '$', 'i')
]
// 목록 쿼리: 편집기와 같이 정렬을 고정하고(sort=latest) 다음 쪽 표시(after)만 받는다
const listQuery = (q: URLSearchParams): boolean => {
  const keys = [...q.keys()]
  return (
    q.get('sort') === 'latest' &&
    keys.every((k) => k === 'sort' || k === 'after') &&
    keys.filter((k) => k === 'sort').length === 1 &&
    keys.filter((k) => k === 'after').length <= 1 &&
    /^[A-Za-z0-9_\-.:=+/]{0,200}$/.test(q.get('after') ?? '')
  )
}
const VISIBILITIES = ['public', 'private', 'link']

// 55962 규격 (c 상수)
const LIMITS = {
  title: 20,
  description: 10_000,
  detailDescription: 100_000,
  prompt: 50_000,
  playGuide: 5000,
  intros: 10,
  introName: 50,
  introContent: 5000,
  introPrompt: 5000,
  lorebooks: 300,
  loreName: 30,
  loreKeywords: 50,
  loreKeyword: 20,
  loreContent: 10_000,
  loreNot: 5,
  hashtags: 10,
  hashtag: 10
}
/** JSX 컴포넌트 파일을 가리키는 글 칸 이름의 앞머리 (jsx:{파일 이름}) */
const JSX_FIELD = 'jsx:'
const FIELDS: Record<string, string> = {
  title: 'title',
  subtitle: 'description',
  description: 'detailDescription',
  main: 'prompt',
  play_guide: 'playGuide'
}

function checkFields(w: Obj): void {
  for (const [name, key] of Object.entries(FIELDS)) {
    const max = LIMITS[key as keyof typeof LIMITS]
    if (text(w[key]).length > max) throw new Error('BAD_FIELD ' + name + ' ~' + max + '자')
  }
}
const keyList = (keys: string): string[] =>
  keys
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean)

/**
 * 공통 로어북 항목 → 우마이 로어북. mode: keyword(키워드로 발동) / always(상시 활성화 isConstant).
 * turnRange = scanTurns(-1 전체 대화 · 0 현재 입력 · 1~5 최근 N턴, 비우면 사이트 기본 1턴), offKeys = notKeywords.
 * 우마이에 없는 offTurnRange를 주면 거절한다. 공용 도구가 주지 않은 값(null)은 기본값을 쓴다.
 */
function loreFrom(entry: Partial<LoreEntry>, base: Obj | undefined): Obj {
  if (entry.offTurnRange !== undefined && entry.offTurnRange !== null)
    throw new Error('BAD_CHANGES')
  const out: Obj = base
    ? { ...base }
    : {
        // 편집기 로어북 추가와 같은 기본값 (77592 g, 91740 Bx)
        id: randomUUID(),
        name: '',
        keywords: [],
        content: '',
        activateOnIntro: false,
        isConstant: false,
        andKeywords: [],
        notKeywords: [],
        scanTurns: null,
        dependsOnIds: [],
        group: '',
        priority: 0,
        effect: null,
        bgmAudioId: null,
        bgmStop: false,
        folderId: null
      }
  if (entry.title !== undefined) out.name = entry.title
  if (entry.content !== undefined) out.content = entry.content
  if (entry.keys !== undefined) out.keywords = keyList(entry.keys)
  if (entry.offKeys !== undefined)
    out.notKeywords = entry.offKeys.map((k) => k.trim()).filter(Boolean)
  if (entry.mode !== undefined && entry.mode !== null) {
    if (entry.mode !== 'keyword' && entry.mode !== 'always') throw new Error('BAD_LOREBOOK mode')
    out.isConstant = entry.mode === 'always'
  }
  if (entry.turnRange !== undefined && entry.turnRange !== null) out.scanTurns = entry.turnRange
  return out
}
function checkLorebook(lores: Obj[]): void {
  if (lores.length > LIMITS.lorebooks) throw new Error('LOREBOOK_LIMIT')
  for (const [i, e] of lores.entries()) {
    const where = 'BAD_LOREBOOK lorebook[' + i + ']'
    if (text(e.name).length > LIMITS.loreName) throw new Error(where + '.title ~30자')
    if (text(e.content).length > LIMITS.loreContent) throw new Error(where + '.content ~10000자')
    const keys = strings(e.keywords)
    if (keys.length > LIMITS.loreKeywords || keys.some((k) => k.length > LIMITS.loreKeyword))
      throw new Error(where + '.keys 50개 이하, 각 20자 이하')
    const not = strings(e.notKeywords)
    if (not.length > LIMITS.loreNot || not.some((k) => k.length > LIMITS.loreKeyword))
      throw new Error(where + '.off_keys 5개 이하, 각 20자 이하')
    const scan = e.scanTurns
    if (
      scan !== null &&
      scan !== undefined &&
      (typeof scan !== 'number' || !Number.isInteger(scan) || scan < -1 || scan > 5)
    )
      throw new Error(where + '.turn_range -1~5')
  }
}
type StartExtras = { dialogue?: string; situation?: string; description?: string }
/** 우마이 인트로는 제목·내용·인트로 프롬프트뿐이다 */
function noStartExtras(s: StartExtras): void {
  for (const key of ['dialogue', 'situation', 'description'] as const)
    if (s[key] !== undefined && s[key] !== '') throw new Error('BAD_CHANGES')
}
function checkIntros(intros: Obj[]): void {
  if (intros.length < 1 || intros.length > LIMITS.intros) throw new Error('START_LIMIT')
  for (const [i, s] of intros.entries()) {
    const where = 'BAD_START start_scenarios[' + i + ']'
    if (text(s.name).length > LIMITS.introName) throw new Error(where + '.title ~50자')
    if (text(s.content).length > LIMITS.introContent) throw new Error(where + '.content ~5000자')
    if (text(s.prompt).length > LIMITS.introPrompt) throw new Error(where + '.sub_prompt ~5000자')
  }
}
/** 인트로를 지우면 로어북의 적용 인트로 번호를 맞춘다 (지운 인트로만 빠지고 뒤 번호는 당겨진다) */
function shiftSequences(lores: Obj[], removed: number): Obj[] {
  return lores.map((l) => {
    if (!Array.isArray(l.introSequences)) return l
    const seq = (l.introSequences as unknown[])
      .filter((n): n is number => typeof n === 'number' && n !== removed)
      .map((n) => (n > removed ? n - 1 : n))
    // 남는 번호가 없으면 편집기처럼 전체 인트로가 된다 (NG: 빈 목록은 보내지 않는다)
    return { ...l, introSequences: seq.length ? seq : undefined }
  })
}

/** 발행(작품 등록)에 필요한 칸 (55962 CreatorWorkSnapshotItem) */
function checkPublishable(w: Obj): void {
  const missing: string[] = []
  if (!text(w.title).trim()) missing.push('title')
  if (!text(w.description).trim()) missing.push('subtitle')
  if (!text(w.prompt).trim()) missing.push('main')
  if (!strings(w.hashtags).length) missing.push('hashtags')
  if (!(isObj(w.thumbnail) && text(w.thumbnail.imageId))) missing.push('cover')
  if (typeof w.genderTendency !== 'number') missing.push('gender_tendency')
  if (list(w.lorebooks).some((l) => strings(l.keywords).some((k) => !k.trim())))
    missing.push('lorebook keys')
  if (missing.length) throw new Error('PUBLISH_REQUIREMENTS ' + missing.join(','))
}

export const uumaiWorks: WorkAdapter = {
  id: 'uumai',
  label: '우마이',
  guide: {
    save: '저장은 늘 초안(임시저장)이다. 이미 발행한 작품은 발행본이 그대로이고, visibility를 주면 그때 발행되며 초안 내용도 같이 나간다.',
    manual: ['BGM·스킬·주사위·업적 편집(읽은 값 그대로 다시 보낸다)', '로어북 발동 테스트'],
    unverified: [
      '발행(visibility)',
      '발행한 작품에 초안 저장 뒤 발행본이 그대로인지',
      '초안 저장이 버전 수를 늘리는지',
      '실제 채팅'
    ]
  },
  capabilities: ['works_list', 'work_read', 'lorebook', 'start_scenarios', 'save', 'images'],

  readAllowed: (url) =>
    uumaiPlain(url, READ_PATHS.slice(1)) || uumaiPlain(url, READ_PATHS.slice(0, 1), listQuery),
  writeAllowed(method, url) {
    if (method === 'POST')
      return (
        uumaiPlain(url, [/^\/v1\/creator\/work\/save$/]) ||
        uumaiPlain(url, [/^\/v1\/image\/upload-url$/])
      )
    if (method === 'DELETE')
      return uumaiPlain(url, [new RegExp('^/v1/creator/work/' + UUID + '$', 'i')])
    return false
  },

  async list(read): Promise<WorkListItem[]> {
    const out: WorkListItem[] = []
    const seen = new Set<string>()
    const cursors = new Set<string>()
    let after: string | null = null
    for (let page = 0; page < 30; page++) {
      const body = await uumaiJson(
        await read(
          UUMAI_API +
            '/creator/work?sort=latest' +
            (after ? '&after=' + encodeURIComponent(after) : '')
        )
      )
      if (!isObj(body) || !Array.isArray(body.data)) throw new Error('WORK_LIST_SHAPE')
      for (const w of list(body.data)) {
        const id = strOrNull(w.id)
        if (!id || !UUID_RE.test(id) || seen.has(id)) continue
        seen.add(id)
        out.push({
          id,
          title: text(w.title),
          visibility: uumaiVisibility(w),
          status: strOrNull(w.publishedAt) ? 'published' : 'draft',
          updatedAt: strOrNull(w.draftSavedAt) ?? strOrNull(w.publishedAt),
          characters: null
        })
      }
      const meta = isObj(body.meta) ? body.meta : {}
      const next = typeof meta.next === 'number' ? String(meta.next) : strOrNull(meta.next)
      if (!next || !body.data.length || cursors.has(next)) break
      cursors.add(next)
      after = next
    }
    return out
  },

  readRaw: (read, id) => uumaiReadRaw(read, id),

  normalize(raw): WorkBody {
    const r = uumaiRaw(raw)
    const w = r.work
    return {
      id: r.id,
      title: text(w.title),
      visibility: uumaiVisibility(w),
      status: uumaiStatus(r),
      updatedAt:
        (strOrNull(w.updatedAt) ?? '') + (uumaiPendingDraft(r) ? ' (발행 안 된 초안)' : '') || null,
      fields: {
        ...Object.fromEntries(Object.entries(FIELDS).map(([k, key]) => [k, text(w[key])])),
        // JSX 컴포넌트 파일은 글 칸처럼 다룬다: 칸 이름 `jsx:{파일 이름}`, 값 = 소스 코드
        ...Object.fromEntries(
          list(w.jsx).map((j) => [JSX_FIELD + text(j.fileName), text(j.sourceCode)])
        )
      },
      lorebook: arrangeLorebooks(list(w.lorebooks), list(w.lorebookFolders)).map((l) => ({
        title: text(l.name),
        keys: strings(l.keywords).join(', '),
        content: text(l.content),
        mode: l.isConstant === true ? 'always' : 'keyword',
        offKeys: strings(l.notKeywords),
        turnRange: typeof l.scanTurns === 'number' ? l.scanTurns : null,
        offTurnRange: null
      })),
      startScenarios: list(w.intros).map((s, i) => ({
        id: null,
        title: text(s.name),
        isDefault: i === 0,
        content: text(s.content),
        subPrompt: text(s.prompt),
        dialogue: '',
        situation: '',
        description: ''
      })),
      characters: []
    }
  },

  applyChanges(raw, changes) {
    uumaiRaw(raw)
    const next = structuredClone(raw) as UumaiRaw & { publish?: boolean }
    const w = next.work

    if (changes.visibility !== undefined) {
      const status = PUBLISH_STATUS[changes.visibility]
      if (!status) throw new Error('BAD_VISIBILITY')
      w.publishStatus = status
      // 편집기에서 공개 여부는 '작품 등록(발행)'을 눌러야 반영된다. 그래서 공개 상태를 바꾸면 발행한다.
      next.publish = true
    }

    let fieldsChanged = false
    for (const [name, value] of Object.entries(changes.fields ?? {})) {
      if (typeof value !== 'string') throw new Error('BAD_FIELD')
      if (name.startsWith(JSX_FIELD)) {
        // jsx:{파일 이름} = 소스 코드. 빈 값이면 그 파일을 뺀다. 편집기처럼 저장 전에 컴파일해 둔다
        const fileName = name.slice(JSX_FIELD.length)
        const rest = list(w.jsx).filter((j) => text(j.fileName) !== fileName)
        const at = list(w.jsx).findIndex((j) => text(j.fileName) === fileName)
        if (!value.trim()) {
          if (at < 0) throw new Error('BAD_FIELD ' + name)
          w.jsx = rest
        } else {
          const compiled = compileUumaiJsx(fileName, value)
          // 같은 컴포넌트 이름이 다른 파일에 있으면 채팅 화면이 어느 쪽을 그릴지 알 수 없다
          const taken = new Set(rest.flatMap((j) => strings(j.components)))
          if (compiled.components.some((c) => taken.has(c))) throw new Error('BAD_JSX duplicate')
          const all = list(w.jsx)
          if (at < 0) all.push({ ...compiled })
          else all[at] = { ...all[at], ...compiled }
          if (all.length > JSX_MAX_FILES) throw new Error('BAD_JSX count')
          w.jsx = all
        }
        continue
      }
      const key = FIELDS[name]
      if (!key) throw new Error('BAD_FIELD')
      w[key] = value
      fieldsChanged = true
    }
    if (fieldsChanged) checkFields(w)

    const folders = list(w.lorebookFolders)
    let lores = arrangeLorebooks(list(w.lorebooks), folders)
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
      const goneIds = new Set([...gone].map((i) => text(lores[i].id)))
      lores = lores
        .filter((_, i) => !gone.has(i))
        // 지운 로어북에 걸린 의존 번호는 뺀다 (Bx와 같이 없는 번호는 버린다)
        .map((l) => ({
          ...l,
          dependsOnIds: strings(l.dependsOnIds).filter((d) => !goneIds.has(d))
        }))
    }
    for (const entry of changes.lorebookAdd ?? []) lores.push(loreFrom(entry, undefined))

    let intros = list(w.intros)
    const introsBefore = JSON.stringify(intros)
    for (const patch of changes.startScenarios ?? []) {
      const i = at(patch.index, intros.length)
      noStartExtras(patch)
      const s = { ...intros[i] }
      if (patch.title !== undefined) s.name = patch.title
      if (patch.content !== undefined) s.content = patch.content
      if (patch.subPrompt !== undefined) s.prompt = patch.subPrompt
      intros[i] = s
    }
    if (changes.startScenariosRemove?.length) {
      const gone = [...new Set(changes.startScenariosRemove.map((i) => at(i, intros.length)))]
      if (gone.includes(0)) throw new Error('KEEP_DEFAULT')
      // 뒤에서부터 지워야 번호가 어긋나지 않는다
      for (const i of gone.sort((a, b) => b - a)) {
        intros = intros.filter((_, n) => n !== i)
        lores = shiftSequences(lores, i)
      }
    }
    for (const draft of changes.startScenariosAdd ?? []) {
      noStartExtras(draft)
      // 편집기 새 인트로와 같은 모양 (80546)
      intros.push({
        name: draft.title ?? '',
        content: draft.content ?? '',
        prompt: draft.subPrompt ?? '',
        promptMaxTurn: null,
        bgmAudioId: null,
        recommends: []
      })
    }
    if (JSON.stringify(intros) !== introsBefore) {
      checkIntros(intros)
      w.intros = intros
    }
    const arranged = arrangeLorebooks(lores, folders)
    if (JSON.stringify(arranged) !== loreBefore) {
      checkLorebook(arranged)
      w.lorebooks = arranged
    }

    // 우마이는 작품 하나에 캐릭터 칸이 따로 없다
    if (
      changes.characters?.length ||
      changes.charactersAdd?.length ||
      changes.charactersRemove?.length
    )
      throw new Error('NO_CHARACTERS')

    if (next.publish) {
      checkPublishable(w)
      // 발행하면 초안과 발행본이 같아진다
      next.publishedSnapshotId = next.publishedSnapshotId ?? next.snapshotId
      next.draftSnapshotId = next.publishedSnapshotId
    }
    // 저장할 수 없는 jsx(컴파일 결과가 없는 것)는 계획 단계에서 미리 막는다
    uumaiSaveBody(w, { isPublish: false, workId: next.id })
    return next
  },

  async save(write, id, next) {
    const r = uumaiRaw(next) as UumaiRaw & { publish?: boolean }
    const wid = uumaiWorkId(id)
    await uumaiSave(write, uumaiSaveBody(r.work, { isPublish: r.publish === true, workId: wid }))
  },

  visibilities: VISIBILITIES,

  async remove(write, id) {
    const res = await write('DELETE', UUMAI_API + '/creator/work/' + uumaiWorkId(id))
    if (res.status === 401 || res.status === 403) throw new Error('LOGIN_REQUIRED')
    if (res.status === 404) throw new Error('WORK_NOT_FOUND')
    // 보상 풀이 열려 있거나 공개 제한 중인 작품은 사이트가 삭제를 막는다 (WorkDeleteRestricted 등)
    if (!res.ok) throw new Error('DELETE_FAILED ' + res.status)
  },

  async create(write, draft: WorkDraft): Promise<string> {
    const { workId } = await uumaiSave(write, uumaiCreateBody(draft))
    return workId
  },

  checkDraft(draft) {
    uumaiCreateBody(draft)
  },

  sendRule: uumaiSendRule,
  imageRules: UUMAI_IMAGE_RULES,
  imageGroups: uumaiImageGroups,
  planImages: uumaiPlanImages,
  applyImages: uumaiApplyImages,
  coverRules: UUMAI_IMAGE_RULES,
  coverUrl: uumaiCoverUrl,
  uploadCover: uumaiUploadCover
}

const GENDER: Record<string, number> = { male: 1, female: 2, all: 3 }
/**
 * 새 작품 저장 본문. 항상 임시저장(초안)이라 사이트에 보이지 않는다(공개 여부도 비공개 2).
 * options.gender_tendency: male(남성향) / female(여성향) / all(혼성향) — 발행할 때 필요하다(초안은 비워도 된다).
 * 표지·이미지는 만든 뒤 images_plan / cover_plan으로 올린다.
 */
export function uumaiCreateBody(draft: WorkDraft): Obj {
  if (draft.characters.length) throw new Error('NO_CHARACTERS')
  if (draft.coverUrl !== undefined) throw new Error('BAD_DRAFT cover_file은 만든 뒤 cover_plan으로')
  const o = draft.options ?? {}
  const gender = o.gender_tendency
  if (gender !== undefined && !(typeof gender === 'string' && GENDER[gender]))
    throw new Error('BAD_DRAFT options.gender_tendency male/female/all')
  if (draft.categories?.length) throw new Error('BAD_DRAFT categories 없음 (hashtags만)')
  const tags = draft.hashtags ?? []
  if (tags.length > LIMITS.hashtags || tags.some((t) => !t.trim() || t.length > LIMITS.hashtag))
    throw new Error('BAD_DRAFT hashtags 10개 이하, 각 10자 이하')
  const starts = draft.startScenarios ?? []
  for (const s of starts) noStartExtras(s)
  const intros = starts.length
    ? starts.map((s) => ({
        name: s.title ?? '',
        content: s.content ?? '',
        prompt: s.subPrompt ?? '',
        promptMaxTurn: null,
        bgmAudioId: null,
        recommends: []
      }))
    : [
        {
          name: '기본 인트로',
          content: '',
          prompt: '',
          promptMaxTurn: null,
          bgmAudioId: null,
          recommends: []
        }
      ]
  const w: Obj = {
    // 편집기 새 폼 기본값 (80546 L)
    title: draft.title,
    description: draft.subtitle ?? '',
    detailDescription: draft.description ?? '',
    prompt: draft.main,
    intros,
    isAdult: draft.adult,
    publishStatus: PUBLISH_STATUS.private,
    genderTendency: typeof gender === 'string' ? GENDER[gender] : undefined,
    allowComment: true,
    imagePromptEnabled: true,
    creatorStyleEnabled: false,
    playGuide: '',
    recommendedLlmModelId: null,
    isDerivativeWork: false,
    hashtags: tags,
    images: [],
    audios: [],
    lorebooks: (draft.lorebook ?? []).map((e) => loreFrom(e, undefined)),
    lorebookFolders: [],
    skills: [],
    // 새 폼은 업적을 불러온 것으로 본다 (achievementsLoaded true) → 빈 목록을 보낸다
    achievements: [],
    dice: [],
    jsx: [],
    notepad: ''
  }
  checkFields(w)
  checkIntros(intros)
  checkLorebook(list(w.lorebooks))
  return uumaiSaveBody(w, { isPublish: false })
}
