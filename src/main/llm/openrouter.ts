// OpenRouter Chat Completions 연결부. DeepL·Claude 연결부와 같은 모양으로,
// 실패는 code가 붙은 OpenRouterError로 던진다. 키는 Authorization 헤더로만 보낸다.
import { DEEPSEEK_MODEL } from '../../shared/llm'

export type OpenRouterCode =
  'NO_KEY' | 'AUTH' | 'CREDIT' | 'RATE' | 'BAD_REQUEST' | 'SERVER' | 'NETWORK' | 'TIMEOUT' | 'EMPTY'

export class OpenRouterError extends Error {
  constructor(
    public code: OpenRouterCode,
    public status: number | null = null
  ) {
    super(code)
    this.name = 'OpenRouterError'
  }
}

export const OPENROUTER_BASE = 'https://openrouter.ai/api/v1'

export const OPENROUTER_MESSAGES: Record<OpenRouterCode | 'UNKNOWN', string> = {
  NO_KEY: 'OpenRouter API 키가 아직 없어요. 설정 > AI 도우미에서 키를 넣어주세요.',
  AUTH: 'OpenRouter 인증에 실패했어요. 설정의 API 키를 확인해주세요.',
  CREDIT: 'OpenRouter 크레딧이 모자라요. 충전한 뒤 다시 시도해주세요.',
  RATE: '요청이 잠깐 몰렸어요. 조금 뒤 다시 시도해주세요.',
  BAD_REQUEST: 'OpenRouter가 요청을 받지 않았어요. 글이나 그림을 확인해주세요.',
  SERVER: 'OpenRouter 서버에 문제가 있어요. 잠시 뒤 다시 시도해주세요.',
  NETWORK: '네트워크에 연결할 수 없어요. 인터넷 연결을 확인해주세요.',
  TIMEOUT: '응답이 너무 늦어요. 다시 시도해주세요.',
  EMPTY: '모델이 빈 답을 보냈어요. 다시 시도해주세요.',
  UNKNOWN: '알 수 없는 오류가 났어요. 다시 시도해주세요.'
}
export const openRouterMessage = (error: unknown): string =>
  OPENROUTER_MESSAGES[error instanceof OpenRouterError ? error.code : 'UNKNOWN']

export function codeForStatus(status: number): OpenRouterCode {
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 402) return 'CREDIT'
  if (status === 429) return 'RATE'
  if (status >= 500) return 'SERVER'
  if (status >= 400) return 'BAD_REQUEST'
  return 'SERVER'
}

export type ChatPart =
  { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string | ChatPart[]
}
export interface ChatOptions {
  messages: ChatMessage[]
  model?: string
  maxTokens?: number
  temperature?: number
  timeoutMs?: number
}

type Fetch = typeof fetch

async function call(
  key: string,
  path: string,
  init: { method: 'GET' | 'POST'; body?: string; timeoutMs: number },
  fetcher: Fetch
): Promise<unknown> {
  if (!key.trim()) throw new OpenRouterError('NO_KEY')
  let response: Response
  try {
    response = await fetcher(OPENROUTER_BASE + path, {
      method: init.method,
      body: init.body,
      headers: {
        Authorization: 'Bearer ' + key.trim(),
        'HTTP-Referer': 'https://github.com/seotk0319/Atelier',
        'X-Title': 'Atelier',
        ...(init.body ? { 'Content-Type': 'application/json' } : {})
      },
      signal: AbortSignal.timeout(init.timeoutMs)
    })
  } catch (error) {
    const name = (error as { name?: string })?.name
    throw new OpenRouterError(
      name === 'TimeoutError' || name === 'AbortError' ? 'TIMEOUT' : 'NETWORK'
    )
  }
  if (!response.ok) throw new OpenRouterError(codeForStatus(response.status), response.status)
  try {
    return await response.json()
  } catch {
    throw new OpenRouterError('SERVER', response.status)
  }
}

export interface ChatResult {
  text: string
  usage: { input: number; output: number }
}

/** 한 번 묻고 답 텍스트와 토큰 수를 돌려준다. 추론(reasoning) 없이 바로 답하게 한다. */
export async function openrouterChatFull(
  key: string,
  options: ChatOptions,
  fetcher: Fetch = fetch
): Promise<ChatResult> {
  const body = {
    model: options.model || DEEPSEEK_MODEL,
    messages: options.messages,
    max_tokens: options.maxTokens ?? 1200,
    temperature: options.temperature ?? 0.3,
    reasoning: { enabled: false }
  }
  const data = (await call(
    key,
    '/chat/completions',
    { method: 'POST', body: JSON.stringify(body), timeoutMs: options.timeoutMs ?? 60_000 },
    fetcher
  )) as { choices?: { message?: { content?: unknown } }[]; error?: { code?: number } }
  if (data?.error) throw new OpenRouterError(codeForStatus(Number(data.error.code) || 500))
  const text = data?.choices?.[0]?.message?.content
  if (typeof text !== 'string' || !text.trim()) throw new OpenRouterError('EMPTY')
  const usage = (data as { usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } })
    ?.usage
  const n = (v: unknown): number => (typeof v === 'number' && v > 0 ? v : 0)
  return {
    text: text.trim(),
    usage: { input: n(usage?.prompt_tokens), output: n(usage?.completion_tokens) }
  }
}

/** 답 텍스트만 필요할 때 */
export async function openrouterChat(
  key: string,
  options: ChatOptions,
  fetcher: Fetch = fetch
): Promise<string> {
  return (await openrouterChatFull(key, options, fetcher)).text
}

/** 키 확인. 맞으면 사용액/한도(달러)를 돌려준다. */
export async function openrouterKeyInfo(
  key: string,
  fetcher: Fetch = fetch
): Promise<{ usage: number | null; limit: number | null }> {
  const data = (await call(key, '/key', { method: 'GET', timeoutMs: 15_000 }, fetcher)) as {
    data?: { usage?: unknown; limit?: unknown }
  }
  const num = (v: unknown): number | null => (typeof v === 'number' ? v : null)
  return { usage: num(data?.data?.usage), limit: num(data?.data?.limit) }
}
