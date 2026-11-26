// AI 답글 본체. 키는 OS 암호화, 설정·이번 달 사용량은 settings, 자동 답글 기록은
// creator-inbox/ai-replies.json에 둔다. 댓글과 말투 예시만 Claude에 보내고 키는 화면에 끝 6자리만 보낸다.
import { app } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  DEEPSEEK_AI_PRICES,
  usageCost,
  type AiEngine,
  type AiBacklogPreview,
  type AiBacklogRequest,
  type AiBacklogState,
  type AiDraftResult,
  type AiLogEntry,
  type AiReplyConfig,
  type AiReplyStatus,
  type AiUsage
} from '../../shared/ai-reply'
import { INBOX_PLATFORMS, type InboxPlatform } from '../../shared/inbox'
import {
  deleteClaudeKey,
  getClaudeKey,
  getOpenRouterKey,
  getSetting,
  setClaudeKey,
  setSetting
} from '../db/settings'
import { OPENROUTER_MESSAGES, OpenRouterError, openRouterMessage } from '../llm/openrouter'
import { ReplyError } from '../notifications/direct/babe-reply'
import { inboxSnapshot, replyMessage, replyTargetFor, sendReplyAs } from '../notifications/service'
import {
  autoCandidates,
  backlogCandidates,
  countToday,
  readAiConfig,
  runAuto,
  type AutoItem
} from './auto'
import { ClaudeError, claudeMessage, claudeVerify, type ClaudeResponse } from '../llm/claude'
import { deepseekDraft } from './deepseek'
import { addUsage, draftRequest, pickExamples, readDraft, type StyleExample } from './prompt'

export const AI_MESSAGES: Record<string, string> = {
  NO_KEY: 'Claude API 키가 아직 없어요. 설정 > AI 답글에서 키를 넣어주세요.',
  AUTH: 'Claude 인증에 실패했어요. 설정의 API 키를 확인해주세요.',
  CREDIT: 'Claude 크레딧이 모자라요. Claude Console에서 남은 크레딧을 확인해주세요.',
  RATE: '요청이 잠깐 몰렸어요. 조금 뒤 다시 시도해주세요.',
  OVERLOADED: 'Claude 서버가 붐벼요. 조금 뒤 다시 시도해주세요.',
  BAD_REQUEST: 'Claude가 요청을 받지 않았어요. 잠시 뒤 다시 시도해주세요.',
  SERVER: 'Claude 서버에 문제가 있어요. 잠시 뒤 다시 시도해주세요.',
  NETWORK: '네트워크에 연결할 수 없어요. 인터넷 연결을 확인해주세요.',
  TIMEOUT: 'Claude 응답이 너무 늦어요. 다시 시도해주세요.',
  REFUSED: 'AI가 이 댓글에는 답글을 쓰지 않았어요. 직접 답해주세요.'
}
const aiMessage = (error: unknown): { message: string; code: string } => {
  if (error instanceof OpenRouterError)
    return { message: openRouterMessage(error), code: error.code }
  const code = error instanceof ClaudeError ? error.code : 'SERVER'
  return { message: AI_MESSAGES[code] || AI_MESSAGES.SERVER, code }
}

// 엔진. 고른 엔진에 키가 없고 다른 엔진이 준비돼 있으면 그쪽을 쓴다.
// 처음(고른 적 없음)에는 OpenRouter 키가 있으면 DeepSeek, 아니면 Claude.
const ENGINE_KEY = 'ai_reply_engine'
function chosenEngine(): AiEngine {
  const stored = getSetting(ENGINE_KEY)
  if (stored === 'claude' || stored === 'deepseek') return stored
  return getOpenRouterKey() ? 'deepseek' : 'claude'
}
const engineKey = (engine: AiEngine): string | null =>
  ((engine === 'deepseek' ? getOpenRouterKey() : getClaudeKey()) || '').trim() || null
