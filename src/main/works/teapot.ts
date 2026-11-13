// 티팟 작품 본문 읽기·임시저장. 주소와 필드는 2026-11-10 teapotchat.com 공개 스크립트에서 읽었다 (실제 호출 전).
// 편집기(/creator/character?cid={작품}&cpid={저장 파일})는 작품을 저장 파일(체크포인트) 단위로 다룬다:
//   열기   listCheckpoints → 저장 파일 목록 (최신 순 정렬 뒤 첫 번째, cpid가 있으면 그것) → getCheckpoint로 snapshot
//   임시저장 지금 파일이 제출 전 수동 파일이면 updateCheckpoint, 아니면(등록완료·심사중·반려·자동저장) createCheckpoint
//   등록   submitCharacter {draftId, checkpointId, characterData} → 심사(PENDING) → 등록(ACCEPTED)
//   삭제   deleteNewCharacter {characterId} (작품 관리 화면의 삭제)
//   새 작품 createDraft {} → {draftId}
// 이 연결부의 save는 "임시저장"만 한다. 저장 파일이 바뀔 뿐 실제 서비스 중인 작품·공개도는 그대로이고,
// 반영하려면 사이트에서 그 저장 파일을 등록(심사)해야 한다. submitCharacter는 편집기가 템플릿으로 계산하는
// prompt_char_count를 같이 보내야 해 같은 값을 만들 수 없어 부르지 않는다.
// 공개도(publicity)도 저장 파일 안의 값이라 등록해야 바뀐다 → visibility 바꾸기는 막는다.
// 이미지: 사이트는 Firebase Storage(버킷 chat-ai-7a275.firebasestorage.app, 경로 users/{uid}/character_images/main/
// {uuid}.{확장자})에 multipart로 올리고 "Authorization: Firebase {토큰}"을 쓴다. 공용 send 통로는 Bearer만 붙여
// 올리기는 만들지 않았다 (imageGroups 읽기만).
// 글 칸: title=char_name(제목 30), subtitle=oneline_description(한 줄 소개 35), description=detail_description
//   (캐릭터 소개 1000), main=prompt(메인 프롬프트), worldview, secret, output_format=output_format_prompt,
//   recommended_answer_prompt(추천 답변 프롬프트). 저장 파일에 있는 칸만 보여 준다.
// 로어북 = keyword_books[{title, keys[], info, indexLabel}], 시작 상황 = start_settings[], 캐릭터 = characters[].
import { randomUUID } from 'node:crypto'
import {
  ID_RE,
  LIST_COLLECTIONS,
  READ_FUNCTIONS,
  TEAPOT_IMAGE_RULES,
  WRITE_FUNCTIONS,
  FUNCTIONS,
  accountUid,
  at,
  callRead,
  callWrite,
  cpStatus,
  isAuto,
  isObj,
  isoTime,
  list,
  listQuery,
  listReadAllowed,
  listUrl,
  readBodyAllowed,
  runQueryDocs,
  strOrNull,
  strings,
  teapotVisibility,
  teapotWorkId,
  text,
  timeOf,
  type Obj,
  type TeapotAccount
} from './teapot-core'
import { matchOld } from './match-old'
import type {
  ImageGroup,
  LoreEntry,
  StartScenarioDraft,
  WorkAdapter,
  WorkBody,
  WorkChanges,
  WorkFeature,
  WorkDraft,
  WorkFetch,
  WorkListItem,
  WorkWrite
} from './types'

export type { TeapotAccount } from './teapot-core'

// 편집기 입력 규칙 (86701·97915 모듈, 설정 화면 maxLength)
const LIMITS = {
  title: 30,
  subtitle: 35,
  description: 1000,
  recommendedAnswer: 1000,
  loreEntries: 500,
  loreTitle: 60,
  loreInfo: 2500,
  loreKeys: 10,
  loreKey: 50,
  startName: 20,
  startCircumstance: 500,
  startMessage: 3000,
  startPrompt: 100_000,
  checkpoints: 49
}
const FIELDS: Record<string, string> = {
  title: 'char_name',
  subtitle: 'oneline_description',
  description: 'detail_description',
  main: 'prompt',
  worldview: 'worldview',
  secret: 'secret',
  output_format: 'output_format_prompt',
  recommended_answer_prompt: 'recommended_answer_prompt'
}
const FIELD_MAX: Record<string, number> = {
  char_name: LIMITS.title,
  oneline_description: LIMITS.subtitle,
  detail_description: LIMITS.description,
  recommended_answer_prompt: LIMITS.recommendedAnswer
}

/** 읽은 작품 원본: 고른 저장 파일 하나와 그 snapshot, 그리고 저장 파일 목록 */
export interface TeapotRaw {
  id: string
  source: 'checkpoint'
  /** listCheckpoints 응답의 저장 파일 요약들 (받은 그대로) */
  checkpoints: Obj[]
  /** 고른 저장 파일 (snapshot 뺌). id가 null이면 저장할 때 새 저장 파일을 만든다 */
  checkpoint: Obj
  snapshot: Obj
}
function teapotRaw(raw: unknown): TeapotRaw {
  if (
    !isObj(raw) ||
    raw.source !== 'checkpoint' ||
    !ID_RE.test(text(raw.id)) ||
    !isObj(raw.checkpoint) ||
    !isObj(raw.snapshot) ||
    !Array.isArray(raw.checkpoints)
  )
    throw new Error('WORK_SHAPE')
  return raw as unknown as TeapotRaw
}

