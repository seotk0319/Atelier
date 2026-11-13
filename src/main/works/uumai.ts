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
import { matchOld } from './match-old'
import type {
  LoreEntry,
  WorkAdapter,
  WorkBody,
  WorkDraft,
  WorkFeature,
  WorkListItem
} from './types'
import { feature, keyList } from './shared'

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

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
/** before를 주면 그 원본과 값이 달라진 칸만 검사한다 (손대지 않은 옛 값은 사이트가 받아 주던 그대로 보낸다) */
function checkFields(w: Obj, before?: Obj): void {
  for (const [name, key] of Object.entries(FIELDS)) {
    if (before && same(before[key], w[key])) continue
    const max = LIMITS[key as keyof typeof LIMITS]
    if (text(w[key]).length > max) throw new Error('BAD_FIELD ' + name + ' ~' + max + '자')
  }
}

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
        // bgmStop은 새 항목에 넣지 않는다 (편집기는 거짓이면 칸을 보내지 않는다)
        folderId: null
      }
  if (entry.title !== undefined) out.name = entry.title
  if (entry.content !== undefined) out.content = entry.content
  // 전체 교체에서 호출한 쪽이 키워드를 적지 않았으면(given에 keys 없음) 옛 항목의 값을 그대로 둔다
  const keysGiven = entry.given === undefined || entry.given.includes('keys')
  // 읽을 때 키워드를 ', '로 이어 붙이므로 쉼표가 든 키워드는 되읽으면 쪼개진다. 읽은 그대로면 원본 값을 둔다
  if (
    entry.keys !== undefined &&
    keysGiven &&
    !(base && entry.keys === strings(base.keywords).join(', '))
  )
    out.keywords = keyList(entry.keys)
  // 전체 교체에서 호출한 쪽이 제외 키워드를 적지 않았으면(given에 offKeys 없음) 옛 항목의 값을 그대로 둔다
  const offKeysGiven = entry.given === undefined || entry.given.includes('offKeys')
  if (
    entry.offKeys !== undefined &&
    offKeysGiven &&
    !(base && same(entry.offKeys, strings(base.notKeywords)))
  )
    out.notKeywords = entry.offKeys.map((k) => k.trim()).filter(Boolean)
  if (entry.mode !== undefined && entry.mode !== null) {
    if (entry.mode !== 'keyword' && entry.mode !== 'always') throw new Error('BAD_LOREBOOK mode')
    out.isConstant = entry.mode === 'always'
  }
  if (entry.turnRange !== undefined && entry.turnRange !== null) out.scanTurns = entry.turnRange
  return out
}
/**
 * before(고치기 전 로어북)를 주면 새로 생겼거나 값이 달라진 칸만 검사한다. 개수는 늘어났을 때만 본다.
 * 같은 항목은 번호(id)로 짝짓는다.
 */
