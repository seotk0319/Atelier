// AI 답글을 DeepSeek(OpenRouter)로 받는다. Claude용 요청(시스템 프롬프트 + reply_drafts 도구)을
// 그대로 받아 JSON 답으로 바꿔 묻고, 답을 Claude 응답 모양으로 돌려준다. 그래서 readDraft·사용량
// 기록은 Claude와 같은 코드를 쓴다.
import { DEEPSEEK_MODEL } from '../../shared/llm'
import { openrouterChatFull, type ChatOptions, type ChatResult } from '../llm/openrouter'
import type { ClaudeResponse } from '../llm/claude'
import { DRAFT_TOOL } from './prompt'

type Chat = (key: string, options: ChatOptions) => Promise<ChatResult>

const JSON_RULE = [
  '',
  '답은 아래 모양의 JSON 하나로만 낸다. 코드 블록, 설명, 앞뒤 말을 붙이지 않는다.',
  '{"language":"ko","handoff":false,"reason":"","replies":["후보1","후보2","후보3"]}',
  '- language: 댓글 언어 (ko, en, ja, zh-Hant, zh-Hans)',
  '- handoff: 크리에이터가 직접 봐야 하는 댓글이면 true',
  '- reason: handoff일 때 이유 (한국어 한 문장), 아니면 빈 문자열',
  '- replies: 답글 후보 1~3개, 댓글과 같은 언어로',
  '',
  '중국어 댓글: 댓글에 번체 글자(예: 純, 體, 這, 們, 謝, 歡, 愛, 個, 還, 來)가 하나라도 있으면 답글은 반드시 번체로 쓴다 (예: 謝謝喜歡). 간체 글자만 있을 때만 간체로 쓴다.'
].join('\n')

function systemText(body: Record<string, unknown>): string {
  const system = body.system
  if (typeof system === 'string') return system
  if (Array.isArray(system))
    return system
      .map((block) =>
        block && typeof block === 'object' ? String((block as { text?: unknown }).text ?? '') : ''
      )
      .join('\n')
  return ''
}

function userText(body: Record<string, unknown>): string {
  const messages = Array.isArray(body.messages) ? body.messages : []
  return messages
    .map((m) => {
      const content = (m as { content?: unknown })?.content
      return typeof content === 'string' ? content : ''
    })
    .join('\n')
    .replace('reply_drafts 도구로 답글 후보 3개를 내 줘.', 'JSON으로 답글 후보 3개를 내 줘.')
}

/** 모델 답에서 JSON 객체를 꺼낸다. 못 꺼내면 null */
export function parseDraftJson(raw: string): Record<string, unknown> | null {
  const clean = String(raw ?? '')
    .replace(/^\s*```[a-z]*\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim()
  const candidates = [clean]
  const start = clean.indexOf('{')
  const end = clean.lastIndexOf('}')
  if (start >= 0 && end > start) candidates.push(clean.slice(start, end + 1))
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
        return parsed as Record<string, unknown>
    } catch {
      // 다음 후보
    }
  }
  return null
}

export async function deepseekDraft(
  key: string,
  body: Record<string, unknown>,
  chat: Chat = openrouterChatFull
): Promise<ClaudeResponse> {
  const result = await chat(key, {
    model: DEEPSEEK_MODEL,
    messages: [
      { role: 'system', content: systemText(body) + '\n' + JSON_RULE },
      { role: 'user', content: userText(body) }
    ],
    maxTokens: 800,
    temperature: 0.7
  })
  const input = parseDraftJson(result.text)
  return {
    // JSON을 못 읽으면 도구 호출이 없는 응답이 되어 readDraft가 REFUSED로 처리한다.
    content: input ? [{ type: 'tool_use', name: DRAFT_TOOL.name, input }] : [],
    stop_reason: input ? 'tool_use' : 'end_turn',
    usage: { input_tokens: result.usage.input, output_tokens: result.usage.output }
  }
}
