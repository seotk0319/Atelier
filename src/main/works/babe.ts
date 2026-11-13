// 베이비챗 작품 본문 읽기·저장. 주소와 필드는 2026-11-10에 베이비챗 응답과 사이트 코드로 확인했다.
//   GET  /ko/api/characters/my                    내 작품 목록 (배열)
//   GET  /ko/api/characters/{id}/edit             편집 데이터 (version 포함)
//   POST /ko/api/characters/{id}/edit/preview     저장 미리보기 {baseVersion, version, hasChanges, …}. 쓰지 않는다
//   PUT  /ko/api/characters/{id}/edit             저장. 본문 = 편집기 조립 모양 + {baseVersion, creatorComment, notifyFollowers}
//   POST /ko/api/characters/create                새 작품. 본문 = 편집기 조립 모양 (버전 정보 없음, 대표 이미지 필수)
// 베이비챗은 저장할 때마다 작품 버전이 하나 올라간다. 편집기처럼 미리보기를 먼저 불러
// 달라진 것이 없으면 저장을 보내지 않고, 팔로워 알림은 항상 끈 채(notifyFollowers:false) 보낸다.
// 캐릭터는 작품 하나에 하나라 characters는 비어 있고, 캐릭터 설정이 곧 main이다.
// 이미지 올리기(Vercel Blob)는 babe-media.ts에 있다.
import {
  BABE_IMAGE_RULES,
  babeImageGroups,
  babeImagesNext,
  babePlanImages,
  babeSendRule,
  babeUploadImage
} from './babe-media'
import { matchOld } from './match-old'
import type {
  LoreEntry,
  WorkAdapter,
  WorkBody,
  WorkDraft,
  WorkFeature,
  WorkFetch,
  WorkListItem
} from './types'
import { EXTRA_LIST_MAX, EXTRA_TEXT_MAX, UUID, UUID_RE, at, feature, isObj, list, strOrNull, strings, text } from './shared'

const ORIGIN = 'https://api.babechatapi.com'
const BASE = ORIGIN + '/ko/api/characters/'
const READ_PATHS = [
  /^\/ko\/api\/characters\/my$/,
  new RegExp('^/ko/api/characters/' + UUID + '/edit$', 'i')
]
const WRITE_PATHS: Record<string, RegExp[]> = {
  POST: [
    new RegExp('^/ko/api/characters/' + UUID + '/edit/preview$', 'i'),
    /^\/ko\/api\/characters\/create$/
  ],
  PUT: [new RegExp('^/ko/api/characters/' + UUID + '/edit$', 'i')],
  DELETE: [new RegExp('^/ko/api/characters/' + UUID + '$', 'i')]
}
// 사이트 코드에서 확인된 값만 받는다 (링크 공개가 있는지는 미확인)
const VISIBILITIES = ['public', 'private']

type Obj = Record<string, unknown>

async function json(res: Response): Promise<unknown> {
  if (res.status === 401 || res.status === 403) throw new Error('LOGIN_REQUIRED')
  if (res.status === 404) throw new Error('WORK_NOT_FOUND')
  if (!res.ok) throw new Error('WORK_READ_FAILED ' + res.status)
  return res.json()
}
function workId(id: string): string {
  if (!UUID_RE.test(id)) throw new Error('BAD_WORK_ID')
  return id.toLowerCase()
}
function plain(url: string, paths: RegExp[]): boolean {
  try {
    const u = new URL(url)
    return (
      u.origin === ORIGIN &&
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash &&
      paths.some((re) => re.test(u.pathname))
    )
  } catch {
    return false
  }
}

const FIELDS: Record<string, string> = {
  title: 'name',
  description: 'description',
  main: 'characterDetails'
}
// 시작 상황의 공통 이름 → 베이비챗 이름 (기본 시작 설정과 추가 시작 설정이 같은 키를 쓴다)
const START_KEYS = {
  title: 'initialTitle',
  content: 'initialAction',
  dialogue: 'initialMessage',
  description: 'playGuide'
} as const

const MAX_EXTRA_STARTS = 2
const keywords = (keys: string): string[] =>
  keys
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean)
/**
 * 키워드 글 → 배열. 읽을 때 준 글(쉼표+공백으로 이은 것) 그대로면 원본 배열을 그대로 쓴다.
 * 키워드가 쉼표 한 글자인 항목은 글로 이었다 다시 쪼개면 사라지기 때문이다.
 * 글이 바뀌었는데 쉼표가 든 옛 키워드가 있으면 쪼개서는 되살릴 수 없어 멈춘다.
 */
