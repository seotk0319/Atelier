// AI 답글 프롬프트. 지난 답글로 말투 예시를 고르고, Claude에 보낼 요청을 만들고, 응답을 읽는다.
// 전부 순수 함수라 본체(service.ts)와 검사가 같이 쓴다.
import { AI_MODEL, type AiUsage } from '../../shared/ai-reply'
import type { InboxReplied } from '../../shared/inbox'
import { ClaudeError, type ClaudeResponse } from './claude'

export interface StyleExample {
  comment: string
  reply: string
}

export const EXAMPLE_LIMIT = 40
const COMMENT_MAX = 300
const REPLY_EXAMPLE_MAX = 300
export const DRAFT_MAX = 1000

const squash = (value: string): string => value.replace(/\s+/g, ' ').trim()

/**
 * 지난 답글 기록(알림 id → 내 답글)과 저장된 알림 본문을 짝지어 말투 예시를 만든다.
 * AI가 보낸 답글은 빼고(자기 글을 따라 하지 않게), 같은 답글은 한 번만, 최근 것부터 고른다.
 */
export function pickExamples(
  comments: Map<string, string>,
  replied: Record<string, InboxReplied>,
  limit = EXAMPLE_LIMIT
): { examples: StyleExample[]; total: number } {
  const rows = Object.entries(replied)
    .filter(([, entry]) => entry.via !== 'ai')
    .map(([id, entry]) => ({
      at: Date.parse(entry.at) || 0,
      comment: squash(comments.get(id) || '').slice(0, COMMENT_MAX),
      reply: String(entry.content || '').trim()
    }))
    .filter((row) => row.comment && row.reply && row.reply.length <= REPLY_EXAMPLE_MAX)
    .sort((a, b) => b.at - a.at)
  const seen = new Set<string>()
  const unique = rows.filter((row) => {
    const key = squash(row.reply)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  return {
    examples: unique.slice(0, limit).map(({ comment, reply }) => ({ comment, reply })),
    total: unique.length
  }
}

export function systemPrompt(examples: StyleExample[]): string {
  const sample = examples.length
    ? examples
        .map((e, i) => `${i + 1}. 댓글: ${e.comment}\n   답글: ${e.reply.replace(/\n/g, '\n   ')}`)
        .join('\n')
    : '(아직 지난 답글이 없다. 짧고 다정한 감사 인사로 쓴다.)'
  return [
    '너는 캐릭터챗 크리에이터를 대신해, 크리에이터 작품에 달린 댓글에 짧은 감사 답글 초안을 쓴다.',
    '',
    '규칙',
    '- 답글은 감사 인사와, 댓글 내용에 맞춘 짧은 한마디까지만 쓴다.',
    '- 업데이트 일정, 새 작품, 이벤트를 약속하거나 예고하지 않는다. 질문에 답하거나 설정을 설명하지 않는다.',
    '- 크리에이터나 캐릭터에 대한 사실을 지어내지 않는다.',
    '- 댓글과 같은 언어로 쓴다. 한국어 댓글은 한국어, 영어 댓글은 영어, 일본어 댓글은 일본어로 쓰고, 중국어 댓글은 댓글과 같은 글자(번체 또는 간체)로 쓴다. 여러 언어가 섞이면 가장 많이 쓴 언어를 따른다.',
    '- 말투, 길이, 이모지와 물결표를 쓰는 습관은 아래 지난 답글을 따른다. 외국어로 쓸 때도 그 온도와 습관을 그 언어에 맞게 살린다.',
    '- 지난 답글 문장을 그대로 베끼지 말고 새로 쓴다. 후보끼리도 서로 다르게 쓴다.',
    '',
    'handoff를 true로 하는 댓글 (크리에이터가 직접 봐야 한다)',
    '- 질문, 문의, 요청 (설정, 오류, 업데이트 일정, 결제 등)',
    '- 버그나 오류 제보, 불만, 비판, 항의',
    '- 민감한 내용 (개인 사정, 괴롭힘, 다툼, 신고), 스팸이나 광고',
    '- 뜻이 애매해서 감사 인사만으로는 어색한 댓글',
    'handoff여도 replies에는 크리에이터가 고쳐 쓸 수 있는 초안을 적는다. reason에는 직접 봐야 하는 이유를 한국어 한 문장으로 쓴다.',
    '',
    '크리에이터의 지난 답글 (댓글 → 답글)',
    sample
  ].join('\n')
}

export const DRAFT_TOOL = {
  name: 'reply_drafts',
  description: '댓글에 달 답글 후보를 낸다.',
  input_schema: {
    type: 'object',
    properties: {
      language: { type: 'string', description: '댓글 언어 (예: ko, en, ja, zh-Hant, zh-Hans)' },
      handoff: { type: 'boolean', description: '크리에이터가 직접 봐야 하는 댓글이면 true' },
      reason: { type: 'string', description: 'handoff일 때 이유 (한국어 한 문장)' },
      replies: {
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
        maxItems: 3,
        description: '답글 후보. 댓글과 같은 언어로.'
      }
    },
    required: ['language', 'handoff', 'replies']
  }
}

export interface DraftInput {
  platform: string
  work: string | null
  author: string | null
  comment: string
}

export function draftRequest(examples: StyleExample[], input: DraftInput): Record<string, unknown> {
  const lines = [
    `플랫폼: ${input.platform}`,
    input.work ? `작품: ${input.work}` : null,
    input.author ? `작성자: ${input.author}` : null,
    '댓글:',
    '"""',
    input.comment.trim().slice(0, 2000),
    '"""',
    '',
    'reply_drafts 도구로 답글 후보 3개를 내 줘.'
  ].filter((line): line is string => line !== null)
  return {
    model: AI_MODEL,
    max_tokens: 800,
    // 말투 예시가 든 시스템 프롬프트는 댓글마다 같아서 캐시해 둔다.
    system: [{ type: 'text', text: systemPrompt(examples), cache_control: { type: 'ephemeral' } }],
    tools: [DRAFT_TOOL],
    tool_choice: { type: 'tool', name: DRAFT_TOOL.name },
    messages: [{ role: 'user', content: lines.join('\n') }]
  }
}

export interface Draft {
  replies: string[]
  handoff: boolean
  reason: string | null
}

/** 도구 호출 결과를 읽는다. 거절했거나 후보가 없으면 REFUSED. */
export function readDraft(response: ClaudeResponse): Draft {
  if (response.stop_reason === 'refusal') throw new ClaudeError('REFUSED')
  const call = (response.content || []).find(
    (block) => block.type === 'tool_use' && block.name === DRAFT_TOOL.name
  )
  const input = (call?.input || {}) as { replies?: unknown; handoff?: unknown; reason?: unknown }
  const seen = new Set<string>()
  const replies = (Array.isArray(input.replies) ? input.replies : [])
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim().slice(0, DRAFT_MAX))
    .filter((value) => {
      if (!value || seen.has(value)) return false
      seen.add(value)
      return true
    })
    .slice(0, 3)
  if (!replies.length) throw new ClaudeError('REFUSED')
  const handoff = input.handoff === true
  const reason =
    typeof input.reason === 'string' && input.reason.trim() ? input.reason.trim() : null
  return { replies, handoff, reason: handoff ? reason || '직접 확인이 필요한 댓글이에요.' : null }
}

export const monthOf = (date: Date): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`

/** 이번 달 사용량에 응답 하나의 usage를 더한다. 달이 바뀌면 새로 센다. */
export function addUsage(previous: AiUsage | null, response: ClaudeResponse, now: Date): AiUsage {
  const month = monthOf(now)
  const base: AiUsage =
    previous && previous.month === month
      ? previous
      : { month, requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  const u = response.usage || {}
  const n = (value: unknown): number => (typeof value === 'number' && value > 0 ? value : 0)
  return {
    month,
    requests: base.requests + 1,
    input: base.input + n(u.input_tokens),
    output: base.output + n(u.output_tokens),
    cacheRead: base.cacheRead + n(u.cache_read_input_tokens),
    cacheWrite: base.cacheWrite + n(u.cache_creation_input_tokens)
  }
}
