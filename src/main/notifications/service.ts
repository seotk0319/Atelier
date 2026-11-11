import { app, shell } from 'electron'
import { join } from 'node:path'
import { createStore, type InboxStore } from './core/store.mjs'
import { awaitingReply, displayText, queryInbox, sourceUrl } from './query'
import { createDirectCollector } from './direct/collector'
import { countByGroup, groupWorks } from './work-groups'
import { isDirectPlatform } from './direct/platforms'
import type {
  InboxConnectResult,
  InboxQuery,
  InboxReplied,
  InboxReplyResult,
  InboxReplyTarget,
  InboxResult,
  InboxWork,
  InboxWorksResult
} from '../../shared/inbox'
import { REPLY_MAX, ReplyError } from './direct/babe-reply'
import type { WorkReadInit, WorkRequest } from '../works/types'
import { canReply, type ReplyComment, type ReplyItem } from './direct/replies'
import { classifyTopics, topicMap, topicState } from './topics'
import {
  catalogFrom,
  emptyCatalog,
  hasUnknownWork,
  platformKey,
  rememberCatalog,
  safeImage,
  worksNeedingImage,
  type PlatformImages,
  type WorkCatalog
} from './work-images'
import { readFile, writeFile } from 'node:fs/promises'
import {
  edenTargets,
  emptyReplied,
  mergeFound,
  readReplied,
  type EdenStored,
  type RepliedRecord
} from './replied'

let store: InboxStore | null = null
let direct: ReturnType<typeof createDirectCollector> | null = null
let start: Promise<void> | null = null

// ───────────── 내 작품 (플랫폼별 이식본과 최초 공개일) ─────────────
// 연결된 플랫폼에서 내 작품 목록을 읽어 파일로 남긴다. 6시간이 지나면 열 때 새로 읽고,
// 새로 고침을 누르면 바로 읽는다. 읽지 못한 플랫폼은 이전 결과를 그대로 둔다.
const WORKS_TTL = 6 * 60 * 60_000
interface WorksCache {
  fetchedAt: string | null
  works: InboxWork[]
  errors: Record<string, string>
}
let worksCache: WorksCache | null = null
let worksRun: Promise<void> | null = null
const worksFile = (): string => join(app.getPath('userData'), 'creator-inbox', 'my-works.json')

async function loadWorks(): Promise<WorksCache> {
  if (worksCache) return worksCache
  try {
    const saved = JSON.parse(await readFile(worksFile(), 'utf8')) as WorksCache
    if (saved && Array.isArray(saved.works)) {
      for (const w of saved.works) if (w.image) safeImage(w.image)
      worksCache = {
        fetchedAt: saved.fetchedAt ?? null,
        works: saved.works,
        errors: saved.errors ?? {}
      }
      return worksCache
    }
  } catch {
    // 처음이거나 손상된 파일
  }
  worksCache = { fetchedAt: null, works: [], errors: {} }
  return worksCache
}

function worksError(error: unknown): string {
  const code = error instanceof Error ? error.message : String(error)
  if (/LOGIN_REQUIRED|SESSION|401|403/.test(code)) return '로그인이 필요해요'
  if (/ACCOUNT_MISSING/.test(code)) return '계정 정보를 읽지 못했어요'
  return '작품 목록을 읽지 못했어요'
}

async function refreshWorks(): Promise<void> {
  if (!direct) return
  const previous = await loadWorks()
  const platforms = await direct.myWorkPlatforms()
  const works: InboxWork[] = []
  const errors: Record<string, string> = {}
  await Promise.all(
    platforms.map(async (p) => {
      try {
        works.push(...(await direct!.myWorks(p)))
      } catch (e) {
        errors[p] = worksError(e)
        works.push(...previous.works.filter((w) => w.platform === p))
      }
    })
  )
  for (const w of works) if (w.image) safeImage(w.image)
  worksCache = { fetchedAt: new Date().toISOString(), works, errors }
  await writeFile(worksFile(), JSON.stringify(worksCache)).catch(() => undefined)
}

// 제목 묶기는 work-groups.ts (테스트 가능하게 분리)

const LOGIN_STATES = ['login', 'auth_required', 'unauthorized']