/** 편집기처럼 최신 저장 파일을 고른다 (time_saved 내림차순, 같으면 받은 순서) */
function newest(checkpoints: Obj[]): Obj | null {
  const valid = checkpoints.filter((c) => ID_RE.test(text(c.id)))
  return (
    valid
      .map((c, i) => ({ c, i }))
      .sort((a, b) => timeOf(b.c.time_saved) - timeOf(a.c.time_saved) || a.i - b.i)[0]?.c ?? null
  )
}

const status = (cp: Obj): string => cpStatus(cp.cp_status) ?? 'DRAFT'

// ── 숨은 설정(extras) ──
// 짧은 값은 그대로, 긴 글은 <이름>_length, 목록은 개수만 싣는다. 작품 본문·계정 정보·주소는 싣지 않는다.
// 조회 수 같은 통계는 읽을 때마다 달라져 계획이 낡은 것으로 보이므로 싣지 않는다.
const SHORT_TEXT = 80
const SHORT_LIST = 20
function putText(out: Obj, name: string, v: unknown): void {
  if (typeof v !== 'string') return
  if (v.length <= SHORT_TEXT) out[name] = v
  else out[name + '_length'] = v.length
}
function putStrings(out: Obj, name: string, v: unknown): void {
  if (!Array.isArray(v)) return
  const items = strings(v)
  if (items.length === v.length && items.length <= SHORT_LIST && items.every((t) => t.length <= SHORT_TEXT))
    out[name] = items
  else out[name + '_count'] = v.length
}
function putCount(out: Obj, name: string, v: unknown): void {
  if (Array.isArray(v)) out[name] = v.length
}
const filled = (v: unknown): boolean =>
  typeof v === 'string' || Array.isArray(v)
    ? v.length > 0
    : isObj(v)
      ? Object.keys(v).length > 0
      : v !== null && v !== undefined

/** 저장 파일 snapshot과 저장 파일 목록에서 공통 칸에 들지 않는 설정을 뽑는다 */
function teapotExtras(r: TeapotRaw): Obj {
  const s = r.snapshot
  const out: Obj = {}
  putStrings(out, 'genre', s.genre)
  putStrings(out, 'hashtags', s.hash_tags)
  putText(out, 'target', s.target)
  if (typeof s.is_nsfw === 'boolean') out.is_nsfw = s.is_nsfw
  if (typeof s.image === 'string') out.has_cover_image = s.image !== ''
  putText(out, 'template', s.template)
  putText(out, 'template_version', s.template_version)
  putText(out, 'prompt_mode', s.prompt_mode)
  putText(out, 'model', s.model)
  putText(out, 'conv_type', s.conv_type)
  if (typeof s.max_output_token === 'number') out.max_output_tokens = s.max_output_token
  if (typeof s.prompt_char_count === 'number') out.prompt_char_count = s.prompt_char_count
  if ('prompt_template_overrides' in s) out.has_prompt_template_overrides = filled(s.prompt_template_overrides)
  if ('worldview_id' in s) out.worldview_linked = filled(s.worldview_id)
  putCount(out, 'guideline_count', s.guidelines)
  putCount(out, 'user_note_count', s.player_note)
  putCount(out, 'persona_count', s.personas)
  putCount(out, 'example_dialogue_count', s.example_dialogues)
  putCount(out, 'situation_image_count', s.circumstance_images)
  putCount(out, 'jsx_component_count', s.jsx_components)
  putCount(out, 'command_count', s.commands)
  const starts = list(s.start_settings).filter((st) => Array.isArray(st.recommended_answers))
  if (starts.length)
    out.start_recommended_answer_count = starts.reduce(
      (n, st) => n + (st.recommended_answers as unknown[]).length,
      0
    )
  // 저장 파일 목록: 개수와, 가장 최근에 제출한 파일의 심사 결과 (저장·심사로만 바뀐다)
  out.checkpoint_count = r.checkpoints.filter((c) => ID_RE.test(text(c.id))).length
  const submitted = r.checkpoints
    .filter((c) => isoTime(c.submitted_at) !== null)
    .map((c, i) => ({ c, i }))
    .sort((a, b) => timeOf(b.c.submitted_at) - timeOf(a.c.submitted_at) || a.i - b.i)[0]?.c
  if (submitted) {
    out.last_submitted_at = isoTime(submitted.submitted_at)
    if (isObj(submitted.review_result)) putText(out, 'last_review_status', submitted.review_result.status)
  }
  return out
}

