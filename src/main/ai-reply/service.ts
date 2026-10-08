// AI 답글 본체. 키는 OS 암호화, 설정·이번 달 사용량은 settings, 자동 답글 기록은
// creator-inbox/ai-replies.json에 둔다. 댓글과 말투 예시만 Claude에 보내고 키는 화면에 끝 6자리만 보낸다.
import { app } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  usageCost,
  type AiDraftResult,
  type AiLogEntry,
  type AiReplyConfig,
  type AiReplyStatus,
  type AiUsage
} from '../../shared/ai-reply'
import { INBOX_PLATFORMS, type InboxPlatform } from '../../shared/inbox'
import { deleteClaudeKey, getClaudeKey, getSetting, setClaudeKey, setSetting } from '../db/settings'
import { ReplyError } from '../notifications/direct/babe-reply'
import { inboxSnapshot, replyMessage, replyTargetFor, sendReplyAs } from '../notifications/service'
import { autoCandidates, countToday, readAiConfig, runAuto } from './auto'
import { ClaudeError, claudeMessage, claudeVerify, type ClaudeResponse } from './claude'
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
  const code = error instanceof ClaudeError ? error.code : 'SERVER'
  return { message: AI_MESSAGES[code] || AI_MESSAGES.SERVER, code }
}

// 설정
const CONFIG_KEY = 'ai_reply_config'
const config = (): AiReplyConfig => readAiConfig(getSetting(CONFIG_KEY))

// 이번 달 사용량 (이 앱에서 쓴 만큼)
const USAGE_KEY = 'ai_reply_usage'
function readUsage(): AiUsage | null {
  try {
    const value = JSON.parse(getSetting(USAGE_KEY) || 'null') as AiUsage | null
    return value && typeof value.month === 'string' ? value : null
  } catch {
    return null
  }
}
function recordUsage(response: ClaudeResponse): void {
  setSetting(USAGE_KEY, JSON.stringify(addUsage(readUsage(), response, new Date())))
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
  const usage = readUsage() ?? {
    month: '',
    requests: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0
  }
  const thisMonth = usage.month === addUsage(null, {}, new Date()).month
  const shown = thisMonth
    ? usage
    : { ...usage, requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  let examples = { used: 0, total: 0 }
  try {
    const found = await styleExamples()
    examples = { used: found.examples.length, total: found.total }
  } catch {
    // 알림 저장소를 못 열면 0으로 보여준다.
  }
  return {
    hasKey: !!key,
    tail: key ? key.slice(-6) : '',
    config: config(),
    examples,
    usage: { ...shown, cost: usageCost(shown) },
    today: countToday(log, new Date()),
    lastError
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
  const key = getClaudeKey()
  if (!key) return fail(AI_MESSAGES.NO_KEY, 'NO_KEY')
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
    const response = await claudeMessage(
      key,
      draftRequest(examples, {
        platform: INBOX_PLATFORMS[item.platform as InboxPlatform] || item.platform,
        work,
        author: target.author ?? item.actor.name,
        comment
      })
    )
    recordUsage(response)
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
async function tick(): Promise<void> {
  const current = config()
  if (running || current.mode === 'off') return
  if (!getClaudeKey()) {
    lastError = AI_MESSAGES.NO_KEY
    return
  }
  running = true
  try {
    const snapshot = await inboxSnapshot()
    await loadLog()
    const candidates = autoCandidates(
      snapshot.items.map((item) => ({ ...item, comment: item.body })),
      current,
      snapshot.replied,
      log
    )
    if (!candidates.length) return
    const result = await runAuto({
      config: current,
      candidates,
      sentToday: countToday(log, new Date()).sent,
      draft: draftReply,
      send: async (id, content) => {
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
      },
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
}