export async function getInboxWorks(refresh = false, cached = false): Promise<InboxWorksResult> {
  await startInbox().catch(() => undefined)
  const cache = await loadWorks()
  const age = cache.fetchedAt ? Date.now() - Date.parse(cache.fetchedAt) : Infinity
  // cached: 작품 탭을 열 때. 오래됐어도 사이트에 묻지 않는다 (새로 읽기는 누를 때만)
  if (direct && (refresh || (!cached && age > WORKS_TTL))) {
    worksRun ??= refreshWorks().finally(() => {
      worksRun = null
    })
    await worksRun
  }
  const current = worksCache ?? cache
  const supported = direct ? await direct.myWorkPlatforms().catch(() => []) : []
  const byName = (await workCatalog().catch(() => emptyCatalog())).byName
  const groups = groupWorks(current.works, byName)
  // 댓글 수와 로그인 상태는 저장된 알림·연결 정보로만 센다 (사이트에 묻지 않는다)
  let unanswered: Record<string, number> = {}
  const loginLost = new Set<string>()
  for (const [p, message] of Object.entries(current.errors))
    if (message === worksError(new Error('LOGIN_REQUIRED'))) loginLost.add(p)
  if (direct) {
    const connected = new Set(supported)
    for (const w of current.works) if (!connected.has(w.platform)) loginLost.add(w.platform)
  }
  if (store) {
    try {
      const view = await store.view()
      await loadReplied()
      const status = direct ? await direct.status().catch(() => null) : null
      for (const [p, state] of Object.entries(view.platforms ?? {}))
        if (
          LOGIN_STATES.includes(state?.status ?? '') &&
          (!status || status.platforms[p as keyof typeof status.platforms]?.connected)
        )
          loginLost.add(p)
      unanswered = countByGroup(
        groups,
        view.items
          .filter((item) => view.selection?.[item.platform] !== false)
          .filter((item) => awaitingReply(item, replied.items))
          .map((item) => ({
            platform: item.platform,
            work: item.work
              ? {
                  id: item.work.id,
                  title: item.work.title ? displayText(item.work.title) : null
                }
              : null
          }))
      )
    } catch {
      // 알림 저장소를 못 읽으면 댓글 수 없이 돌려준다
    }
  }
  return {
    fetchedAt: current.fetchedAt,
    groups,
    errors: current.errors,
    supported,
    unanswered,
    loginLost: [...loginLost]
  }
}
/** 작품 본문 읽기 통로 (src/main/works). 허용 주소 검사와 로그인 연장은 collector가 한다. */
export async function workRead(
  platform: string,
  url: string,
  init?: WorkReadInit
): Promise<Response> {
  await startInbox().catch(() => undefined)
  if (!direct) throw new ReplyError('LOGIN_REQUIRED')
  return direct.workRead(platform, url, init)
}

/** 작품 저장 통로 (src/main/works). 허용 요청 검사와 로그인 연장은 collector가 한다. */
export async function workWrite(
  platform: string,
  method: string,
  url: string,
  body: unknown
): Promise<Response> {
  await startInbox().catch(() => undefined)
  if (!direct) throw new ReplyError('LOGIN_REQUIRED')
  return direct.workWrite(platform, method, url, body)
}

/** 작품 이미지·표지 통로 (파일 묶음·바이너리·파일 저장소). 허용 규칙 검사는 collector가 한다. */
export async function workSend(platform: string, request: WorkRequest): Promise<Response> {
  await startInbox().catch(() => undefined)
  if (!direct) throw new ReplyError('LOGIN_REQUIRED')
  return direct.workSend(platform, request)
}

/** 작품 연결부가 주소에 넣는 로그인 계정 번호 (알플레이·티팟). 연결 안 됐으면 null. */
export async function workAccount(platform: string): Promise<unknown> {
  await startInbox().catch(() => undefined)
  return direct ? direct.workAccount(platform) : null
}

let error: string | null = null