function activeEngine(): { engine: AiEngine; key: string | null } {
  const chosen = chosenEngine()
  const key = engineKey(chosen)
  if (key) return { engine: chosen, key }
  const other: AiEngine = chosen === 'deepseek' ? 'claude' : 'deepseek'
  const otherKey = engineKey(other)
  return otherKey ? { engine: other, key: otherKey } : { engine: chosen, key: null }
}
const noKeyMessage = (engine: AiEngine): string =>
  engine === 'deepseek' ? OPENROUTER_MESSAGES.NO_KEY : AI_MESSAGES.NO_KEY
export function setAiEngine(engine: AiEngine): Promise<AiReplyStatus> {
  setSetting(ENGINE_KEY, engine === 'deepseek' ? 'deepseek' : 'claude')
  lastError = null
  return aiStatus()
}

// 설정
const CONFIG_KEY = 'ai_reply_config'
const config = (): AiReplyConfig => readAiConfig(getSetting(CONFIG_KEY))

// 이번 달 사용량 (이 앱에서 쓴 만큼). 엔진마다 값이 달라 따로 센다.
const USAGE_KEYS: Record<AiEngine, string> = {
  claude: 'ai_reply_usage',
  deepseek: 'ai_reply_usage_deepseek'
}
const PRICES = { claude: undefined, deepseek: DEEPSEEK_AI_PRICES }
function readUsage(engine: AiEngine = 'claude'): AiUsage | null {
  try {
    const value = JSON.parse(getSetting(USAGE_KEYS[engine]) || 'null') as AiUsage | null
    return value && typeof value.month === 'string' ? value : null
  } catch {
    return null
  }
}
function recordUsage(response: ClaudeResponse, engine: AiEngine): void {
  setSetting(USAGE_KEYS[engine], JSON.stringify(addUsage(readUsage(engine), response, new Date())))
}
const engineCost = (usage: AiUsage, engine: AiEngine): number => usageCost(usage, PRICES[engine])
/** 이번 달 것만 (지난달이면 0) */
function monthUsage(engine: AiEngine): AiUsage {
  const empty = { month: '', requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  const usage = readUsage(engine)
  return usage && usage.month === addUsage(null, {}, new Date()).month ? usage : empty
}

// 말투 예시. 지난 답글은 자주 바뀌지 않으니 10분 동안 다시 쓴다.
const EXAMPLE_TTL = 10 * 60_000
let exampleCache: { at: number; examples: StyleExample[]; total: number } | null = null
async function styleExamples(): Promise<{ examples: StyleExample[]; total: number }> {
  if (exampleCache && Date.now() - exampleCache.at < EXAMPLE_TTL) return exampleCache
  const snapshot = await inboxSnapshot()
  const comments = new Map(
    snapshot.items.filter((item) => snapshot.replied[item.id]).map((item) => [item.id, item.body])
  )
  exampleCache = { at: Date.now(), ...pickExamples(comments, snapshot.replied) }
  return exampleCache
}

// 자동 답글 기록. 최근 3000건만 남긴다.
const LOG_MAX = 3000
let log: Record<string, AiLogEntry> = {}
let logLoaded = false
const logFile = (): string => join(app.getPath('userData'), 'creator-inbox', 'ai-replies.json')
async function loadLog(): Promise<void> {
  if (logLoaded) return
  logLoaded = true
  try {
    const saved = JSON.parse(await readFile(logFile(), 'utf8')) as { entries?: unknown }
    if (saved?.entries && typeof saved.entries === 'object')
      log = saved.entries as Record<string, AiLogEntry>
  } catch {
    // 처음이면 비어 있다.
  }
  await fillSources()
}
/**
 * 2.8.0 기록에는 출처가 없다. 자동 답글은 켠 시각 뒤 댓글만 다루므로, 댓글 시각이 그 앞이면
 * 지난 댓글 일괄 답글로 본다. 한 번 채우면 파일에 남는다.
 */
async function fillSources(): Promise<void> {
  const missing = Object.values(log).filter((entry) => !entry.source)
  if (!missing.length) return
  try {
    const since = Date.parse(config().since || '')
    const at = new Map((await inboxSnapshot()).items.map((item) => [item.id, item.at]))
    for (const entry of missing) {
      const commented = Date.parse(at.get(entry.id) || '')
      entry.source = Number.isFinite(since) && commented >= since ? 'auto' : 'backlog'
    }
    await saveLog()
  } catch {
    // 알림 저장소를 못 열면 다음 실행 때 다시 채운다.
  }
}
async function saveLog(): Promise<void> {
  const entries = Object.values(log).sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
  if (entries.length > LOG_MAX)
    log = Object.fromEntries(entries.slice(0, LOG_MAX).map((e) => [e.id, e]))
  await writeFile(logFile(), JSON.stringify({ entries: log })).catch(() => undefined)
}

let lastError: string | null = null

export async function aiStatus(): Promise<AiReplyStatus> {
  await loadLog()
  const key = getClaudeKey()
  const active = activeEngine()
  // 화면에는 두 엔진을 합친 이번 달 사용량을 보여준다 (비용은 엔진별 값으로 계산해 더한다).
  const claudeUsage = monthUsage('claude')
  const deepseekUsage = monthUsage('deepseek')
  const shown: AiUsage = {
    month: addUsage(null, {}, new Date()).month,
    requests: claudeUsage.requests + deepseekUsage.requests,
    input: claudeUsage.input + deepseekUsage.input,
    output: claudeUsage.output + deepseekUsage.output,
    cacheRead: claudeUsage.cacheRead + deepseekUsage.cacheRead,
    cacheWrite: claudeUsage.cacheWrite + deepseekUsage.cacheWrite
  }
  const cost = engineCost(claudeUsage, 'claude') + engineCost(deepseekUsage, 'deepseek')
  let examples = { used: 0, total: 0 }
  try {
    const found = await styleExamples()
    examples = { used: found.examples.length, total: found.total }
  } catch {
    // 알림 저장소를 못 열면 0으로 보여준다.
  }
  return {
    hasKey: !!active.key,
    tail: key ? key.slice(-6) : '',
    engine: active.engine,
    claudeReady: !!key,
    deepseekReady: !!engineKey('deepseek'),
    config: config(),
    examples,
    usage: { ...shown, cost },
    today: countToday(log, new Date()),
    lastError,
    backlog
  }
}

/** 키를 확인(모델 목록 읽기)한 뒤 맞으면 저장한다. */
export async function saveAiKey(raw: string): Promise<{ ok: boolean; message: string }> {
  const key = String(raw || '').trim()
  if (!key || key.length > 300 || /\s/.test(key))
    return { ok: false, message: 'Claude API 키 모양이 아니에요. 다시 붙여넣어 주세요.' }
  try {
    await claudeVerify(key)
    setClaudeKey(key)
    lastError = null
    return { ok: true, message: '키를 확인하고 저장했어요.' }
  } catch (error) {
    return { ok: false, message: aiMessage(error).message }
  }
}
export function removeAiKey(): { ok: true } {
  deleteClaudeKey()
  return { ok: true }
}

/** 모드를 켜는 순간을 since로 남겨, 그 뒤에 온 댓글만 자동으로 다룬다. */
export async function setAiConfig(
  patch: Partial<Pick<AiReplyConfig, 'mode' | 'excluded' | 'dailyLimit'>>
): Promise<AiReplyStatus> {
  const previous = config()
  const next: AiReplyConfig = { ...previous }
  if (patch.mode !== undefined) next.mode = patch.mode
  if (patch.excluded !== undefined) next.excluded = patch.excluded
  if (patch.dailyLimit !== undefined) next.dailyLimit = patch.dailyLimit
  if (next.mode === 'off') next.since = null
  else if (previous.mode === 'off' || !previous.since) next.since = new Date().toISOString()
  setSetting(CONFIG_KEY, JSON.stringify(readAiConfig(JSON.stringify(next))))
  if (next.mode === 'off') lastError = null
  return aiStatus()
}

/** 알림 하나에 답글 후보를 받는다. 원래 댓글을 먼저 찾고(로그인 확인), 그다음 Claude에 묻는다. */
export async function draftReply(id: string): Promise<AiDraftResult & { code?: string }> {
  const fail = (message: string, code?: string): AiDraftResult & { code?: string } => ({
    ok: false,
    message,
    replies: [],
    handoff: false,
    reason: null,
    code
  })
  const { engine, key } = activeEngine()
  if (!key) return fail(noKeyMessage(engine), 'NO_KEY')
  let found: Awaited<ReturnType<typeof replyTargetFor>>
  try {
    found = await replyTargetFor(String(id || ''))
  } catch (error) {
    return fail(
      replyMessage(error, '원래 댓글을 불러오지 못했어요'),
      error instanceof ReplyError ? error.code : undefined
    )
  }
  const { item, target, work } = found
  const comment = target.content?.trim() || item.body
  if (!comment) return fail('댓글 내용이 비어 있어서 답글 초안을 쓸 수 없어요.')
  try {
    const { examples } = await styleExamples()
    const body = draftRequest(examples, {
      platform: INBOX_PLATFORMS[item.platform as InboxPlatform] || item.platform,
      work,
      author: target.author ?? item.actor.name,
      comment
    })
    const response =
      engine === 'deepseek' ? await deepseekDraft(key, body) : await claudeMessage(key, body)
    recordUsage(response, engine)
    const draft = readDraft(response)
    return { ok: true, message: '', ...draft }
  } catch (error) {
    const { message, code } = aiMessage(error)
    return fail(message, code)
  }
}

export async function aiEntry(id: string): Promise<AiLogEntry | null> {
  await loadLog()
  return log[String(id || '')] ?? null
}
export async function aiLog(limit = 30): Promise<AiLogEntry[]> {
  await loadLog()
  return Object.values(log)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, Math.max(1, Math.min(100, limit)))
}

