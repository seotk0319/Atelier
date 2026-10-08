// Claude Messages API 연결부. DeepL 연결부(translate/deepl.ts)와 같은 모양으로,
// 실패는 code가 붙은 ClaudeError로 던진다. 키는 x-api-key 헤더로만 보낸다.
export type ClaudeCode =
  | 'NO_KEY'
  | 'AUTH'
  | 'CREDIT'
  | 'RATE'
  | 'OVERLOADED'
  | 'BAD_REQUEST'
  | 'SERVER'
  | 'NETWORK'
  | 'TIMEOUT'
  | 'REFUSED'

export class ClaudeError extends Error {
  constructor(
    public code: ClaudeCode,
    public status: number | null = null
  ) {
    super(code)
    this.name = 'ClaudeError'
  }
}

export const CLAUDE_BASE = 'https://api.anthropic.com'
const VERSION = '2023-06-01'
const TIMEOUT_MS = 45_000

/** 크레딧이 모자라면 Anthropic은 400에 "credit balance is too low" 문구를 담아 보낸다. */
export function codeForStatus(status: number, message = ''): ClaudeCode {
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 402 || /credit balance|billing/i.test(message)) return 'CREDIT'
  if (status === 429) return 'RATE'
  if (status === 529) return 'OVERLOADED'
  if (status >= 500) return 'SERVER'
  if (status >= 400) return 'BAD_REQUEST'
  return 'SERVER'
}

type Fetch = typeof fetch
async function request(
  key: string,
  path: string,
  init: { method: 'GET' | 'POST'; body?: string },
  fetcher: Fetch
): Promise<unknown> {
  if (!key.trim()) throw new ClaudeError('NO_KEY')
  let response: Response
  try {
    response = await fetcher(CLAUDE_BASE + path, {
      method: init.method,
      body: init.body,
      headers: {
        'x-api-key': key.trim(),
        'anthropic-version': VERSION,
        ...(init.body ? { 'content-type': 'application/json' } : {})
      },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
  } catch (error) {
    const name = (error as { name?: string })?.name
    throw new ClaudeError(name === 'TimeoutError' || name === 'AbortError' ? 'TIMEOUT' : 'NETWORK')
  }
  if (!response.ok) {
    let message = ''
    try {
      const body = (await response.json()) as { error?: { message?: unknown } }
      message = typeof body?.error?.message === 'string' ? body.error.message : ''
    } catch {
      // 본문이 JSON이 아니면 상태 코드만으로 판단한다.
    }
    throw new ClaudeError(codeForStatus(response.status, message), response.status)
  }
  try {
    return await response.json()
  } catch {
    throw new ClaudeError('SERVER', response.status)
  }
}

/** 키 확인: 모델 목록을 한 줄만 읽는다 (토큰을 쓰지 않는다). */
export async function claudeVerify(key: string, fetcher: Fetch = fetch): Promise<void> {
  await request(key, '/v1/models?limit=1', { method: 'GET' }, fetcher)
}

export interface ClaudeResponse {
  content?: { type?: string; name?: string; input?: unknown; text?: string }[]
  stop_reason?: string | null
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
  }
}

export async function claudeMessage(
  key: string,
  body: Record<string, unknown>,
  fetcher: Fetch = fetch
): Promise<ClaudeResponse> {
  return (await request(
    key,
    '/v1/messages',
    { method: 'POST', body: JSON.stringify(body) },
    fetcher
  )) as ClaudeResponse
}