// 썸네일 기준표(베이비챗 작품 이름·이미지). 파일로 남겨 두고 6시간마다 새로 읽는다.
// 기준표에 없는 작품이 알림에 보이면(새 작품) 15분 간격으로 일찍 새로 받는다.
// 실패하면 10분 동안 다시 시도하지 않는다 (베이비챗을 안 쓰는 사람도 조회가 느려지지 않게).
const CATALOG_TTL = 6 * 60 * 60_000
const CATALOG_EARLY = 15 * 60_000
const CATALOG_BACKOFF = 10 * 60_000
let catalog: WorkCatalog = emptyCatalog()
let catalogLoaded = false
let catalogRefresh: Promise<void> | null = null
let catalogFailedAt = 0
const catalogFile = (): string => join(app.getPath('userData'), 'creator-inbox', 'babe-works.json')
function refreshCatalog(): Promise<void> | null {
  if (!direct || catalogRefresh || Date.now() - catalogFailedAt < CATALOG_BACKOFF)
    return catalogRefresh
  catalogRefresh = direct
    .babeWorks()
    .then(async (list) => {
      const next = catalogFrom(list)
      // 작품이 0개인 응답도 정상일 수 있다(새 계정). 그대로 받아 두고 시각만 갱신한다.
      catalog = next
      await writeFile(catalogFile(), JSON.stringify(next))
    })
    .catch(() => {
      catalogFailedAt = Date.now()
    })
    .finally(() => {
      catalogRefresh = null
    })
  return catalogRefresh
}
async function workCatalog(): Promise<WorkCatalog> {
  if (!catalogLoaded) {
    catalogLoaded = true
    try {
      const saved = JSON.parse(await readFile(catalogFile(), 'utf8')) as WorkCatalog
      if (saved && typeof saved.byName === 'object' && typeof saved.byId === 'object') {
        catalog = saved
        rememberCatalog(saved)
      }
    } catch {
      // 처음이거나 손상된 파일이면 새로 받는다.
    }
  }
  const age = catalog.fetchedAt ? Date.now() - Date.parse(catalog.fetchedAt) : Infinity
  if (age > CATALOG_TTL) {
    const run = refreshCatalog()
    // 첫 조회는 기준표를 받을 때까지 잠깐 기다린다. 이후엔 이전 표로 바로 답한다.
    if (!catalog.fetchedAt && run) await run
  }
  return catalog
}
function noticeUnknownWorks(items: InboxQueryItems): void {
  const age = catalog.fetchedAt ? Date.now() - Date.parse(catalog.fetchedAt) : Infinity
  if (age > CATALOG_EARLY && hasUnknownWork(items, catalog)) void refreshCatalog()
}
type InboxQueryItems = Parameters<typeof hasUnknownWork>[0]

// 플랫폼 작품 이미지 캐시. 찾은 이미지는 3일, 없던 작품은 1일 뒤 다시 확인한다.
// 조회가 막히지 않게 뒤에서 한 번에 최대 60개, 동시에 3개씩 채운다.
const FOUND_TTL = 3 * 24 * 60 * 60_000
const MISSING_TTL = 24 * 60 * 60_000
let platformImages: Record<string, { url: string | null; at: string }> = {}
let platformLoaded = false
let filling: Promise<void> | null = null
const platformFile = (): string =>
  join(app.getPath('userData'), 'creator-inbox', 'work-thumbs.json')
async function loadPlatformImages(): Promise<void> {
  if (platformLoaded) return
  platformLoaded = true
  try {
    const saved = JSON.parse(await readFile(platformFile(), 'utf8')) as typeof platformImages
    if (saved && typeof saved === 'object') {
      platformImages = saved
      for (const entry of Object.values(saved)) if (entry?.url) safeImage(entry.url)
    }
  } catch {
    // 처음이면 비어 있다.
  }
}
function platformImageMap(): PlatformImages {
  return Object.fromEntries(Object.entries(platformImages).map(([k, e]) => [k, e.url]))
}
function stale(key: string): boolean {
  const entry = platformImages[key]
  if (!entry) return true
  return Date.now() - Date.parse(entry.at) > (entry.url ? FOUND_TTL : MISSING_TTL)
}
function fillPlatformImages(items: InboxQueryItems): boolean {
  if (filling || !direct) return !!filling
  const todo = worksNeedingImage(items, catalog)
    .filter((w) => stale(platformKey(w.platform, w.workId)))
    .slice(0, 60)
  if (!todo.length) return false
  const collector = direct
  filling = (async () => {
    const queue = [...todo]
    await Promise.all(
      Array.from({ length: 3 }, async () => {
        for (let w = queue.shift(); w; w = queue.shift()) {
          const key = platformKey(w.platform, w.workId)
          try {
            const url = await collector.workImage(w.platform, w.workId)
            if (url) safeImage(url)
            platformImages[key] = { url, at: new Date().toISOString() }
          } catch {
            // 로그인 만료·네트워크 오류는 기록하지 않고 다음 조회 때 다시 시도한다.
          }
        }
      })
    )
    await writeFile(platformFile(), JSON.stringify(platformImages)).catch(() => undefined)
  })().finally(() => {
    filling = null
  })
  return true
}