// 자동 답글: 1분마다 새 댓글을 보고, 한 번에 최대 5개를 다룬다.
const TICK_MS = 60_000
let timer: ReturnType<typeof setInterval> | null = null
let running = false

async function sendAsAi(
  id: string,
  content: string
): Promise<{ ok: boolean; message: string; code?: string }> {
  try {
    await sendReplyAs(id, content, 'ai')
    return { ok: true, message: '' }
  } catch (error) {
    return {
      ok: false,
      message: replyMessage(error, '답글을 달지 못했어요'),
      code: error instanceof ReplyError ? error.code : undefined
    }
  }
}
const snapshotItems = (items: Awaited<ReturnType<typeof inboxSnapshot>>['items']): AutoItem[] =>
  items.map((item) => ({ ...item, comment: item.body }))

async function tick(): Promise<void> {
  const current = config()
  if (running || backlog?.running || current.mode === 'off') return
  const active = activeEngine()
  if (!active.key) {
    lastError = noKeyMessage(active.engine)
    return
  }
  running = true
  try {
    const snapshot = await inboxSnapshot()
    await loadLog()
    const candidates = autoCandidates(snapshotItems(snapshot.items), current, snapshot.replied, log)
    if (!candidates.length) return
    const result = await runAuto({
      config: current,
      candidates,
      sentToday: countToday(log, new Date()).autoSent,
      draft: draftReply,
      send: sendAsAi,
      record: async (entry) => {
        log[entry.id] = entry
        await saveLog()
      },
      wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: () => new Date(),
      active: () => config().mode === current.mode
    })
    lastError = result.stopped
  } catch {
    // 알림 저장소를 못 열었으면 다음 차례에 다시 본다.
  } finally {
    running = false
  }
}
export function startAiReplies(): void {
  if (timer) return
  timer = setInterval(() => void tick(), TICK_MS)
  setTimeout(() => void tick(), 15_000)
}
export function stopAiReplies(): void {
  if (timer) clearInterval(timer)
  timer = null
  backlogStop = true
}