function keywordsFor(keys: string, old?: Obj): string[] {
  const before = old ? strings(old.keywords) : null
  if (before && before.join(', ') === keys) return before
  if (before?.some((k) => k.includes(','))) throw new Error('KEY_COMMA')
  return keywords(keys)
}

// 고칠 때 바뀐 칸에 한해 보는 길이 한도 (만들기 검사와 같은 값. 캐릭터 설정은 문서와 코드 값이 달라 보지 않는다)
const NAME_MAX = 20
const DESCRIPTION_MAX = 500
const START_LIMITS = {
  title: [1, 15],
  content: [1, 1000],
  dialogue: [1, 500],
  description: [0, 500]
} as const
const LORE_LIMITS = { title: [1, 20], content: [1, 500], keys: 5 } as const
function checkLength(where: string, value: unknown, min: number, max: number): void {
  if (typeof value !== 'string' || value.trim().length < min || value.length > max)
    throw new Error('BAD_LENGTH ' + where + ' ' + min + '~' + max + '자')
}

const edit = (raw: unknown): Obj => {
  if (!isObj(raw) || !isObj(raw.edit) || !strOrNull(raw.id)) throw new Error('WORK_SHAPE')
  return raw.edit
}

const NONE = (note: string): WorkFeature => feature('no', 'no', 'no', 'no', note)

const FEATURES: Record<string, WorkFeature> = {
  title: feature('yes', 'yes', 'yes', 'partial', '20자, 바꿀 때만 검사'),
  description: feature('yes', 'yes', 'yes', 'partial', '500자, 바꿀 때만 검사'),
  main_prompt: feature('yes', 'yes', 'yes', 'yes', '만들 때 종류별 5~7천자, 고칠 때 길이 검사 없음'),
  first_message: feature('yes', 'yes', 'yes', 'yes', '시작설정 첫 대사 500자'),
  start_scenarios: feature('yes', 'yes', 'yes', 'yes', '추가 최대2, 기본 삭제불가'),
  lorebook: feature('yes', 'yes', 'yes', 'partial', '전체교체 미확인, 쉼표 키는 막음'),
  characters: NONE('작품=캐릭터 하나'),
  example_dialogue: NONE('원본에 칸 없음'),
  user_persona: NONE('원본에 칸 없음'),
  output_rules: NONE('별도 칸 없음, 메인에 포함'),
  situation_images: feature('yes', 'yes', 'partial', 'partial', '올리기·빼기만, 이름·순서 수정 막음'),
  cover: feature('yes', 'yes', 'yes', 'partial', '대표 교체 단독 미확인'),
  tags: feature('yes', 'yes', 'partial', 'partial', '만들 때만 쓰기'),
  visibility: feature('yes', 'yes', 'yes', 'partial', '공개 전환 미확인, link 없음'),
  create_work: feature('yes', 'no', 'yes', 'yes', '비공개만, 대표 이미지 필수'),
  delete_work: feature('yes', 'no', 'yes', 'yes', '계획 후 제목 확인'),
  versioning_review: feature('yes', 'partial', 'no', 'yes', '저장마다 v+1, 심사 모름'),
  language_editions: feature('unknown', 'no', 'no', 'no', '판본 도구 없음(실측 오류)'),
  bgm_voice: NONE('원본에 칸 없음'),
  jsx_html: NONE('details 태그 불가'),
  model_settings: feature('yes', 'partial', 'partial', 'partial', '읽기는 개수만, 쓰기는 만들 때 추천모델만'),
  comments_stats: feature('yes', 'no', 'no', 'no', '댓글 답글은 알림쪽만')
}

/**
 * 원본 칸 하나를 extras에 얹는다. 짧은 값은 그대로, 긴 글은 `<이름>_length`, 긴 목록은 `<이름>_count`.
 * `sizeOnly`(작품 설정 글)는 짧아도 값을 싣지 않고 글자 수·개수만 싣는다.
 */
