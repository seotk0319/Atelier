// 이 PC의 작품 MCP를 설정으로 껐을 때(mcp_enabled='0'), 같은 포트에는 맥미니의 작품 MCP로 가는
// 통로가 이어져 있다. 그 통로 너머가 답하는지만 본다. 비밀값 없이 불러 401이 와도 "답함"이다.

export type RemoteMcpState = 'up' | 'down'

export async function probeRemoteMcp(
  port: number,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 1500
): Promise<RemoteMcpState> {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return 'down'
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    await fetchImpl('http://127.0.0.1:' + port + '/mcp', {
      method: 'GET',
      signal: controller.signal
    })
    return 'up'
  } catch {
    return 'down'
  } finally {
    clearTimeout(timer)
  }
}