// 지난 댓글 일괄 답글. 자동 답글과 같은 규칙(넘김·간격·멈춤)으로, 최근 댓글부터 다룬다.
// 진행 상황은 메모리에만 두고, 다룬 댓글은 기록에 남으므로 다시 시작하면 남은 것부터 이어진다.
let backlog: AiBacklogState | null = null
let backlogStop = false
const DEFAULT_PER_REPLY = 0.0006
const DEFAULT_PER_REPLY_DEEPSEEK = 0.0005

export async function previewBacklog(days: number): Promise<AiBacklogPreview> {
  const snapshot = await inboxSnapshot()
  await loadLog()
  const list = backlogCandidates(
    snapshotItems(snapshot.items),
    Object.keys(INBOX_PLATFORMS),
    snapshot.replied,
    log,
    { days: Number(days) || 0, now: new Date(), includeDrafted: true }
  )
  const byPlatform: AiBacklogPreview['byPlatform'] = {}
  for (const item of list) {
    const key = item.platform as InboxPlatform
    byPlatform[key] = (byPlatform[key] || 0) + 1
  }
  const usageEngine = activeEngine().engine
  const usage = readUsage(usageEngine)
  return {
    byPlatform,
    drafted: list.filter((item) => log[item.id]?.state === 'drafted').length,
    perReply:
      usage && usage.requests > 0
        ? engineCost(usage, usageEngine) / usage.requests
        : usageEngine === 'deepseek'
          ? DEFAULT_PER_REPLY_DEEPSEEK
          : DEFAULT_PER_REPLY
  }
}