function putExtra(out: Obj, e: Obj, from: string, name: string, sizeOnly = false): void {
  if (!(from in e)) return
  const v = e[from]
  if (v === null) out[name] = v
  else if (sizeOnly) {
    if (typeof v === 'string') out[name + '_length'] = v.length
    else if (typeof v === 'number' || typeof v === 'boolean') out[name + '_length'] = String(v).length
    else if (Array.isArray(v)) out[name + '_count'] = v.length
  } else if (typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v))) out[name] = v
  else if (typeof v === 'string') {
    if (v.length <= EXTRA_TEXT_MAX) out[name] = v
    else out[name + '_length'] = v.length
  } else if (Array.isArray(v)) {
    if (v.length <= EXTRA_LIST_MAX && v.every((s) => typeof s === 'string' && s.length <= EXTRA_TEXT_MAX))
      out[name] = v
    else out[name + '_count'] = v.length
  }
}

// 공통 칸에 들지 않는 원본 칸. 읽을 때마다 달라지는 통계는 편집 데이터에 없고, 여기에도 싣지 않는다.
// 셋째 값이 true인 칸(캐릭터 프로필 글)은 작품 본문이라 글자 수·개수만 싣는다
const EXTRA_KEYS: [from: string, name: string, sizeOnly?: boolean][] = [
  ['version', 'version'],
  ['hashtags', 'hashtags'],
  ['category', 'category'],
  ['isAdult', 'is_adult'],
  ['targetGender', 'target_gender'],
  ['systemPrompt', 'system_prompt'],
  ['recommendedModel', 'recommended_model'],
  ['recommendedConfigMode', 'recommended_config_mode'],
  ['babechatOnly', 'babechat_only'],
  ['tookitOnly', 'tookit_only'],
  ['babeChatOnlyEndAt', 'babechat_only_end_at'],
  ['tookitOnlyEndAt', 'tookit_only_end_at'],
  ['creatorKeywordBookLimit', 'creator_keyword_book_limit'],
  ['jobs', 'profile_jobs', true],
  ['interests', 'profile_interests', true],
  ['likes', 'profile_likes', true],
  ['dislikes', 'profile_dislikes', true],
  ['date', 'profile_date', true],
  ['location', 'profile_location', true],
  ['height', 'profile_height', true],
  ['weight', 'profile_weight', true],
  ['details', 'profile_details', true]
]
function babeExtras(e: Obj): Obj {
  const out: Obj = {}
  for (const [from, name, sizeOnly] of EXTRA_KEYS) putExtra(out, e, from, name, sizeOnly)
  if (Array.isArray(e.images)) {
    const emotions = list(e.images)
      .slice(1)
      .filter((image) => image.url)
    out.has_cover = !!strOrNull(list(e.images)[0]?.url)
    out.emotion_image_count = emotions.length
    out.hidden_emotion_image_count = emotions.filter((image) => image.hidden === true).length
  }
  if (Array.isArray(e.modelConfigs)) out.model_config_count = e.modelConfigs.length
  const counts = (v: unknown): number => (Array.isArray(v) ? v.length : 0)
  if (Array.isArray(e.replySuggestions) || Array.isArray(e.startingScenarios))
    // 기본 시작 설정, 추가 시작 설정 순
    out.reply_suggestion_counts = [
      counts(e.replySuggestions),
      ...list(e.startingScenarios).map((s) => counts(s.replySuggestions))
    ]
  return out
}

// 사이트에는 있는데 이 연결부가 못 읽는 것 (캐릭터·부제·로어북 발동 방식처럼 사이트에 칸이 없는 것은 뺀다)
const BABE_UNSUPPORTED = ['추천 답변 내용', '모델별 설정 값', '카테고리 이름', '수정 시각', '댓글·통계']