/** 사이트에는 있는데 이 연결부가 읽지 못해 비어 보이는 것 */
const UNSUPPORTED = [
  '시작 상황 부가 칸(세계관·비밀·출력 형식)',
  '추천 답변 내용',
  '예시 대화 내용',
  '가이드라인·유저노트·페르소나 내용',
  'JSX 컴포넌트',
  '시리즈·댓글 허용 설정',
  '독점·수익 설정',
  '댓글·좋아요·대화 통계',
  '이전 저장 파일'
]

const FEATURES: Record<string, WorkFeature> = {
  title: { site: 'yes', read: 'yes', write: 'yes', verified: 'partial', note: '30자. 읽기만 실측' },
  description: {
    site: 'yes',
    read: 'yes',
    write: 'yes',
    verified: 'partial',
    note: '한 줄 35자, 소개 1,000자'
  },
  main_prompt: {
    site: 'yes',
    read: 'yes',
    write: 'yes',
    verified: 'partial',
    note: '칸 한도 검사 없음(전체 400,000자)'
  },
  first_message: {
    site: 'yes',
    read: 'yes',
    write: 'yes',
    verified: 'partial',
    note: '시작 상황별 3,000자, HTML 가능'
  },
  start_scenarios: {
    site: 'yes',
    read: 'yes',
    write: 'yes',
    verified: 'partial',
    note: '이름 20자, 설명 500자. 추가·삭제 미확인'
  },
  lorebook: {
    site: 'yes',
    read: 'yes',
    write: 'yes',
    verified: 'partial',
    note: '500개, 본문 2,500자. 발동 방식 칸 없음'
  },
  characters: {
    site: 'yes',
    read: 'yes',
    write: 'yes',
    verified: 'no',
    note: '이름·설명만. 이미지는 사이트에서 직접'
  },
  example_dialogue: {
    site: 'yes',
    read: 'partial',
    write: 'no',
    verified: 'no',
    note: '개수만 읽음. 내용은 사이트에서 직접'
  },
  user_persona: {
    site: 'yes',
    read: 'partial',
    write: 'no',
    verified: 'no',
    note: '페르소나 5개 한도. 개수만 읽음'
  },
  output_rules: {
    site: 'yes',
    read: 'yes',
    write: 'yes',
    verified: 'partial',
    note: 'output_format_prompt. 한도 검사 없음'
  },
  situation_images: {
    site: 'yes',
    read: 'partial',
    write: 'no',
    verified: 'no',
    note: '목록만 읽음. 올리기는 사이트에서 직접'
  },
  cover: {
    site: 'yes',
    read: 'yes',
    write: 'no',
    verified: 'partial',
    note: '1:1, 5MB. 올리기는 사이트에서 직접'
  },
  tags: {
    site: 'yes',
    read: 'yes',
    write: 'partial',
    verified: 'partial',
    note: '해시태그 10개·20자(검사 안 함). 새 작품에만 씀'
  },
  visibility: {
    site: 'yes',
    read: 'yes',
    write: 'blocked',
    verified: 'yes',
    note: '저장 파일 값이라 등록해야 반영돼 막음'
  },
  create_work: {
    site: 'yes',
    read: 'yes',
    write: 'yes',
    verified: 'partial',
    note: '비공개 초안만. 장르·표지는 못 넣음'
  },
  delete_work: {
    site: 'yes',
    read: 'no',
    write: 'yes',
    verified: 'partial',
    note: '등록작 삭제 영향 미확인'
  },
  versioning_review: {
    site: 'yes',
    read: 'partial',
    write: 'blocked',
    verified: 'partial',
    note: '임시저장만. 등록·심사는 사이트에서 직접'
  },
  language_editions: {
    site: 'no',
    read: 'no',
    write: 'no',
    verified: 'yes',
    note: '사이트에 없음'
  },
  bgm_voice: {
    site: 'no',
    read: 'no',
    write: 'no',
    verified: 'no',
    note: '제작 단계 탭에 없음(추정)'
  },
  jsx_html: {
    site: 'yes',
    read: 'partial',
    write: 'partial',
    verified: 'no',
    note: 'JSX는 못 다룸. HTML은 시작 메시지 글로'
  },
  model_settings: {
    site: 'yes',
    read: 'yes',
    write: 'no',
    verified: 'partial',
    note: '읽기 전용. 새 작품은 general·simple 고정'
  },
  comments_stats: {
    site: 'yes',
    read: 'no',
    write: 'no',
    verified: 'no',
    note: '작품 MCP는 안 읽음. 알림 탭에서만'
  }
}

// ── 로어북 ──

