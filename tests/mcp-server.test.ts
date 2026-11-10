import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMcpHandler } from '../src/main/mcp/protocol'
import { createMcpServer, loadConnection } from '../src/main/mcp/server'
import type { ToolDef } from '../src/main/works/tools'

const TOOLS: ToolDef[] = [
  {
    name: 'echo',
    description: '받은 값을 돌려준다',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
    run: async (args) => ({ text: args.text })
  },
  {
    name: 'boom',
    description: '항상 실패',
    inputSchema: { type: 'object', properties: {} },
    run: async () => {
      throw new Error('LOGIN_REQUIRED')
    }
  }
]
const INFO = { name: 'test', version: '0.0.0' }
const rpc = (method: string, params?: unknown, id: unknown = 1): unknown => ({
  jsonrpc: '2.0',
  id,
  method,
  params
})

describe('MCP 메시지 처리', () => {
  const handle = createMcpHandler(INFO, TOOLS)

  it('initialize: 아는 버전은 그대로, 모르는 버전은 최신으로 답한다', async () => {
    const a = await handle(rpc('initialize', { protocolVersion: '2025-03-26' }))
    expect((a!.result as { protocolVersion: string }).protocolVersion).toBe('2025-03-26')
    const b = await handle(rpc('initialize', { protocolVersion: '1999-01-01' }))
    expect((b!.result as { protocolVersion: string }).protocolVersion).toBe('2025-06-18')
  })

  it('알림에는 답하지 않는다', async () => {
    expect(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull()
  })

  it('tools/list와 tools/call', async () => {
    const list = await handle(rpc('tools/list'))
    expect((list!.result as { tools: { name: string }[] }).tools.map((t) => t.name)).toEqual([
      'echo',
      'boom'
    ])
    const call = await handle(rpc('tools/call', { name: 'echo', arguments: { text: '안녕' } }))
    const result = call!.result as { content: { text: string }[]; isError: boolean }
    expect(result.isError).toBe(false)
    expect(JSON.parse(result.content[0].text)).toEqual({ ok: true, text: '안녕' })
  })

  it('도구가 실패하면 쉬운 말로 알리고 isError를 켠다', async () => {
    const call = await handle(rpc('tools/call', { name: 'boom' }))
    const result = call!.result as { content: { text: string }[]; isError: boolean }
    expect(result.isError).toBe(true)
    expect(JSON.parse(result.content[0].text).message).toContain('로그인')
  })

  it('모르는 도구·메서드·잘못된 모양', async () => {
    expect((await handle(rpc('tools/call', { name: 'nope' })))!.error).toMatchObject({
      code: -32602
    })
    expect((await handle(rpc('resources/list')))!.error).toMatchObject({ code: -32601 })
    expect((await handle({ hello: 1 }))!.error).toMatchObject({ code: -32600 })
  })
})

describe('MCP 창구 (HTTP)', () => {
  const PORT = 39391
  const TOKEN = 'a'.repeat(43)
  const URL_ = 'http://127.0.0.1:' + PORT + '/mcp'
  let server: ReturnType<typeof createMcpServer> | null = null
  let dir: string | null = null

  afterEach(async () => {
    await server?.stop()
    server = null
    if (dir) await rm(dir, { recursive: true, force: true })
    dir = null
  })

  const open = async (): Promise<void> => {
    server = createMcpServer({ port: PORT, token: TOKEN, info: INFO, tools: TOOLS })
    await server.start()
  }
  const post = (body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
    fetch(URL_, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ' + TOKEN,
        ...headers
      },
      body: typeof body === 'string' ? body : JSON.stringify(body)
    })

  it('비밀값이 맞으면 도구를 부를 수 있다', async () => {
    await open()
    const res = await post(rpc('tools/call', { name: 'echo', arguments: { text: 'hi' } }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { result: { content: { text: string }[] } }
    expect(JSON.parse(body.result.content[0].text)).toEqual({ ok: true, text: 'hi' })
  })

  it('비밀값이 없거나 틀리면 401', async () => {
    await open()
    expect((await post(rpc('ping'), { authorization: '' })).status).toBe(401)
    expect((await post(rpc('ping'), { authorization: 'Bearer ' + 'b'.repeat(43) })).status).toBe(
      401
    )
  })

  it('웹 페이지에서 온 요청(Origin 있음)은 비밀값이 맞아도 거절한다', async () => {
    await open()
    expect((await post(rpc('ping'), { origin: 'https://evil.example' })).status).toBe(403)
  })

  it('다른 주소·다른 방식', async () => {
    await open()
    const other = await fetch('http://127.0.0.1:' + PORT + '/other', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + TOKEN }
    })
    expect(other.status).toBe(404)
    const get = await fetch(URL_, { headers: { authorization: 'Bearer ' + TOKEN } })
    expect(get.status).toBe(405)
  })

  it('알림은 202, 깨진 본문은 400, 묶음 요청은 배열로 답한다', async () => {
    await open()
    expect((await post({ jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202)
    expect((await post('{not json')).status).toBe(400)
    const batch = await post([rpc('ping', undefined, 1), rpc('tools/list', undefined, 2)])
    expect(((await batch.json()) as unknown[]).length).toBe(2)
  })

  it('연결 정보 파일: 비밀값을 한 번 만들면 포트가 바뀌어도 그대로 둔다', async () => {
    dir = await mkdtemp(join(tmpdir(), 'nais3-mcp-'))
    const file = join(dir, 'mcp', 'connection.json')
    const first = await loadConnection(file, 40001)
    expect(first.token.length).toBeGreaterThanOrEqual(43)
    const second = await loadConnection(file, 40002)
    expect(second.token).toBe(first.token)
    expect(second.url).toBe('http://127.0.0.1:40002/mcp')
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(second)
  })
})
