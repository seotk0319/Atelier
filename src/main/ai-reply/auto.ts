// 자동 답글 규칙. 어떤 댓글을 다룰지 고르고, 초안을 받아 넘기거나 보내고 기록한다.
// 실제 Claude 호출과 답글 전송은 밖에서 넣어 주므로 검사에서 그대로 돌려 볼 수 있다.
import {
  AI_DAILY_LIMITS,
  DEFAULT_AI_CONFIG,
  type AiDraftResult,
  type AiLogEntry,
  type AiReplyConfig,
  type AiReplyMode
} from '../../shared/ai-reply'
import { INBOX_PLATFORMS, type InboxPlatform } from '../../shared/inbox'

const MODES: AiReplyMode[] = ['off', 'draft', 'send']
/** 저장된 설정을 읽는다. 모르는 값은 기본값으로 바꾼다 (모드는 꺼짐). */
export function readAiConfig(raw: string | null): AiReplyConfig {
  try {
    const value = (JSON.parse(raw || '{}') || {}) as Partial<AiReplyConfig>
    const platforms = Object.keys(INBOX_PLATFORMS)
    return {
      mode: MODES.includes(value.mode as AiReplyMode) ? (value.mode as AiReplyMode) : 'off',
      excluded: Array.isArray(value.excluded)
        ? (value.excluded.filter((p) => platforms.includes(p)) as InboxPlatform[])
        : [],
      dailyLimit: (AI_DAILY_LIMITS as readonly number[]).includes(Number(value.dailyLimit))
        ? Number(value.dailyLimit)
        : DEFAULT_AI_CONFIG.dailyLimit,
      since: typeof value.since === 'string' && Date.parse(value.since) ? value.since : null
    }
  } catch {
    return { ...DEFAULT_AI_CONFIG }
  }
}

export interface AutoItem {
  id: string
  platform: string
  event: string
  at: string | null
  author: string | null
  comment: string
  canReply: boolean
}

/** 한 번 돌 때 다루는 최대 개수와, 보낸 답글 사이 간격 */
export const AUTO_BATCH = 5
export const AUTO_GAP_MS = 20_000

/**
 * 자동으로 다룰 댓글: 켠 뒤에 들어온 새 댓글 가운데 답글을 달 수 있고, 아직 답글도 기록도 없는 것.
 * 오래된 것부터 고른다. 답글 알림(내 답글에 달린 답글)은 대화가 이어질 수 있어 자동으로 다루지 않는다.
 */
export function autoCandidates(
  items: AutoItem[],
  config: AiReplyConfig,
  replied: Record<string, unknown>,
  log: Record<string, AiLogEntry>,
  limit = AUTO_BATCH
): AutoItem[] {
  if (config.mode === 'off' || !config.since) return []
  const since = Date.parse(config.since)
  if (!Number.isFinite(since)) return []
  const excluded = new Set<string>(config.excluded)
  return items
    .filter(
      (item) =>
        item.event === 'comment' &&
        item.canReply &&
        !excluded.has(item.platform) &&
        !!item.at &&
        Date.parse(item.at) >= since &&
        !replied[item.id] &&
        !log[item.id]
    )
    .sort((a, b) => Date.parse(a.at!) - Date.parse(b.at!))
    .slice(0, limit)
}

const localDay = (date: Date): string =>
  `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`

/** 오늘(이 PC 날짜 기준) 상태별 개수 */
export function countToday(
  log: Record<string, AiLogEntry>,
  now: Date
): { sent: number; drafted: number; skipped: number; failed: number } {
  const today = localDay(now)
  const counts = { sent: 0, drafted: 0, skipped: 0, failed: 0 }
  for (const entry of Object.values(log)) {
    if (localDay(new Date(entry.at)) === today) counts[entry.state]++
  }
  return counts
}

/** 다시 시도하면 풀릴 문제(키, 크레딧, 서버, 네트워크, 로그인)는 기록하지 않고 이번 차례를 멈춘다. */
export const STOP_CODES = new Set([
  'NO_KEY',
  'AUTH',
  'CREDIT',
  'RATE',
  'OVERLOADED',
  'SERVER',
  'NETWORK',
  'TIMEOUT'
])
/** 그 플랫폼만 이번 차례에 건너뛴다 (로그인이 풀린 경우 다시 로그인하면 이어서 다룬다). */
export const PLATFORM_CODES = new Set(['LOGIN_REQUIRED'])