const keyList = (keys: string): string[] => [
  ...new Set(
    keys
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean)
  )
]
/** 공통 로어북 항목 → 티팟 keyword_book. 발동 방식·제외 키·턴 값은 티팟에 없다 */
function loreFrom(entry: Partial<LoreEntry>, base: Obj | undefined): Obj {
  if (
    (entry.mode !== undefined && entry.mode !== null) ||
    (entry.turnRange !== undefined && entry.turnRange !== null) ||
    (entry.offTurnRange !== undefined && entry.offTurnRange !== null) ||
    (entry.offKeys !== undefined && entry.offKeys.length > 0)
  )
    throw new Error('BAD_CHANGES')
  const out: Obj = base ? { ...base } : { title: '', keys: [], info: '' }
  if (entry.title !== undefined) out.title = entry.title
  // 보여 준 글(쉼표로 이은 키)이 그대로면 원본 키 목록을 그대로 둔다 (키 안의 쉼표·공백·중복이 쪼개지거나 다듬어지지 않게)
  // 전체 교체에서 호출한 쪽이 keys를 안 줬으면(given에 없음) 옛 항목의 키를 그대로 둔다 (whole()이 채운 ''로 지우지 않는다)
  const keysGiven = entry.given === undefined || entry.given.includes('keys')
  const same =
    !!base && Array.isArray(base.keys) && entry.keys === strings(base.keys).join(', ')
  if (entry.keys !== undefined && (keysGiven || !base) && !same) out.keys = keyList(entry.keys)
  if (entry.content !== undefined) out.info = entry.content
  return out
}
/** 비교용 모양. 자리 번호(indexLabel)는 항목을 옮기면 바뀌므로 뺀다 */
const shapeOf = (o: Obj): string => JSON.stringify({ ...o, indexLabel: undefined })
/** 옛 목록에 그대로 있던 항목(자리만 옮긴 것 포함)을 뺀, 바뀌었거나 새로 생긴 항목의 자리들 */
function touched(now: Obj[], before: Obj[]): number[] {
  const left = new Map<string, number>()
  for (const o of before) left.set(shapeOf(o), (left.get(shapeOf(o)) ?? 0) + 1)
  return now.flatMap((o, i) => {
    const k = shapeOf(o)
    const n = left.get(k) ?? 0
    if (n > 0) {
      left.set(k, n - 1)
      return []
    }
    return [i]
  })
}
/** 옛 목록 어딘가에 이미 있던 값인지 (사이트가 받아 주던 값이라 한도 밖이어도 막지 않는다) */
const seenIn = (before: Obj[], key: string, value: string): boolean =>
  before.some((o) => text(o[key]) === value)
/**
 * 바뀌었거나 새로 더한 항목 안에서도 값이 바뀐 칸만 검사한다.
 * 손대지 않은 옛 값(같은 항목의 다른 칸을 고쳤을 때 딸려 오는 한도 밖 옛 값 포함)은 사이트가 받아 주던 값 그대로 보낸다.
 */
function checkLorebook(books: Obj[], before: Obj[]): void {
  if (books.length > LIMITS.loreEntries && books.length > before.length)
    throw new Error('LOREBOOK_LIMIT')
  const oldKeys = new Set(before.flatMap((o) => strings(o.keys)))
  const oldKeyCount = Math.max(0, ...before.map((o) => strings(o.keys).length))
  const oldKeyLists = new Set(before.map((o) => JSON.stringify(strings(o.keys))))
  for (const i of touched(books, before)) {
    const b = books[i]
    const where = 'lorebook[' + i + ']'
    const title = text(b.title)
    if (title.length > LIMITS.loreTitle && !seenIn(before, 'title', title))
      throw new Error('BAD_LOREBOOK ' + where + '.title ~' + LIMITS.loreTitle + '자')
    const info = text(b.info)
    if (info.length > LIMITS.loreInfo && !seenIn(before, 'info', info))
      throw new Error('BAD_LOREBOOK ' + where + '.content ~' + LIMITS.loreInfo + '자')
    const keys = strings(b.keys)
    if (oldKeyLists.has(JSON.stringify(keys))) continue
    if (
      (keys.length > LIMITS.loreKeys && keys.length > oldKeyCount) ||
      keys.some((k) => k.length > LIMITS.loreKey && !oldKeys.has(k))
    )
      throw new Error('BAD_LOREBOOK ' + where + '.keys 10개 이하, 각 50자 이하')
  }
}
/** 편집기 setKeywordBooks처럼 indexLabel을 자리 번호(1부터)로 다시 매긴다 */
const relabel = (books: Obj[]): Obj[] => books.map((b, i) => ({ ...b, indexLabel: i + 1 }))

// ── 시작 상황 ──