export function startInbox(): Promise<void> {
  if (!start)
    start = createStore(join(app.getPath('userData'), 'creator-inbox'))
      .then((value) => {
        store = value
        direct = createDirectCollector({
          directory: join(app.getPath('userData'), 'creator-inbox'),
          profileDir: join(app.getPath('userData'), 'moa-login', 'browser-profile'),
          store: value,
          version: app.getVersion()
        })
        direct.start()
      })
      .catch(() => {
        error = '알림 저장소를 열지 못했어요. 기존 파일은 그대로 보존돼요.'
      })
  return start
}

async function ready(): Promise<InboxStore> {
  await startInbox()
  if (!store) throw new Error(error || '알림 수집기를 시작하지 못했어요.')
  return store
}

// 내가 단 답글 기록. NAIS3에서 보낸 답글은 바로, 에덴 사이트에서 단 답글은 뒤에서 찾아 남긴다.
// 에덴 확인은 3분에 한 번만 하고, 실패하면(로그인 풀림 등) 10분 쉬었다가 다시 본다.
const REPLIED_EVERY = 3 * 60_000
let replied: RepliedRecord = emptyReplied()
let repliedLoaded = false
let repliedChecking: Promise<void> | null = null
let repliedCheckedAt = 0
const repliedFile = (): string => join(app.getPath('userData'), 'creator-inbox', 'replied.json')
async function loadReplied(): Promise<void> {
  if (repliedLoaded) return
  repliedLoaded = true
  try {
    replied = readReplied(JSON.parse(await readFile(repliedFile(), 'utf8')))
  } catch {
    // 처음이면 비어 있다.
  }
}
const saveReplied = (): Promise<void> =>
  writeFile(repliedFile(), JSON.stringify(replied)).catch(() => undefined)
function checkEdenReplies(items: EdenStored[]): boolean {
  if (repliedChecking) return true
  if (!direct || Date.now() - repliedCheckedAt < REPLIED_EVERY) return false
  const full = !replied.edenFullAt
  const targets = edenTargets(items, replied, full)
  repliedCheckedAt = Date.now()
  if (!targets.length) return false
  const collector = direct
  repliedChecking = (async () => {
    try {
      const found = await collector.edenReplies(targets.map((t) => t.commentId))
      mergeFound(replied, targets, found)
      if (full) replied.edenFullAt = new Date().toISOString()
      await saveReplied()
    } catch {
      // 에덴 연결이 없거나 로그인이 풀렸으면 조용히 넘어가고 10분 뒤 다시 본다.
      repliedCheckedAt = Date.now() + 7 * 60_000
    }
  })().finally(() => {
    repliedChecking = null
  })
  return true
}

export async function getInbox(query: InboxQuery): Promise<InboxResult> {
  await startInbox()
  if (!store)
    return {
      ...queryInbox({
        enabled: false,
        mode: 'direct-api',
        collector: null,
        platforms: {},
        items: []
      }),
      available: false,
      error
    }
  const view = await store.view()
  await loadPlatformImages()
  await loadReplied()
  const topics = await topicMap()
  const result = queryInbox(
    view,
    query,
    Date.now(),
    await workCatalog(),
    platformImageMap(),
    replied.items,
    topics
  )
  noticeUnknownWorks(view.items)
  result.thumbnailsPending = fillPlatformImages(view.items)
  result.repliesPending = checkEdenReplies(view.items as EdenStored[])
  // 새 댓글을 뒤에서 분류한다 (기다리지 않는다)
  void classifyTopics(
    view.items.map((item) => ({
      id: item.id,
      event: item.event,
      at: item.at,
      text: item.body && item.body !== item.title ? displayText(item.body) : '',
      work: item.work?.title ? displayText(item.work.title) : null
    }))
  ).catch(() => undefined)
  const ts = topicState()
  result.topicsPending = ts.pending
  result.topicsError = ts.error
  if (!direct) return result
  const status = await direct.status()
  return {
    ...result,
    directError: status.error ? directMessage(status.error) : null,
    platforms: result.platforms.map((p) => {
      const own = status.platforms[p.id]
      return own
        ? {
            ...p,
            appConnected: own.connected,
            awaitingLogin: own.awaitingLogin,
            loginWindowOpen: own.windowOpen,
            connecting: own.connecting
          }
        : p
    })
  }
}