function checkLorebook(lores: Obj[], before: Obj[] = []): void {
  if (lores.length > LIMITS.lorebooks && lores.length > before.length)
    throw new Error('LOREBOOK_LIMIT')
  const prevs = new Map(before.filter((e) => text(e.id)).map((e) => [text(e.id), e]))
  for (const [i, e] of lores.entries()) {
    const prev = prevs.get(text(e.id))
    const changed = (...keys: string[]): boolean => !prev || keys.some((k) => !same(prev[k], e[k]))
    const where = 'BAD_LOREBOOK lorebook[' + i + ']'
    if (changed('name') && text(e.name).length > LIMITS.loreName)
      throw new Error(where + '.title ~30자')
    if (changed('content') && text(e.content).length > LIMITS.loreContent)
      throw new Error(where + '.content ~10000자')
    const keys = strings(e.keywords)
    if (
      changed('keywords') &&
      (keys.length > LIMITS.loreKeywords || keys.some((k) => k.length > LIMITS.loreKeyword))
    )
      throw new Error(where + '.keys 50개 이하, 각 20자 이하')
    const not = strings(e.notKeywords)
    if (
      changed('notKeywords') &&
      (not.length > LIMITS.loreNot || not.some((k) => k.length > LIMITS.loreKeyword))
    )
      throw new Error(where + '.off_keys 5개 이하, 각 20자 이하')
    const scan = e.scanTurns
    if (
      changed('scanTurns') &&
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
/**
 * prevs[i]는 intros[i]의 고치기 전 모습(새 인트로는 undefined). 주면 새로 생겼거나 값이 달라진 칸만 검사한다.
 * 개수 상한은 고치기 전보다 늘어났을 때만 본다.
 */
function checkIntros(intros: Obj[], prevs: (Obj | undefined)[] = [], beforeCount = 0): void {
  if (intros.length < 1 || (intros.length > LIMITS.intros && intros.length > beforeCount))
    throw new Error('START_LIMIT')
  for (const [i, s] of intros.entries()) {
    const prev = prevs[i]
    const changed = (key: string): boolean => !prev || !same(prev[key], s[key])
    const where = 'BAD_START start_scenarios[' + i + ']'
    if (changed('name') && text(s.name).length > LIMITS.introName)
      throw new Error(where + '.title ~50자')
    if (changed('content') && text(s.content).length > LIMITS.introContent)
      throw new Error(where + '.content ~5000자')
    if (changed('prompt') && text(s.prompt).length > LIMITS.introPrompt)
      throw new Error(where + '.sub_prompt ~5000자')
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

const NONE = (note: string): WorkFeature => feature('no', 'no', 'no', 'no', note)

const FEATURES: Record<string, WorkFeature> = {
  title: feature('yes', 'yes', 'yes', 'yes', '20자 한도, 바꾼 칸만 검사'),
  description: feature('yes', 'yes', 'yes', 'yes', '짧은 소개 1만자·상세 소개 10만자'),
  main_prompt: feature('yes', 'yes', 'yes', 'yes', '50,000자 한도'),
  first_message: feature('yes', 'yes', 'yes', 'yes', '인트로 내용이 첫 글, 5,000자'),
  start_scenarios: feature('yes', 'partial', 'partial', 'yes', '1~10개, 추천응답·적용 턴은 개수만 읽음'),
  lorebook: feature('yes', 'partial', 'partial', 'partial', '300개, 고급 칸은 읽지 못하고 값만 보존'),
  characters: NONE('캐릭터 칸 없음, 작품 하나에 프롬프트 하나'),
  example_dialogue: NONE('전용 칸 없음, 메인에 씀'),
  user_persona: NONE('전용 칸 없음, 메인에 씀'),
  output_rules: NONE('전용 칸 없음, 메인·로어북에 씀'),
  situation_images: feature('yes', 'yes', 'partial', 'partial', '추가·빼기·순서만, 참조키는 5자'),
  cover: feature('yes', 'yes', 'yes', 'yes', '바꾸기만, 삭제 불가, 10MB'),
  tags: feature('yes', 'yes', 'partial', 'partial', '해시태그 10개, 새 작품 때만 입력'),
  visibility: feature('yes', 'yes', 'partial', 'partial', '바꾸면 발행됨, 발행본 있고 같은 값이면 무시'),
  create_work: feature('yes', 'yes', 'yes', 'yes', '비공개 초안으로 생성'),
  delete_work: feature('yes', 'yes', 'yes', 'yes', '2단계 확인, 막힌 작품은 사이트에서'),
  versioning_review: feature('yes', 'partial', 'partial', 'no', '초안·발행 구분만, 심사는 모름'),
  language_editions: NONE('언어 판본 없음'),
  bgm_voice: feature('yes', 'partial', 'no', 'no', '개수만 읽고 값은 그대로 유지'),
  jsx_html: feature('yes', 'yes', 'yes', 'yes', 'jsx: 칸, 20개, 저장 때 컴파일'),
  model_settings: feature('yes', 'yes', 'no', 'partial', '추천 모델·이미지 프롬프트는 읽기만'),
  comments_stats: feature('yes', 'partial', 'no', 'no', '댓글 허용만 읽음, 수치는 알림 수집')
}

/** 이 연결부가 값을 읽지 못하는 사이트 설정 (extras에는 개수·길이만 싣는다) */
const UNSUPPORTED = [
  '로어북 고급 설정',
  '로어북 폴더',
  '인트로 추천 응답·적용 턴·BGM',
  '스킬',
  'BGM·오디오',
  '주사위',
  '업적',
  '메모장',
  '댓글·좋아요·채팅 수',
  '수익·공개 제한 설정'
]

const GENDER_NAME: Record<number, string> = { 1: 'male', 2: 'female', 3: 'all' }
const EXTRA_TEXT = 80
const EXTRA_LIST = 20

/**
 * 공통 칸에 들지 않는 우마이 설정을 짧게 옮긴다. 원본에 그 칸이 있을 때만 싣고, 작품 글·주소·계정 값은 싣지 않는다.
 * 조회 수처럼 읽을 때마다 달라지는 값은 계획 뒤 변화 검사(PLAN_STALE)를 깨므로 싣지 않는다.
 */
function uumaiExtras(r: UumaiRaw): Record<string, unknown> {
  const w = r.work
  const out: Record<string, unknown> = {}
  const flag = (key: string, name: string): void => {
    if (typeof w[key] === 'boolean') out[name] = w[key]
  }
  const count = (key: string, name: string): void => {
    if (Array.isArray(w[key])) out[name] = (w[key] as unknown[]).length
  }
  if (Array.isArray(w.hashtags)) {
    const tags = strings(w.hashtags)
    if (tags.length <= EXTRA_LIST && tags.every((t) => t.length <= EXTRA_TEXT)) out.hashtags = tags
    else out.hashtag_count = tags.length
  }
  flag('isAdult', 'is_adult')
  if (typeof w.genderTendency === 'number')
    out.gender_tendency = GENDER_NAME[w.genderTendency] ?? w.genderTendency
  flag('allowComment', 'allow_comment')
  flag('imagePromptEnabled', 'image_prompt_enabled')
  flag('creatorStyleEnabled', 'creator_style_enabled')
  flag('isDerivativeWork', 'is_derivative_work')
  if (typeof w.recommendedLlmModelId === 'number')
    out.recommended_llm_model_id = w.recommendedLlmModelId
  out.has_cover = isObj(w.thumbnail) && !!(text(w.thumbnail.imageId) || text(w.thumbnail.url))
  if (isObj(w.bgmCover)) out.has_bgm_cover = !!text(w.bgmCover.imageId)
  if (typeof w.blindStatus === 'number') out.blind_status = w.blindStatus
  if (strOrNull(w.createdAt)) out.created_at = text(w.createdAt).slice(0, EXTRA_TEXT)
  out.has_published_version = !!r.publishedSnapshotId
  out.has_unpublished_draft = uumaiPendingDraft(r)

  count('intros', 'intro_count')
  count('lorebooks', 'lorebook_count')
  count('lorebookFolders', 'lorebook_folder_count')
  count('images', 'image_count')
  count('audios', 'audio_count')
  count('skills', 'skill_count')
  count('dice', 'dice_count')
  count('achievements', 'achievement_count')
  count('jsx', 'jsx_count')
  if (typeof w.notepad === 'string') out.notepad_length = w.notepad.length

  const intros = list(w.intros)
  if (Array.isArray(w.intros)) {
    out.intro_recommend_count = intros.reduce(
      (n, e) => n + strings(e.recommends).filter((s) => s.trim() !== '').length,
      0
    )
    out.intro_max_turn_count = intros.filter((e) => typeof e.promptMaxTurn === 'number').length
    out.intro_bgm_count = intros.filter((e) => !!strOrNull(e.bgmAudioId)).length
  }
  if (Array.isArray(w.lorebooks)) {
    const lores = list(w.lorebooks)
    out.lorebook_activate_on_intro_count = lores.filter((l) => l.activateOnIntro === true).length
    out.lorebook_and_keyword_count = lores.filter((l) => strings(l.andKeywords).length > 0).length
    out.lorebook_dependency_count = lores.filter((l) => strings(l.dependsOnIds).length > 0).length
    // 적용 인트로를 일부로 좁힌 항목 (번호를 적지 않았거나 모든 인트로를 적었으면 전체 인트로다)
    out.lorebook_intro_limited_count = lores.filter((l) => {
      if (!Array.isArray(l.introSequences)) return false
      const listed = new Set(
        (l.introSequences as unknown[]).filter(
          (n): n is number => typeof n === 'number' && n >= 0 && n < intros.length
        )
      )
      return listed.size > 0 && listed.size < intros.length
    }).length
  }
  return out
}

export const uumaiWorks: WorkAdapter = {
  id: 'uumai',
  // 서버가 저장하지 않는 순서 번호 (2026-11-13 실제 저장에서 확인)
  rawIgnore: [/^work\.lorebooks\[[^\]]*\]\.order$/],
  label: '우마이',
  features: FEATURES,
  guide: {
    save: '저장은 늘 초안(임시저장)이다. 이미 발행한 작품은 발행본이 그대로이고, 지금과 다른 visibility를 주면 그때 발행되며 초안 내용도 같이 나간다(발행본이 있고 같은 값이면 무시).',
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
      characters: [],
      extras: uumaiExtras(r),
      unsupported: [...UNSUPPORTED]
    }
  },

  applyChanges(raw, changes) {
    const r = uumaiRaw(raw)
    const next = structuredClone(raw) as UumaiRaw & { publish?: boolean }
    const w = next.work

    if (changes.visibility !== undefined) {
      const status = PUBLISH_STATUS[changes.visibility]
      if (!status) throw new Error('BAD_VISIBILITY')
      // 발행본이 있는 작품에 지금과 같은 값을 주면 아무것도 하지 않는다. 발행하면 계획에 안 보이는 초안 전체가 독자에게 나간다
      if (!(r.publishedSnapshotId && uumaiVisibility(r.work) === changes.visibility)) {
        w.publishStatus = status
        // 편집기에서 공개 여부는 '작품 등록(발행)'을 눌러야 반영된다. 그래서 공개 상태를 바꾸면 발행한다.
        next.publish = true
      }
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
          // 개수는 파일을 새로 더할 때만 본다 (이미 있는 파일을 고치는 것은 개수를 늘리지 않는다)
          if (at < 0 && all.length > JSX_MAX_FILES) throw new Error('BAD_JSX count')
          w.jsx = all
        }
        continue
      }
      const key = FIELDS[name]
      if (!key) throw new Error('BAD_FIELD')
      w[key] = value
      fieldsChanged = true
    }
    if (fieldsChanged) checkFields(w, r.work)

    const folders = list(w.lorebookFolders)
    let lores = arrangeLorebooks(list(w.lorebooks), folders)
    const loreBefore = JSON.stringify(lores)
    const loresOld = [...lores]
    if (changes.lorebook) {
      // 번호·숨은 설정은 제목이 같은 옛 항목에서 물려받는다 (자리 번호로 잇지 않는다). 짝이 없는 항목은 새 항목이다
      const paired = matchOld(
        changes.lorebook.map((e) => e.title),
        loresOld,
        (l) => text(l.name),
        // 제목이 겹치는 항목이 있어 내용까지 견줘 짝짓는다 (2026-11-13 실제 스냅샷에서 겹침 확인)
        { contents: changes.lorebook.map((e) => e.content), contentOf: (l) => text(l.content) }
      )
      lores = changes.lorebook.map((e, i) => loreFrom(e, paired[i]))
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

    const introsOld = list(w.intros)
    let intros = [...introsOld]
    const introsBefore = JSON.stringify(intros)
    // intros[i]가 고치기 전 몇 번째 인트로였는지 (새 인트로는 null). 바뀐 칸만 검사하려고 따라간다
    let origin: (number | null)[] = intros.map((_, i) => i)
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
        origin = origin.filter((_, n) => n !== i)
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
      origin.push(null)
    }
    if (JSON.stringify(intros) !== introsBefore) {
      checkIntros(
        intros,
        origin.map((o) => (o === null ? undefined : introsOld[o])),
        introsOld.length
      )
      w.intros = intros
    }
    const arranged = arrangeLorebooks(lores, folders)
    if (JSON.stringify(arranged) !== loreBefore) {
      checkLorebook(arranged, loresOld)
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