// 편집기 새 시작 상황 기본값 (64408 모듈 p)
const START_DEFAULT: Obj = {
  setting_name: '',
  start_circumstance: '',
  start_message: '',
  recommended_answers: [],
  additional_prompt: '',
  additional_worldview: '',
  additional_secret: '',
  additional_example_dialogues: [],
  additional_output_format: ''
}
type StartPatch = StartScenarioDraft
/** 공통 시작 상황 → start_setting. 대사·설명 칸은 티팟에 따로 없다 */
function startFrom(patch: StartPatch, base: Obj): Obj {
  for (const key of ['dialogue', 'description'] as const)
    if (patch[key] !== undefined && patch[key] !== '') throw new Error('BAD_CHANGES')
  const out = { ...base }
  if (patch.title !== undefined) out.setting_name = patch.title
  if (patch.content !== undefined) out.start_message = patch.content
  if (patch.situation !== undefined) out.start_circumstance = patch.situation
  if (patch.subPrompt !== undefined) out.additional_prompt = patch.subPrompt
  return out
}
function checkStarts(starts: Obj[], before: Obj[]): void {
  if (starts.length < 1) throw new Error('START_LIMIT')
  for (const i of touched(starts, before)) {
    const s = starts[i]
    const where = 'start_scenarios[' + i + ']'
    const over = (key: string, max: number, name: string): void => {
      // 손대지 않은 옛 값은 한도 밖이어도 막지 않는다 (같은 시작 상황의 다른 칸만 고친 경우)
      if (text(s[key]).length > max && !seenIn(before, key, text(s[key])))
        throw new Error('BAD_START ' + where + '.' + name + ' ~' + max + '자')
    }
    over('setting_name', LIMITS.startName, 'title')
    over('start_circumstance', LIMITS.startCircumstance, 'situation')
    over('start_message', LIMITS.startMessage, 'content')
    over('additional_prompt', LIMITS.startPrompt, 'sub_prompt')
  }
}

/** only가 있으면 그 칸만 검사한다 (손대지 않은 칸의 옛 값 때문에 막지 않는다) */
function checkFields(s: Obj, only?: ReadonlySet<string>): void {
  for (const [name, key] of Object.entries(FIELDS)) {
    if (only && !only.has(key)) continue
    const max = FIELD_MAX[key]
    if (s[key] === undefined) continue
    const value = text(s[key])
    if (key === 'char_name' && !value.trim())
      throw new Error('BAD_FIELD title 1~' + LIMITS.title + '자')
    if (max && value.length > max) throw new Error('BAD_FIELD ' + name + ' ~' + max + '자')
  }
}

const manualCount = (checkpoints: Obj[]): number =>
  checkpoints.filter((c) => ID_RE.test(text(c.id)) && !isAuto(c)).length

/** 편집기 snapshot 정리 (48249 모듈 j: characters를 맨 뒤로 옮길 뿐 값은 그대로) */
function snapshotBody(s: Obj): Obj {
  const { characters, ...rest } = s
  return { ...rest, ...(characters !== undefined ? { characters } : {}) }
}

/** 공용 호출부가 읽기 통로에 붙여 둔 계정 번호 함수(teapotAccount)에서 내 사용자 번호를 얻는다 */
async function attachedAccount(read: WorkFetch): Promise<TeapotAccount | undefined> {
  const get = (read as { teapotAccount?: () => Promise<unknown> }).teapotAccount
  const a = typeof get === 'function' ? await get() : null
  return isObj(a) && typeof a.uid === 'string' ? { uid: a.uid } : undefined
}

/** 목록·읽기에 계정 번호를 직접 줄 수도 있는 티팟 연결부 (주지 않으면 읽기 통로에 붙은 값을 쓴다) */
export interface TeapotAdapter extends WorkAdapter {
  list(read: WorkFetch, account?: TeapotAccount): Promise<WorkListItem[]>
  readRaw(read: WorkFetch, workId: string, account?: TeapotAccount): Promise<TeapotRaw>
}