const DIRECT_MESSAGES: Record<string, string> = {
  BROWSER_NOT_FOUND: '크롬이나 엣지를 찾지 못했어요. 둘 중 하나를 설치한 뒤 다시 눌러주세요.',
  BROWSER_ALREADY_OPEN: 'NAIS3 로그인 창이 아직 열려 있어요. 그 창을 닫은 뒤 다시 눌러주세요.',
  BROWSER_START_TIMEOUT: '로그인 창을 열지 못했어요. 잠시 뒤 다시 눌러주세요.',
  ENCRYPTION_UNAVAILABLE: '이 PC에서 로그인 정보를 암호화할 수 없어서 저장하지 않았어요.',
  UNSUPPORTED_SESSION_STORE: '로그인 정보 파일을 읽지 못했어요. 파일은 그대로 두었어요.',
  CONNECT_IN_PROGRESS: '이미 연결을 확인하고 있어요.'
}
const directMessage = (code: string): string =>
  DIRECT_MESSAGES[code] || '로그인 정보를 처리하지 못했어요. (' + code.slice(0, 160) + ')'

export async function connectInboxPlatform(platform: string): Promise<InboxConnectResult> {
  await ready()
  if (!direct || !isDirectPlatform(platform)) throw new Error('Invalid platform')
  const result = await direct.connect(platform)
  if (result.state === 'connected')
    return {
      state: 'connected',
      message: result.detail
        ? '연결했지만 첫 수집에서 오류가 났어요. ' + result.detail.slice(0, 200)
        : '연결했어요. 이제 NAIS3가 직접 알림을 모아요.'
    }
  if (result.state === 'login-required')
    return {
      state: 'login-required',
      message: '로그인 창을 열었어요. 로그인한 뒤 그 창을 닫으면 알아서 연결돼요.'
    }
  return { state: 'error', message: directMessage(result.detail || 'UNKNOWN') }
}
export async function disconnectInboxPlatform(platform: string): Promise<{ ok: true }> {
  await ready()
  if (!direct || !isDirectPlatform(platform)) throw new Error('Invalid platform')
  await direct.disconnect(platform)
  return { ok: true }
}
export async function selectInboxPlatform(
  platform: string,
  selected: boolean
): Promise<{ ok: true }> {
  if (typeof selected !== 'boolean') throw new Error('Invalid selection')
  await (await ready()).select(platform, selected)
  return { ok: true }
}
export async function controlInbox(enabled: boolean): Promise<{ enabled: boolean }> {
  if (typeof enabled !== 'boolean') throw new Error('Invalid control')
  return (await ready()).control(enabled)
}
export async function setInboxInterval(
  minutes: number
): Promise<{ intervalMinutes: number; collecting: boolean; nextCollectionAt: string | null }> {
  return (await ready()).setInterval(minutes)
}
export async function openInboxSource(id: string): Promise<void> {
  const item = (await (await ready()).view()).items.find((item) => item.id === id)
  if (!item) throw new Error('알림을 찾을 수 없어요.')
  await shell.openExternal(sourceUrl(item))
}
export async function closeInbox(): Promise<void> {
  if (start) await start
  if (direct) await direct.stop()
}

const REPLY_MESSAGES: Record<string, string> = {
  LOGIN_REQUIRED: '이 플랫폼 로그인이 풀렸어요. 연결 관리에서 다시 로그인해 주세요.',
  COMMENT_NOT_FOUND: '원래 댓글을 찾지 못했어요. 작성자가 지웠을 수 있어요.',
  OWN_COMMENT: '내가 쓴 댓글이에요. 다른 사람 댓글에만 답글을 달 수 있어요.',
  BAD_CONTENT: `답글은 1자 이상 ${REPLY_MAX}자 이하로 써주세요.`,
  BAD_TARGET: '이 알림에는 원래 댓글 정보가 없어 답글을 달 수 없어요.',
  REPLY_UNSUPPORTED: '이 알림은 아직 앱에서 답글을 달 수 없어요.'
}

