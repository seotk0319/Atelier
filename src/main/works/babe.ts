// 베이비챗 작품 본문 읽기·저장. 주소와 필드는 2026-11-10에 베이비챗 응답과 사이트 코드로 확인했다.
//   GET  /ko/api/characters/my                    내 작품 목록 (배열)
//   GET  /ko/api/characters/{id}/edit             편집 데이터 (version 포함)
//   POST /ko/api/characters/{id}/edit/preview     저장 미리보기 {baseVersion, version, hasChanges, …}. 쓰지 않는다
//   PUT  /ko/api/characters/{id}/edit             저장. 본문 = 편집기 조립 모양 + {baseVersion, creatorComment, notifyFollowers}
// 베이비챗은 저장할 때마다 작품 버전이 하나 올라간다. 편집기처럼 미리보기를 먼저 불러
// 달라진 것이 없으면 저장을 보내지 않고, 팔로워 알림은 항상 끈 채(notifyFollowers:false) 보낸다.
// 캐릭터는 작품 하나에 하나라 characters는 비어 있고, 캐릭터 설정이 곧 main이다.
import type { LoreEntry, WorkAdapter, WorkBody, WorkFetch, WorkListItem } from './types'

const ORIGIN = 'https://api.babechatapi.com'
const BASE = ORIGIN + '/ko/api/characters/'
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const UUID_RE = new RegExp('^' + UUID + '$', 'i')
const READ_PATHS = [
  /^\/ko\/api\/characters\/my$/,
  new RegExp('^/ko/api/characters/' + UUID + '/edit$', 'i')
]
const WRITE_PATHS: Record<string, RegExp> = {
  POST: new RegExp('^/ko/api/characters/' + UUID + '/edit/preview$', 'i'),
  PUT: new RegExp('^/ko/api/characters/' + UUID + '/edit$', 'i')
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
const list = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter(isObj) : [])
const text = (v: unknown): string => (typeof v === 'string' ? v : '')
const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []

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

const keywords = (keys: string): string[] =>
  keys
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean)

function at(index: unknown, length: number): number {
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= length)
    throw new Error('BAD_INDEX')
  return index
}
const edit = (raw: unknown): Obj => {
  if (!isObj(raw) || !isObj(raw.edit) || !strOrNull(raw.id)) throw new Error('WORK_SHAPE')
  return raw.edit
}

export const babeWorks: WorkAdapter = {
  id: 'babe',
  label: '베이비챗',
  capabilities: ['works_list', 'work_read', 'lorebook', 'start_scenarios', 'save'],

  readAllowed: (url) => plain(url, READ_PATHS),
  writeAllowed: (method, url) => !!WRITE_PATHS[method] && plain(url, [WRITE_PATHS[method]]),

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
      characters: []
    }
  },

  applyChanges(raw, changes) {
    edit(raw)
    const next = structuredClone(raw) as Obj
    const e = next.edit as Obj

    for (const [name, value] of Object.entries(changes.fields ?? {})) {
      const key = FIELDS[name]
      if (!key || typeof value !== 'string') throw new Error('BAD_FIELD')
      if ((name === 'main' || name === 'title') && !value.trim()) throw new Error('EMPTY_FIELD')
      e[key] = value
    }

    // 새 항목은 편집기처럼 번호(id) 없이 {title, content, keywords}로 보낸다
    // (2026-11-10 사이트 코드: 로어북 추가 버튼이 번호 없는 항목을 덧붙인다).
    const fresh = (entry: LoreEntry): Obj => ({
      title: entry.title,
      content: entry.content,
      keywords: keywords(entry.keys)
    })
    if (changes.lorebook) {
      // 전체 교체: 자리가 같은 항목은 기존 번호를 물려받아 고친 것으로 보낸다
      const old = list(e.keywordBooks)
      e.keywordBooks = changes.lorebook.map((entry, i) =>
        old[i] ? { ...old[i], ...fresh(entry) } : fresh(entry)
      )
    }
    if (changes.lorebookPatch?.length) {
      const books = list(e.keywordBooks)
      for (const patch of changes.lorebookPatch) {
        const book = books[at(patch.index, books.length)]
        const p: Partial<LoreEntry> = patch
        if (p.title !== undefined) book.title = p.title
        if (p.content !== undefined) book.content = p.content
        if (p.keys !== undefined) book.keywords = keywords(p.keys)
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
    if (changes.lorebookAdd?.length)
      e.keywordBooks = [...list(e.keywordBooks), ...changes.lorebookAdd.map(fresh)]
    for (const book of list(e.keywordBooks))
      if (!text(book.content).trim() || !strings(book.keywords).length)
        throw new Error('BAD_LOREBOOK')

    if (changes.startScenarios?.length) {
      const extra = list(e.startingScenarios)
      for (const patch of changes.startScenarios) {
        const index = at(patch.index, extra.length + 1)
        const target = index === 0 ? e : extra[index - 1]
        if (patch.subPrompt !== undefined || patch.situation !== undefined)
          throw new Error('BAD_CHANGES')
        for (const [from, to] of Object.entries(START_KEYS)) {
          const value = patch[from as keyof typeof START_KEYS]
          if (value !== undefined) target[to] = value
        }
      }
      e.startingScenarios = extra
    }

    if (changes.characters?.length) throw new Error('BAD_CHANGES')
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
    if (seen.hasChanges !== true) return

    const res = await write('PUT', BASE + wid + '/edit', {
      ...body,
      baseVersion: e.version,
      creatorComment: '',
      notifyFollowers: false
    })
    if (res.status === 401 || res.status === 403) throw new Error('LOGIN_REQUIRED')
    if (res.status === 409) throw new Error('PLAN_STALE')
    if (!res.ok) throw new Error('SAVE_FAILED ' + res.status)
  }
}

const cleanReplies = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? strings(v).filter((s) => !!s.trim()) : undefined

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
    name: text(e.name),
    description: text(e.description),
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
    keywordBooks: list(e.keywordBooks).map((book, order) => ({ ...book, order })),
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
      : undefined,
    initialTitle: e.initialTitle,
    recommendedModel: text(e.recommendedModel),
    modelConfig
  }
}