export const teapotWorks: TeapotAdapter = {
  id: 'teapot',
  label: '티팟',
  guide: {
    save: '임시저장(체크포인트)만 된다. 서비스 중인 작품은 바뀌지 않는다.',
    manual: ['등록(심사 제출)', '공개 상태 바꾸기', '이미지 올리기'],
    unverified: [
      '등록된 작품에 임시저장했을 때 사이트 편집기가 여는 파일이 바뀌는지',
      '등록된 작품의 삭제가 공개본까지 지우는지(삭제는 새로 만든 초안에서만 확인했다)'
    ]
  },
  features: FEATURES,
  caseSensitiveIds: true,
  capabilities: ['works_list', 'work_read', 'lorebook', 'start_scenarios', 'characters', 'save'],

  // GET 읽기는 쓰지 않는다 (편집기 읽기도 호출형 함수 POST다)
  readAllowed: () => false,
  readPostAllowed(url, init) {
    if (init.contentType !== 'application/json' || typeof init.body !== 'string') return false
    if (READ_FUNCTIONS.some((n) => url === FUNCTIONS + n)) return readBodyAllowed(url, init.body)
    return listReadAllowed(url, init.body)
  },
  writeAllowed: (method, url) =>
    method === 'POST' && WRITE_FUNCTIONS.some((n) => url === FUNCTIONS + n),

  /**
   * 내 작품 목록 (작품 관리 화면 fetchCreatorHomeCharacterList와 같은 세 조회).
   * 주소에 계정 번호가 들어가 account가 없으면 읽지 못한다 (TEAPOT_UID_REQUIRED).
   */
  async list(read, given) {
    const uid = accountUid(given ?? (await attachedAccount(read)))
    const [drafts, buffers] = await Promise.all(
      LIST_COLLECTIONS.map(async (c) =>
        runQueryDocs(
          await read(listUrl(uid), {
            method: 'POST',
            contentType: 'application/json',
            body: listQuery(c)
          })
        )
      )
    )
    // 버퍼(제출한 적 있는 작품)는 모두, 초안은 저장 파일이 있고 버퍼에 없는 것만 (사이트와 같은 고르기)
    const inBuffer = new Set(buffers.map((d) => d.id))
    const rows = [
      ...buffers.map((d) => {
        const s = text(d.data.status)
        const review =
          s === 'ACCEPT'
            ? 'ACCEPT'
            : s === 'REJECT'
              ? 'REJECT'
              : s === 'PENDING' || s === 'MANUAL'
                ? 'PENDING'
                : null
        return { ...d, review }
      }),
      ...drafts
        .filter((d) => strOrNull(d.data.active_checkpoint_id) && !inBuffer.has(d.id))
        .map((d) => ({ ...d, review: null }))
    ]
    const when = (d: Obj): number => timeOf(d.time_updated) || timeOf(d.time_created)
    rows.sort((a, b) => when(b.data) - when(a.data))
    const seen = new Set<string>()
    const out: WorkListItem[] = []
    for (const r of rows) {
      if (seen.has(r.id)) continue
      seen.add(r.id)
      out.push({
        id: r.id,
        title: text(r.data.char_name),
        visibility: teapotVisibility(r.data.publicity),
        // ACCEPT 등록 / PENDING 심사중 / REJECT 반려 / unregistered 미등록
        status: r.review ?? 'unregistered',
        updatedAt: isoTime(r.data.time_updated) ?? isoTime(r.data.time_created),
        characters: null
      })
    }
    return out
  },

  /** 편집기처럼 저장 파일 목록에서 최신 파일을 골라 그 snapshot을 읽는다 */
  async readRaw(read, id, given) {
    const account = given ?? (await attachedAccount(read))
    const wid = teapotWorkId(id)
    const listed = await callRead(read, 'listCheckpoints', wid)
    if (!isObj(listed) || !Array.isArray(listed.checkpoints) || listed.success === false)
      throw new Error('WORK_SHAPE checkpoints')
    const checkpoints = list(listed.checkpoints)
    const pick = newest(checkpoints)
    if (!pick) throw new Error('TEAPOT_NO_CHECKPOINT')
    const cpId = text(pick.id)
    const got = await callRead(read, 'getCheckpoint', wid, cpId)
    const cp = isObj(got) && isObj(got.checkpoint) ? got.checkpoint : null
    if (!cp || !isObj(cp.snapshot)) throw new Error('WORK_SHAPE checkpoint.snapshot')
    if (cp.id !== undefined && cp.id !== cpId) throw new Error('WORK_SHAPE checkpoint.id')
    const { snapshot, ...meta } = cp
    const owner = text((snapshot as Obj).creator_uid)
    // 계정 번호를 받았으면 저장 파일에 적힌 작가와 같아야 한다
    if (account && owner && owner !== accountUid(account)) throw new Error('NOT_OWNER')
    return {
      id: wid,
      source: 'checkpoint',
      checkpoints,
      checkpoint: { ...pick, ...meta, id: cpId },
      snapshot: snapshot as Obj
    }
  },

  normalize(raw): WorkBody {
    const r = teapotRaw(raw)
    const s = r.snapshot
    const cp = r.checkpoint
    return {
      id: r.id,
      title: text(s.char_name),
      // 저장 파일 안의 공개도 (등록해야 실제로 반영된다)
      visibility: teapotVisibility(s.publicity),
      // 저장 파일 상태: ACCEPTED / PENDING / REJECTED / AUTO_SAVED / DRAFT(제출 전)
      status: status(cp),
      updatedAt: isoTime(cp.time_saved),
      fields: Object.fromEntries(
        Object.entries(FIELDS)
          .filter(([, key]) => typeof s[key] === 'string')
          .map(([name, key]) => [name, text(s[key])])
      ),
      lorebook: list(s.keyword_books).map((b) => ({
        title: text(b.title),
        keys: strings(b.keys).join(', '),
        content: text(b.info),
        mode: null,
        offKeys: [],
        turnRange: null,
        offTurnRange: null
      })),
      startScenarios: list(s.start_settings).map((st, i) => ({
        id: null,
        title: text(st.setting_name),
        isDefault: i === 0,
        content: text(st.start_message),
        subPrompt: text(st.additional_prompt),
        dialogue: '',
        situation: text(st.start_circumstance),
        description: ''
      })),
      characters: list(s.characters).map((c, i) => ({
        id: strOrNull(c._sortKey),
        name: text(c.name),
        isMain: false,
        order: i,
        details: text(c.description),
        info: '',
        imageCount: text(c.image) ? 1 : 0
      })),
      extras: teapotExtras(r),
      unsupported: [...UNSUPPORTED]
    }
  },

  applyChanges(raw, changes: WorkChanges) {
    const orig = teapotRaw(raw).snapshot
    const next = structuredClone(raw) as TeapotRaw
    const s = next.snapshot
    const before = JSON.stringify(s)

    if (changes.visibility !== undefined) throw new Error('TEAPOT_VISIBILITY_NEEDS_SUBMIT')

    const changedFields = new Set<string>()
    for (const [name, value] of Object.entries(changes.fields ?? {})) {
      const key = FIELDS[name]
      if (!key || typeof value !== 'string') throw new Error('BAD_FIELD')
      if (value !== orig[key]) changedFields.add(key)
      s[key] = value
    }
    if (changedFields.size) checkFields(s, changedFields)

    let books = list(s.keyword_books)
    const booksBefore = JSON.stringify(books)
    if (changes.lorebook) {
      // 제목으로 옛 항목과 짝짓는다 (자리 번호로만 이으면 끼워 넣기·순서 바꾸기에서 옛 항목의 숨은 칸이 엉뚱한 항목에 붙는다)
      const old = matchOld(
        changes.lorebook.map((e) => e.title),
        books,
        (b) => text(b.title),
        // 제목이 겹치는 항목이 있어 내용까지 견줘 짝짓는다 (2026-11-13 실제 스냅샷에서 겹침 확인)
        { contents: changes.lorebook.map((e) => e.content), contentOf: (b) => text(b.info) }
      )
      books = changes.lorebook.map((e, i) => loreFrom(e, old[i]))
    }
    for (const patch of changes.lorebookPatch ?? []) {
      const i = at(patch.index, books.length)
      books[i] = loreFrom(patch, books[i])
    }
    if (changes.lorebookRemove?.length) {
      const gone = new Set(changes.lorebookRemove.map((i) => at(i, books.length)))
      books = books.filter((_, i) => !gone.has(i))
    }
    for (const entry of changes.lorebookAdd ?? []) books.push(loreFrom(entry, undefined))
    if (JSON.stringify(books) !== booksBefore) {
      s.keyword_books = relabel(books)
      checkLorebook(books, list(orig.keyword_books))
    }

    let starts = list(s.start_settings)
    const startsBefore = JSON.stringify(starts)
    for (const patch of changes.startScenarios ?? []) {
      const i = at(patch.index, starts.length)
      starts[i] = startFrom(patch, starts[i])
    }
    if (changes.startScenariosRemove?.length) {
      const gone = new Set(changes.startScenariosRemove.map((i) => at(i, starts.length)))
      if (gone.has(0)) throw new Error('KEEP_DEFAULT')
      starts = starts.filter((_, i) => !gone.has(i))
    }
    for (const draft of changes.startScenariosAdd ?? []) {
      const made = startFrom(draft, { ...START_DEFAULT })
      if (!text(made.setting_name)) made.setting_name = '시작 상황 ' + (starts.length + 1)
      starts.push(made)
    }
    if (JSON.stringify(starts) !== startsBefore) {
      s.start_settings = starts
      checkStarts(starts, list(orig.start_settings))
    }

    let chars = list(s.characters)
    const charsBefore = JSON.stringify(chars)
    for (const patch of changes.characters ?? []) {
      const i = at(patch.index, chars.length)
      if (patch.info !== undefined && patch.info !== '') throw new Error('BAD_CHANGES')
      chars[i] = {
        ...chars[i],
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.details !== undefined ? { description: patch.details } : {})
      }
    }
    if (changes.charactersRemove?.length) {
      const gone = new Set(changes.charactersRemove.map((i) => at(i, chars.length)))
      chars = chars.filter((_, i) => !gone.has(i))
    }
    for (const c of changes.charactersAdd ?? []) {
      if (c.info) throw new Error('BAD_CHANGES')
      // 편집기 addCharacter와 같은 모양
      chars.push({ name: c.name, image: '', description: c.details ?? '', _sortKey: randomUUID() })
    }
    if (JSON.stringify(chars) !== charsBefore) s.characters = chars

    // 바뀐 것이 있을 때만 어느 저장 파일에 쓸지 정한다 (편집기 handleTempSave와 같은 기준)
    if (JSON.stringify(s) !== before) {
      const cp = next.checkpoint
      const reusable = !!text(cp.id) && cpStatus(cp.cp_status) === null && !isAuto(cp)
      if (!reusable) {
        const count = manualCount(next.checkpoints)
        if (count >= LIMITS.checkpoints) throw new Error('CHECKPOINT_LIMIT')
        next.checkpoint = { id: null, name: '제목없음 ' + (count + 1), cp_status: null }
      }
    }
    return next
  },

  /** 임시저장만 한다 (등록·심사는 부르지 않는다). 공개도·실제 작품은 바뀌지 않는다 */
  async save(write, id, next) {
    const r = teapotRaw(next)
    const wid = teapotWorkId(id)
    if (r.id !== wid) throw new Error('WORK_SHAPE')
    const snapshot = snapshotBody(r.snapshot)
    const cpId = text(r.checkpoint.id)
    if (cpId) {
      if (!ID_RE.test(cpId)) throw new Error('WORK_SHAPE')
      await callWrite(write, 'updateCheckpoint', { characterId: wid, cpId, snapshot })
      return
    }
    const made = await callWrite(write, 'createCheckpoint', {
      characterId: wid,
      name: text(r.checkpoint.name) || '제목없음 1',
      snapshot
    })
    const newId = isObj(made) && isObj(made.checkpoint) ? text(made.checkpoint.id) : ''
    if (!ID_RE.test(newId)) throw new Error('SAVE_FAILED createCheckpoint SHAPE checkpoint.id')
  },

  /** 작품 관리 화면의 삭제와 같은 함수. 서버에서 지우는 방식(완전 삭제인지)은 코드로 확인하지 못했다 */
  async remove(write, id) {
    await callWrite(write, 'deleteNewCharacter', { characterId: teapotWorkId(id) })
  },

  /**
   * 새 작품: createDraft로 번호를 받고, 그 번호로 첫 저장 파일을 만든다 (편집기에서 새로 만들고 임시저장한 것과 같다).
   * 공개도는 "0"(비공개)이고 등록(심사)은 하지 않는다.
   */
  async create(write: WorkWrite, draft: WorkDraft): Promise<string> {
    const snapshot = teapotCreateSnapshot(draft)
    const made = await callWrite(write, 'createDraft', {})
    const draftId = isObj(made) ? text(made.draftId) : ''
    if (!ID_RE.test(draftId)) throw new Error('CREATED_ID_UNKNOWN')
    try {
      await callWrite(write, 'createCheckpoint', {
        characterId: draftId,
        name: '제목없음 1',
        snapshot: snapshotBody(snapshot)
      })
    } catch (error) {
      // 번호는 생겼고 내용 저장만 실패했다 (빈 초안이 남는다)
      throw new Error(
        'CREATE_FAILED draft ' + draftId + ' ' + (error instanceof Error ? error.message : '')
      )
    }
    return draftId
  },

  checkDraft(draft) {
    teapotCreateSnapshot(draft)
  },

  // 이미지: 목록 읽기만 (올리기는 머리말의 인증 방식 문제로 막혀 있다)
  imageRules: TEAPOT_IMAGE_RULES,
  imageGroups(raw): ImageGroup[] {
    const s = teapotRaw(raw).snapshot
    const one = (url: string, label: string, isDefault: boolean): ImageGroup['images'][number] => ({
      id: null,
      url,
      label,
      description: '',
      visibility: null,
      isDefault
    })
    const work: ImageGroup['images'] = []
    if (text(s.image)) work.push(one(text(s.image), '대표 이미지', true))
    for (const c of list(s.circumstance_images)) {
      const urls = Array.isArray(c.image) ? strings(c.image) : text(c.image) ? [text(c.image)] : []
      const label = text(c.circumstance) || text(c.name)
      for (const u of urls) work.push({ ...one(u, label, false), id: strOrNull(c.id) })
    }
    const groups: ImageGroup[] = [{ character: null, name: text(s.char_name), images: work }]
    for (const [i, c] of list(s.characters).entries())
      groups.push({
        character: i,
        name: text(c.name),
        images: text(c.image) ? [one(text(c.image), text(c.name), true)] : []
      })
    return groups
  },
  coverUrl: (raw) => strOrNull(teapotRaw(raw).snapshot.image)
}