export function replyMessage(error: unknown, fallback: string): string {
  const code = error instanceof ReplyError ? error.code : ''
  const status = error instanceof ReplyError && error.status ? ` (${error.status})` : ''
  return REPLY_MESSAGES[code] || `${fallback}${status}. 잠시 뒤 다시 해주세요.`
}

type StoredItem = {
  id: string
  platform: string
  sourceType?: string
  event?: string
  title?: string
  body?: string
  at?: string | null
  actor?: { name?: string | null }
  work?: { id?: string | null }
  commentId?: string | null
  url?: string | null
}

function toReplyItem(raw: StoredItem): ReplyItem {
  return {
    platform: raw.platform,
    sourceType: String(raw.sourceType || ''),
    event: String(raw.event || ''),
    title: displayText(raw.title || ''),
    body: displayText(raw.body || ''),
    at: raw.at || null,
    actor: { name: raw.actor?.name || null },
    work: { id: raw.work?.id || null },
    commentId: raw.commentId || null,
    url: raw.url || null
  }
}

async function replyItem(id: string): Promise<ReplyItem> {
  const s = await ready()
  if (!direct) throw new ReplyError('LOGIN_REQUIRED')
  const raw = (await s.view()).items.find((x) => x.id === id) as StoredItem | undefined
  if (!raw) throw new ReplyError('COMMENT_NOT_FOUND')
  const item = toReplyItem(raw)
  if (!canReply(item)) throw new ReplyError('REPLY_UNSUPPORTED')
  return item
}

/** 보내기 전에 답글을 달 원래 댓글을 찾아 보여준다. */
export async function previewReply(id: string): Promise<InboxReplyTarget> {
  try {
    const item = await replyItem(id)
    const target = await direct!.resolveReply(item.platform as never, item)
    return { ok: true, message: '', author: target.author, content: target.content, at: target.at }
  } catch (error) {
    return { ok: false, message: replyMessage(error, '원래 댓글을 불러오지 못했어요') }
  }
}

/** 알림이 가리키는 원래 댓글에 답글을 단다. 올리기 직전까지 모든 확인은 본체에서 한다. */
export async function replyInbox(id: string, content: string): Promise<InboxReplyResult> {
  try {
    await sendReplyAs(id, content, 'app')
    return { ok: true, message: '답글을 달았어요.' }
  } catch (error) {
    return { ok: false, message: replyMessage(error, '답글을 달지 못했어요') }
  }
}

/** 답글을 달고 기록한다. via는 화면에 "NAIS3에서 / AI 자동"으로 보인다. 실패하면 ReplyError를 던진다. */
export async function sendReplyAs(id: string, content: string, via: 'app' | 'ai'): Promise<void> {
  const item = await replyItem(id)
  await direct!.reply(item.platform as never, item, content)
  await loadReplied()
  replied.items[id] = { at: new Date().toISOString(), content: content.trim(), via }
  await saveReplied()
}

/** AI 답글이 쓰는 원래 댓글: 알림 정보와, 사이트에서 다시 찾은 댓글 전체. */
export async function replyTargetFor(
  id: string
): Promise<{ item: ReplyItem; target: ReplyComment; work: string | null }> {
  const item = await replyItem(id)
  const target = await direct!.resolveReply(item.platform as never, item)
  const raw = (await (await ready()).view()).items.find((x) => x.id === id) as
    (StoredItem & { work?: { title?: string | null } }) | undefined
  return { item, target, work: raw?.work?.title ? displayText(raw.work.title) : null }
}

export interface InboxSnapshotItem {
  id: string
  platform: string
  event: string
  at: string | null
  author: string | null
  body: string
  canReply: boolean
}
/** AI 답글이 쓰는 저장된 알림과 내 답글 기록. 저장소가 아직 없으면 빈 목록. */
export async function inboxSnapshot(): Promise<{
  items: InboxSnapshotItem[]
  replied: Record<string, InboxReplied>
}> {
  await startInbox()
  if (!store) return { items: [], replied: {} }
  await loadReplied()
  const items = ((await store.view()).items as StoredItem[]).map((raw) => {
    const item = toReplyItem(raw)
    return {
      id: raw.id,
      platform: raw.platform,
      event: item.event,
      at: item.at,
      author: item.actor.name,
      body: item.body,
      canReply: canReply(item)
    }
  })
  return { items, replied: replied.items }
}
