// AI 답글(Claude Haiku) 공용 정의. 본체와 화면이 함께 쓴다.
import type { InboxPlatform } from './inbox'

export const AI_MODEL = 'claude-haiku-5-5'

/** off: 꺼짐 / draft: 초안만 채워 둠 / send: 자동으로 보냄 */
export type AiReplyMode = 'off' | 'draft' | 'send'
export const AI_DAILY_LIMITS = [20, 50, 100, 200] as const

export interface AiReplyConfig {
  mode: AiReplyMode
  /** 자동 답글에서 뺀 플랫폼. 비어 있으면(기본) 전부 쓴다. */
  excluded: InboxPlatform[]
  /** 하루에 자동으로 보낼 최대 개수 */
  dailyLimit: number
  /** 자동 답글을 켠 시각. 이 뒤에 들어온 댓글만 자동으로 다룬다. */
  since: string | null
}
export const DEFAULT_AI_CONFIG: AiReplyConfig = {
  mode: 'off',
  excluded: [],
  dailyLimit: 50,
  since: null
}

/** 이 앱에서 쓴 이번 달 토큰 (Claude 응답의 usage를 더한 값) */
export interface AiUsage {
  month: string
  requests: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}
/** 100만 토큰당 달러 (Haiku 5.5) */
export const AI_PRICES = { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 }
export function usageCost(
  usage: Pick<AiUsage, 'input' | 'output' | 'cacheRead' | 'cacheWrite'>
): number {
  return (
    (usage.input * AI_PRICES.input +
      usage.output * AI_PRICES.output +
      usage.cacheRead * AI_PRICES.cacheRead +
      usage.cacheWrite * AI_PRICES.cacheWrite) /
    1_000_000
  )
}

export type AiLogState = 'sent' | 'drafted' | 'skipped' | 'failed'
/** 자동 답글이 알림 하나를 다룬 기록 */
export interface AiLogEntry {
  id: string
  at: string
  state: AiLogState
  platform: string
  author: string | null
  comment: string
  /** AI가 낸 답글 후보 */
  replies: string[]
  /** 실제로 보낸 답글 (sent일 때) */
  content: string | null
  /** 넘긴 이유나 실패 이유 */
  reason: string | null
}

export interface AiReplyStatus {
  hasKey: boolean
  /** 키 끝 6자리 (나머지는 화면에 보내지 않는다) */
  tail: string
  config: AiReplyConfig
  /** 프롬프트에 넣는 말투 예시 수 / 쓸 수 있는 지난 답글 수 */
  examples: { used: number; total: number }
  usage: AiUsage & { cost: number }
  today: { sent: number; drafted: number; skipped: number; failed: number }
  /** 자동 답글이 마지막에 멈춘 이유 (키·크레딧 문제 등) */
  lastError: string | null
}

export interface AiDraftResult {
  ok: boolean
  message: string
  replies: string[]
  /** 직접 봐야 하는 댓글인지 (문의, 불만, 버그 제보 등) */
  handoff: boolean
  reason: string | null
}