export const babeWorks: WorkAdapter = {
  id: 'babe',
  // 서버가 다시 매기는 순서와 새 항목 번호 (2026-11-13 실제 저장에서 확인)
  rawIgnore: [/^edit\.keywordBooks\[[^\]]*\]\.(order|id)$/],
  label: '베이비챗',
  features: FEATURES,
  guide: {
    save: '저장할 때마다 버전이 1씩 오른다(되돌릴 수 없다). 제작자 코멘트는 빈 값, 팔로워 알림은 끈 채로 보낸다.',
    manual: [],
    unverified: [
      '공개작 저장',
      '공개 전환',
      '링크 공개(link)',
      '감정 이미지 순서',
      'gif 변환',
      '고칠 때 길이·개수 한도(만들기 규칙을 옮긴 값)'
    ]
  },
  capabilities: ['works_list', 'work_read', 'lorebook', 'start_scenarios', 'save', 'images'],

  readAllowed: (url) => plain(url, READ_PATHS),
  writeAllowed: (method, url) => !!WRITE_PATHS[method] && plain(url, WRITE_PATHS[method]),

  async list(read: WorkFetch): Promise<WorkListItem[]> {
    const rows = await json(await read(BASE + 'my'))
    if (!Array.isArray(rows)) throw new Error('WORK_LIST_SHAPE')
    return list(rows).flatMap((w) => {
      const id = strOrNull(w.characterId) || strOrNull(w.id)
      return id
        ? [
            {
              id,
              title: text(w.name),
              visibility: strOrNull(w.visibility),
              status: null,
              updatedAt: null,
              characters: null
            }
          ]
        : []
    })
  },

  async readRaw(read, id) {
    const wid = workId(id)
    const data = await json(await read(BASE + wid + '/edit'))
    if (!isObj(data) || typeof data.version !== 'number') throw new Error('WORK_SHAPE')
    return { id: wid, edit: data }
  },

  normalize(raw): WorkBody {
    const e = edit(raw)
    const start = (s: Obj, isDefault: boolean): WorkBody['startScenarios'][number] => ({
      id: typeof s.id === 'number' || typeof s.id === 'string' ? s.id : null,
      title: text(s.initialTitle),
      isDefault,
      content: text(s.initialAction),
      subPrompt: '',
      dialogue: text(s.initialMessage),
      situation: '',
      description: text(s.playGuide)
    })
    return {
      id: (raw as Obj).id as string,
      title: text(e.name),
      visibility: strOrNull(e.visibility),
      status: null,
      // 수정 시각 대신 버전 번호를 보여 준다 (저장하면 하나 오른다)
      updatedAt: 'v' + String(e.version),
      fields: Object.fromEntries(Object.entries(FIELDS).map(([k, f]) => [k, text(e[f])])),
      lorebook: list(e.keywordBooks).map((k) => ({
        title: text(k.title),
        keys: strings(k.keywords).join(', '),
        content: text(k.content),
        mode: null,
        offKeys: [],
        turnRange: null,
        offTurnRange: null
      })),
      startScenarios: [start(e, true), ...list(e.startingScenarios).map((s) => start(s, false))],
      characters: [],
      extras: babeExtras(e),
      unsupported: [...BABE_UNSUPPORTED]
    }
  },

  applyChanges(raw, changes) {
    edit(raw)
    const next = structuredClone(raw) as Obj
    const e = next.edit as Obj

    if (changes.visibility !== undefined) {
      if (!VISIBILITIES.includes(changes.visibility)) throw new Error('BAD_VISIBILITY')
      e.visibility = changes.visibility
    }

    for (const [name, value] of Object.entries(changes.fields ?? {})) {
      const key = FIELDS[name]
      if (!key || typeof value !== 'string') throw new Error('BAD_FIELD')
      if ((name === 'main' || name === 'title') && !value.trim()) throw new Error('EMPTY_FIELD')
      // 길이는 바뀐 칸만 본다 (옛 값이 한도를 넘어도 건드리지 않았으면 그대로 보낸다)
      if (value !== e[key]) {
        if (name === 'title') checkLength('title', value, 1, NAME_MAX)
        if (name === 'description') checkLength('description', value, 0, DESCRIPTION_MAX)
      }
      e[key] = value
    }

    // 새 항목은 편집기처럼 번호(id) 없이 {title, content, keywords}로 보낸다
    // (2026-11-10 사이트 코드: 로어북 추가 버튼이 번호 없는 항목을 덧붙인다).
    const fresh = (entry: LoreEntry, from?: Obj): Obj => ({
      title: entry.title,
      content: entry.content,
      keywords: keywordsFor(entry.keys, from)
    })
    // 바뀌었거나 새로 생긴 항목만 아래에서 검사한다 (값: 손대기 전 옛 항목, 새 항목은 undefined)
    const original = new Map<Obj, Obj>(list(e.keywordBooks).map((b) => [b, structuredClone(b)]))
    const touched = new Map<Obj, Obj | undefined>()
    if (changes.lorebook) {
      // 전체 교체: 제목이 같은 옛 항목(없으면 제자리에서 제목만 고친 항목)의 번호를 물려받는다. 짝이 없으면 새 항목이다.
      const old = list(e.keywordBooks)
      const paired = matchOld(
        changes.lorebook.map((entry) => entry.title),
        old,
        (book) => text(book.title),
        // 제목이 겹치는 항목이 있어 내용까지 견줘 짝짓는다 (2026-11-13 실제 스냅샷에서 겹침 확인)
        { contents: changes.lorebook.map((entry) => entry.content), contentOf: (book) => text(book.content) }
      )
      e.keywordBooks = changes.lorebook.map((entry, i) => {
        const from = paired[i]
        const book = from ? { ...from, ...fresh(entry, from) } : fresh(entry)
        touched.set(book, from && original.get(from))
        return book
      })
    }
    if (changes.lorebookPatch?.length) {
      const books = list(e.keywordBooks)
      for (const patch of changes.lorebookPatch) {
        const book = books[at(patch.index, books.length)]
        const p: Partial<LoreEntry> = patch
        if (!touched.has(book)) touched.set(book, original.get(book))
        if (p.title !== undefined) book.title = p.title
        if (p.content !== undefined) book.content = p.content
        if (p.keys !== undefined) book.keywords = keywordsFor(p.keys, book)
        if (
          p.mode !== undefined ||
          p.offKeys !== undefined ||
          p.turnRange !== undefined ||
          p.offTurnRange !== undefined
        )
          throw new Error('BAD_CHANGES')
      }
      e.keywordBooks = books
    }
    if (changes.lorebookRemove?.length) {
      const books = list(e.keywordBooks)
      const gone = new Set(changes.lorebookRemove.map((i) => at(i, books.length)))
      e.keywordBooks = books.filter((_, i) => !gone.has(i))
    }
    if (changes.lorebookAdd?.length) {
      const added = changes.lorebookAdd.map((entry) => fresh(entry))
      for (const book of added) touched.set(book, undefined)
      e.keywordBooks = [...list(e.keywordBooks), ...added]
    }
    // 플랫폼이 버리는 빈 항목과 길이 한도는 바뀐 칸만 본다. 건드리지 않은 옛 항목은 그대로 보낸다.
    list(e.keywordBooks).forEach((book, i) => {
      if (!touched.has(book)) return
      const before = touched.get(book)
      const where = 'lorebook[' + i + ']'
      const changed = (key: string): boolean =>
        !before || JSON.stringify(book[key]) !== JSON.stringify(before[key])
      if (changed('content')) {
        if (!text(book.content).trim()) throw new Error('BAD_LOREBOOK')
        checkLength(where + '.content', book.content, LORE_LIMITS.content[0], LORE_LIMITS.content[1])
      }
      if (changed('keywords')) {
        const count = strings(book.keywords).length
        if (!count) throw new Error('BAD_LOREBOOK')
        if (count > LORE_LIMITS.keys)
          throw new Error('BAD_LENGTH ' + where + '.keys 1~' + LORE_LIMITS.keys + '개')
      }
      if (changed('title'))
        checkLength(where + '.title', book.title, LORE_LIMITS.title[0], LORE_LIMITS.title[1])
    })

    if (changes.startScenarios?.length) {
      const extra = list(e.startingScenarios)
      for (const patch of changes.startScenarios) {
        const index = at(patch.index, extra.length + 1)
        const target = index === 0 ? e : extra[index - 1]
        if (patch.subPrompt !== undefined || patch.situation !== undefined)
          throw new Error('BAD_CHANGES')
        for (const [from, to] of Object.entries(START_KEYS)) {
          const key = from as keyof typeof START_KEYS
          const value = patch[key]
          if (value === undefined) continue
          if (value !== target[to]) {
            const [min, max] = START_LIMITS[key]
            checkLength('start_scenarios[' + index + '].' + key, value, min, max)
          }
          target[to] = value
        }
      }
      // 추가 시작 설정 목록은 이미 그 자리에서 고쳤다. 원본에 목록이 없던 작품에 빈 목록을 만들어 보내지 않는다.
    }
    if (changes.startScenariosRemove?.length) {
      const extra = list(e.startingScenarios)
      const gone = new Set(changes.startScenariosRemove.map((i) => at(i, extra.length + 1)))
      // 0번은 기본 시작 설정이라 지울 수 없다
      if (gone.has(0)) throw new Error('KEEP_DEFAULT')
      e.startingScenarios = extra.filter((_, i) => !gone.has(i + 1))
    }
    if (changes.startScenariosAdd?.length) {
      const extra = list(e.startingScenarios)
      // 편집기는 추가 시작 설정을 2개까지만 받는다
      if (extra.length + changes.startScenariosAdd.length > MAX_EXTRA_STARTS)
        throw new Error('START_LIMIT')
      changes.startScenariosAdd.forEach((draft, i) => {
        if (draft.subPrompt !== undefined || draft.situation !== undefined)
          throw new Error('BAD_CHANGES')
        // 새 항목은 이름·상황·첫 대사를 꼭 채워야 한다 (만들기 검사와 같다). 빈 칸을 기본값으로 채워 보내지 않는다.
        const where = 'start_scenarios_add[' + i + '].'
        checkLength(where + 'title', draft.title, ...START_LIMITS.title)
        checkLength(where + 'content', draft.content, ...START_LIMITS.content)
        checkLength(where + 'dialogue', draft.dialogue, ...START_LIMITS.dialogue)
        if (draft.description !== undefined)
          checkLength(where + 'description', draft.description, ...START_LIMITS.description)
        // 편집기의 추가 버튼과 같은 모양: 번호 없이 보낸다
        extra.push({
          initialTitle: draft.title,
          initialAction: draft.content,
          initialMessage: draft.dialogue,
          playGuide: draft.description ?? '',
          replySuggestions: []
        })
      })
      e.startingScenarios = extra
    }

    // 베이비챗은 작품 하나에 캐릭터 하나다
    if (
      changes.characters?.length ||
      changes.charactersAdd?.length ||
      changes.charactersRemove?.length
    )
      throw new Error('NO_CHARACTERS')
    return next
  },

  async save(write, id, next) {
    const wid = workId(id)
    const e = edit(next)
    const body = babeSaveBody(e)
    const preview = await write('POST', BASE + wid + '/edit/preview', body)
    if (preview.status === 401 || preview.status === 403) throw new Error('LOGIN_REQUIRED')
    const seen: unknown = await preview.json().catch(() => null)
    if (!preview.ok || !isObj(seen)) throw new Error('SAVE_FAILED ' + preview.status)
    // 그 사이 다른 곳에서 저장됐으면 버전이 달라져 있다
    if (seen.baseVersion !== e.version) throw new Error('PLAN_STALE')
    if (seen.hasChanges !== true) return { skipped: true as const }

    const res = await write('PUT', BASE + wid + '/edit', {
      ...body,
      baseVersion: e.version,
      creatorComment: '',
      notifyFollowers: false
    })
    if (res.status === 401 || res.status === 403) throw new Error('LOGIN_REQUIRED')
    if (res.status === 409) throw new Error('PLAN_STALE')
    if (!res.ok) throw new Error('SAVE_FAILED ' + res.status)
    return undefined
  },

  visibilities: VISIBILITIES,

  async remove(write, id) {
    const res = await write('DELETE', BASE + workId(id))
    if (res.status === 401 || res.status === 403) throw new Error('LOGIN_REQUIRED')
    if (res.status === 404) throw new Error('WORK_NOT_FOUND')
    if (!res.ok) throw new Error('DELETE_FAILED ' + res.status)
  },

  async create(write, draft, read) {
    const body = babeCreateBody(draft)
    // 편집기는 만들기 응답을 쓰지 않아 응답 모양을 모른다. 응답에 번호가 없으면 목록에서 새로 생긴 작품을 찾는다.
    const before = read ? new Set((await babeWorks.list(read)).map((w) => w.id)) : null
    const res = await write('POST', BASE + 'create', body)
    if (res.status === 401 || res.status === 403) throw new Error('LOGIN_REQUIRED')
    const reply: unknown = await res.json().catch(() => null)
    if (!res.ok)
      throw new Error(
        'CREATE_FAILED ' + res.status + ' ' + text(isObj(reply) ? reply.message : '').slice(0, 60)
      )
    const holders = isObj(reply) ? [reply, reply.data, reply.character].filter(isObj) : []
    for (const holder of holders)
      for (const key of ['characterId', 'id']) {
        const id = text(holder[key])
        if (UUID_RE.test(id)) return id.toLowerCase()
      }
    if (read && before) {
      const fresh = (await babeWorks.list(read)).filter(
        (w) => !before.has(w.id) && w.title === draft.title
      )
      if (fresh.length === 1) return workId(fresh[0].id)
    }
    throw new Error('CREATED_ID_UNKNOWN')
  },

  // 대표 이미지를 올리기 전에 나머지 규격부터 본다 (규격이 틀리면 파일만 올라가고 끝나지 않게)
  checkDraft(draft) {
    babeCreateBody({ ...draft, coverUrl: draft.coverUrl ?? 'https://placeholder.invalid/cover' })
  },

  sendRule: babeSendRule,
  imageRules: BABE_IMAGE_RULES,
  imageGroups: babeImageGroups,
  planImages: babePlanImages,
  uploadImage: (io, file) => babeUploadImage(io.send, file),
  async applyImages(io, id, raw, changes) {
    // 올린 주소를 편집 데이터에 얹어 평소 저장과 같은 길(미리보기 → 저장)로 보낸다. 버전이 하나 오른다.
    await babeWorks.save!(io.write, id, await babeImagesNext(io.send, raw, changes))
  }
}