export interface AutoDeps {
  config: AiReplyConfig
  candidates: AutoItem[]
  sentToday: number
  draft(id: string): Promise<AiDraftResult & { code?: string }>
  send(id: string, content: string): Promise<{ ok: boolean; message: string; code?: string }>
  record(entry: AiLogEntry): Promise<void> | void
  wait(ms: number): Promise<void>
  now(): Date
  /** 도중에 꺼졌는지 매번 다시 본다 (없으면 계속 켜진 것으로 본다) */
  active?(): boolean
}

export interface AutoResult {
  handled: number
  sent: number
  /** 멈춘 이유 (키·크레딧 문제 등). 없으면 null */
  stopped: string | null
}

export async function runAuto(deps: AutoDeps): Promise<AutoResult> {
  const { config } = deps
  let sent = deps.sentToday
  let sentNow = 0
  let handled = 0
  const skipPlatforms = new Set<string>()
  for (const item of deps.candidates) {
    if (config.mode === 'off' || (deps.active && !deps.active())) break
    if (config.mode === 'send' && sent >= config.dailyLimit) break
    if (skipPlatforms.has(item.platform)) continue
    const base = {
      id: item.id,
      platform: item.platform,
      author: item.author,
      comment: item.comment.slice(0, 1000)
    }
    const draft = await deps.draft(item.id)
    if (!draft.ok) {
      if (draft.code && STOP_CODES.has(draft.code))
        return { handled, sent: sentNow, stopped: draft.message }
      if (draft.code && PLATFORM_CODES.has(draft.code)) {
        skipPlatforms.add(item.platform)
        continue
      }
      await deps.record({
        ...base,
        at: deps.now().toISOString(),
        state: 'failed',
        replies: [],
        content: null,
        reason: draft.message
      })
      handled++
      continue
    }
    if (draft.handoff || config.mode === 'draft') {
      await deps.record({
        ...base,
        at: deps.now().toISOString(),
        state: draft.handoff ? 'skipped' : 'drafted',
        replies: draft.replies,
        content: null,
        reason: draft.handoff ? draft.reason : null
      })
      handled++
      continue
    }
    if (sentNow > 0) await deps.wait(AUTO_GAP_MS)
    const content = draft.replies[0]
    const result = await deps.send(item.id, content)
    if (!result.ok && result.code && PLATFORM_CODES.has(result.code)) {
      skipPlatforms.add(item.platform)
      continue
    }
    await deps.record({
      ...base,
      at: deps.now().toISOString(),
      state: result.ok ? 'sent' : 'failed',
      replies: draft.replies,
      content: result.ok ? content : null,
      reason: result.ok ? null : result.message
    })
    handled++
    if (result.ok) {
      sent++
      sentNow++
    }
  }
  return { handled, sent: sentNow, stopped: null }
}
/**
 * 지난 댓글 일괄 답글 대상: 범위 안의 답글 안 단 댓글, 최근 것부터.
 * 이미 다룬 댓글(보냄·넘김·실패)은 빼고, 바로 보내기일 때만 초안이 남은 댓글을 넣는다.
 */
export function backlogCandidates(
  items: AutoItem[],
  platforms: string[],
  replied: Record<string, unknown>,
  log: Record<string, AiLogEntry>,
  options: { days: number; now: Date; includeDrafted: boolean }
): AutoItem[] {
  const from = options.days > 0 ? options.now.getTime() - options.days * 86_400_000 : -Infinity
  const allowed = new Set(platforms)
  return items
    .filter((item) => {
      if (item.event !== 'comment' || !item.canReply || !allowed.has(item.platform)) return false
      const at = item.at ? Date.parse(item.at) : NaN
      if (!(at >= from) || replied[item.id]) return false
      const entry = log[item.id]
      return !entry || (options.includeDrafted && entry.state === 'drafted')
    })
    .sort((a, b) => Date.parse(b.at!) - Date.parse(a.at!))
}