const waitOrStop = async (ms: number): Promise<void> => {
  for (let left = ms; left > 0 && !backlogStop; left -= 500)
    await new Promise((resolve) => setTimeout(resolve, Math.min(500, left)))
}

export async function startBacklog(request: AiBacklogRequest): Promise<AiReplyStatus> {
  if (backlog?.running) return aiStatus()
  const mode = request.mode === 'send' ? 'send' : 'draft'
  const platforms = (request.platforms || []).filter((p) => p in INBOX_PLATFORMS)
  const started = new Date().toISOString()
  const empty: AiBacklogState = {
    running: false,
    mode,
    total: 0,
    done: 0,
    sent: 0,
    drafted: 0,
    skipped: 0,
    failed: 0,
    startedAt: started,
    finishedAt: started,
    stopped: null
  }
  const engineNow = activeEngine()
  if (!engineNow.key) {
    backlog = { ...empty, stopped: noKeyMessage(engineNow.engine) }
    return aiStatus()
  }
  const snapshot = await inboxSnapshot()
  await loadLog()
  const all = backlogCandidates(snapshotItems(snapshot.items), platforms, snapshot.replied, log, {
    days: Number(request.days) || 0,
    now: new Date(),
    includeDrafted: mode === 'send'
  })
  const limit = Number(request.limit) || 0
  const candidates = limit > 0 ? all.slice(0, limit) : all
  const state: AiBacklogState = {
    ...empty,
    running: true,
    total: candidates.length,
    finishedAt: null
  }
  backlog = state
  backlogStop = false
  void (async () => {
    try {
      // 자동 답글이 도는 중이면 끝날 때까지 기다린다 (같은 댓글에 겹쳐 보내지 않게).
      while (running && !backlogStop) await new Promise((resolve) => setTimeout(resolve, 500))
      const result = await runAuto({
        config: { ...config(), mode, dailyLimit: Number.MAX_SAFE_INTEGER },
        candidates,
        sentToday: 0,
        draft: async (id) => {
          const previous = log[id]
          if (mode === 'send' && previous?.state === 'drafted' && previous.replies.length)
            return {
              ok: true,
              message: '',
              replies: previous.replies,
              handoff: false,
              reason: null
            }
          return draftReply(id)
        },
        send: sendAsAi,
        record: async (entry) => {
          log[entry.id] = entry
          await saveLog()
          state.done++
          state[entry.state]++
        },
        wait: waitOrStop,
        now: () => new Date(),
        active: () => !backlogStop,
        source: 'backlog'
      })
      state.stopped = result.stopped ?? (backlogStop ? '중간에 멈췄어요.' : null)
    } catch {
      state.stopped = '알림 저장소를 읽지 못해 멈췄어요.'
    } finally {
      state.running = false
      state.finishedAt = new Date().toISOString()
    }
  })()
  return aiStatus()
}

export async function stopBacklog(): Promise<AiReplyStatus> {
  backlogStop = true
  return aiStatus()
}