/**
 * 새 작품 첫 저장 파일의 snapshot. 편집기 새 폼(64408 모듈 f)에서 내용 칸만 채운다.
 * 작가 정보(creator_*)와 모델·출력 형식 기본값은 넣지 않는다: 편집기가 저장 파일을 열 때(loadSnapshot)
 * 로그인한 계정 값과 새 폼 기본값으로 채운다.
 */
export function teapotCreateSnapshot(draft: WorkDraft): Obj {
  const bad = (what: string): never => {
    throw new Error('BAD_DRAFT ' + what)
  }
  if (draft.characters.length) throw new Error('NO_CHARACTERS')
  if (draft.categories?.length) bad('categories (티팟 장르 값은 확인하지 못해 받지 않는다)')
  if (draft.coverUrl) bad('coverUrl (이미지 올리기 미지원)')
  if (draft.options && Object.keys(draft.options).length) bad('options')
  const starts = draft.startScenarios?.length ? draft.startScenarios : [{}]
  const start_settings = starts.map((st, i) => {
    const made = startFrom(st, { ...START_DEFAULT })
    if (!text(made.setting_name)) made.setting_name = '시작 상황 ' + (i + 1)
    return made
  })
  const books = (draft.lorebook ?? []).map((e) => loreFrom(e, undefined))
  const s: Obj = {
    image: '',
    char_name: draft.title,
    oneline_description: draft.subtitle ?? '',
    detail_description: draft.description ?? '',
    prompt: draft.main,
    is_nsfw: draft.adult,
    // 항상 비공개로 만든다
    publicity: '0',
    prompt_mode: 'simple',
    template: 'general',
    template_version: 'v1.0.0',
    hash_tags: [...new Set((draft.hashtags ?? []).map((t) => t.trim()).filter(Boolean))],
    keyword_books: relabel(books),
    start_settings,
    characters: []
  }
  checkFields(s)
  checkLorebook(books, [])
  checkStarts(start_settings, [])
  return s
}
