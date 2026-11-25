/**
 * NAI 요청 오류를 사람이 알아들을 말로 바꾼다. 응답 본문의 모양은 추측하지 않고 상태 코드로만 가른다.
 * 알 수 없는 코드만 본문 앞부분을 짧게 붙인다 (원인 찾기용).
 */
function actionHead(action: string): string {
  return action === '생성' ? '' : `${action} 실패: `
}

export function friendlyNaiStatus(action: string, status: number, body: string): string {
  // 생성 오류는 화면이 「N장 생성 실패 — …」로 앞에 붙이므로 머리말을 두 번 달지 않는다
  const head = actionHead(action)
  if (status === 401)
    return `${head}NAI 토큰이 맞지 않거나 만료됐어요. 설정 › NAI 계정에서 토큰을 다시 넣어 주세요. (401)`
  if (status === 402)
    return `${head}Anlas가 부족하거나 NovelAI 구독이 없어요. NovelAI 계정의 구독·Anlas를 확인해 주세요. (402)`
  if (status === 403)
    return `${head}NAI가 이 계정의 요청을 거절했어요. 구독 등급이나 계정 상태를 확인해 주세요. (403)`
  if (status === 429)
    return `${head}NAI가 동시에 너무 많은 요청을 막았어요. 잠시 뒤 다시 해 주세요. (429)`
  if (status >= 500)
    return `${head}NAI 서버가 잠시 응답하지 않아요. 잠시 뒤 다시 해 주세요. (${status})`
  const detail = body.replace(/\s+/g, ' ').trim().slice(0, 160)
  return `${head}NAI가 요청을 받지 않았어요. (${status})${detail ? ' ' + detail : ''}`
}

/** 연결 단계에서 끊긴 오류 코드 — 요청이 서버에 닿지 않았으니 다시 보내도 두 번 과금되지 않는다 */
const NOT_SENT_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED'])
const NETWORK_CODES = new Set([
  ...NOT_SENT_CODES,
  'ECONNRESET',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'ENETUNREACH',
  'EHOSTUNREACH'
])

/** fetch가 응답 전에 실패했을 때(인터넷 끊김 등) 쓰는 오류. retryable이면 큐가 다시 보낸다 */
export class NaiNetworkError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean
  ) {
    super(message)
    this.name = 'NaiNetworkError'
  }
}

/** fetch()가 던진 오류를 쉬운 말로 바꾼다. 취소(AbortError)는 그대로 돌려준다 */
export function networkError(action: string, error: unknown): unknown {
  if (!(error instanceof Error) || error.name === 'AbortError') return error
  const cause = (error as { cause?: { code?: unknown } }).cause
  const code = typeof cause?.code === 'string' ? cause.code : ''
  if (!(error instanceof TypeError) && !NETWORK_CODES.has(code)) return error
  return new NaiNetworkError(
    `${actionHead(action)}NAI 서버에 닿지 못했어요. 인터넷 연결을 확인해 주세요.${code ? ` (${code})` : ''}`,
    code,
    NOT_SENT_CODES.has(code)
  )
}