const within = (value: unknown, min: number, max: number): boolean =>
  typeof value === 'string' && value.trim().length >= min && value.length <= max
// 캐릭터 설정 글자 수 한도는 프롬프트 종류마다 다르다 (편집기의 만들기 검사와 같은 값)
const DETAIL_LIMITS: Record<string, number> = { custom_plus: 7000, custom: 6000 }

/**
 * 새 작품 본문 (항상 비공개). 편집기의 입력 규칙(2026-11-10 사이트 코드의 폼 규격)을 먼저 확인해
 * 플랫폼에 닿기 전에 걸러 낸다. 본문 모양은 저장과 같다.
 */
export function babeCreateBody(draft: WorkDraft): Obj {
  const o = draft.options ?? {}
  const bad = (what: string): never => {
    throw new Error('BAD_DRAFT ' + what)
  }
  // 베이비챗은 작품이 곧 캐릭터 하나다
  if (draft.characters.length) throw new Error('NO_CHARACTERS')
  if (!draft.coverUrl || !/^https:\/\//i.test(draft.coverUrl)) throw new Error('COVER_REQUIRED')
  if (!within(draft.title, 1, 20)) bad('title 1~20자')
  if (!within(draft.description, 1, 500)) bad('description 1~500자')
  const prompt = typeof o.system_prompt === 'string' ? o.system_prompt : 'default'
  const mainMax = DETAIL_LIMITS[prompt] ?? 5000
  if (!within(draft.main, 1, mainMax)) bad('main 1~' + mainMax + '자')
  if (!['male', 'female', 'all'].includes(o.target_gender as string))
    bad('options.target_gender male/female/all')
  if (!Number.isInteger(o.category)) bad('options.category 숫자')
  if (typeof o.recommended_model !== 'string' || !o.recommended_model.trim())
    bad('options.recommended_model')
  const tags = draft.hashtags ?? []
  if (tags.length < 1 || tags.length > 10 || tags.some((t) => !t.trim())) bad('hashtags 1~10개')

  const starts = draft.startScenarios ?? []
  if (!starts.length) bad('start_scenarios 1개 이상')
  if (starts.length > 1 + MAX_EXTRA_STARTS) throw new Error('START_LIMIT')
  const start = (s: (typeof starts)[number], i: number): Obj => {
    if (s.subPrompt !== undefined || s.situation !== undefined) throw new Error('BAD_CHANGES')
    if (!within(s.title, 1, 15)) bad('start_scenarios[' + i + '].title 1~15자')
    if (!within(s.content, 1, 1000)) bad('start_scenarios[' + i + '].content 1~1000자')
    if (!within(s.dialogue, 1, 500)) bad('start_scenarios[' + i + '].dialogue 1~500자')
    if ((s.description ?? '').length > 500) bad('start_scenarios[' + i + '].description 500자 이하')
    return {
      initialTitle: s.title,
      initialAction: s.content,
      initialMessage: s.dialogue,
      ...(s.description !== undefined ? { playGuide: s.description } : {})
    }
  }
  const [first, ...extra] = starts.map(start)

  const books = (draft.lorebook ?? []).map((entry, i) => {
    const keys = keywords(entry.keys)
    if (keys.length < 1 || keys.length > 5) bad('lorebook[' + i + '] 키워드 1~5개')
    if (!within(entry.title, 1, 20)) bad('lorebook[' + i + '].title 1~20자')
    if (!within(entry.content, 1, 500)) bad('lorebook[' + i + '].content 1~500자')
    return { title: entry.title, content: entry.content, keywords: keys }
  })

  return babeSaveBody({
    ...first,
    name: draft.title,
    description: draft.description,
    images: [{ url: draft.coverUrl }],
    targetGender: o.target_gender,
    systemPrompt: prompt,
    characterDetails: draft.main,
    isAdult: draft.adult,
    category: o.category,
    hashtags: tags,
    keywordBooks: books,
    // 편집기의 새 작품 기본값
    creatorKeywordBookLimit: 5,
    visibility: 'private',
    babechatOnly: false,
    ...(extra.length
      ? { startingScenarios: extra.map((s) => ({ ...s, replySuggestions: [] })) }
      : {}),
    recommendedModel: o.recommended_model
  })
}

// 값이 없는(없거나 null) 칸은 예전 모양으로 보낸다: 글 칸은 빈 글, 목록 칸은 칸을 뺀다. 값이 있으면 원본 그대로.
const orEmpty = (v: unknown): unknown => (v === null || v === undefined ? '' : v)
const orOmit = (v: unknown): unknown => (v === null ? undefined : v)
const cleanReplies = (v: unknown): unknown =>
  Array.isArray(v) ? strings(v).filter((s) => !!s.trim()) : orOmit(v)

/** 편집 데이터 → 저장 본문. 사이트 편집기의 본문 조립 함수와 같은 모양이다 (2026-11-10 사이트 코드). */
export function babeSaveBody(e: Obj): Obj {
  const images = list(e.images)
  const cover = strOrNull(images[0]?.url)
  const visibility = strOrNull(e.visibility)
  if (!cover || !visibility || typeof e.characterDetails !== 'string') throw new Error('WORK_SHAPE')

  const mode = e.recommendedConfigMode
  const models = list(e.modelConfigs).map((m) => ({
    model: m.model,
    thinkingLevel: m.thinkingLevel,
    outputLevel: m.outputLevel
  }))
  const modelConfig =
    mode === 'individual'
      ? { mode: 'individual', models }
      : mode === 'bulk'
        ? {
            mode: 'bulk',
            thinkingLevel: models[0]?.thinkingLevel,
            outputLevel: models[0]?.outputLevel
          }
        : undefined

  return {
    name: orEmpty(e.name),
    description: orEmpty(e.description),
    image: cover,
    emotionImages: images
      .slice(1)
      .filter((image) => image.url)
      .map((image, i) => ({ ...image, order: i + 1, hidden: image.hidden === true })),
    targetGender: e.targetGender,
    systemPrompt: e.systemPrompt === 'default' ? undefined : e.systemPrompt,
    characterDetails: e.characterDetails,
    initialAction: e.initialAction,
    initialMessage: e.initialMessage,
    isAdult: e.isAdult,
    category: e.category,
    tags: e.hashtags,
    keywordBooks: Array.isArray(e.keywordBooks)
      ? list(e.keywordBooks).map((book, order) => ({ ...book, order }))
      : orOmit(e.keywordBooks),
    creatorKeywordBookLimit: e.creatorKeywordBookLimit,
    visibility,
    babechatOnly: e.babechatOnly,
    playGuide: e.playGuide,
    replySuggestions: cleanReplies(e.replySuggestions),
    details: {
      jobs: e.jobs,
      interests: e.interests,
      likes: e.likes,
      dislikes: e.dislikes,
      date: e.date,
      location: e.location,
      height: e.height,
      weight: e.weight,
      details: e.details
    },
    startingScenarios: Array.isArray(e.startingScenarios)
      ? list(e.startingScenarios).map((s) => ({
          ...s,
          replySuggestions: cleanReplies(s.replySuggestions)
        }))
      : orOmit(e.startingScenarios),
    initialTitle: e.initialTitle,
    recommendedModel: orEmpty(e.recommendedModel),
    modelConfig
  }
}
