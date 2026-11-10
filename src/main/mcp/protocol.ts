// MCP(Model Context Protocol) 요청 한 건을 처리한다. 도구만 내놓는 가장 작은 구현이다.
// 전송(HTTP)과 인증은 server.ts가 맡고, 여기는 JSON-RPC 메시지만 본다 (테스트하기 쉽게 분리).
import type { ToolDef } from '../works/tools'
import { toolMessage } from '../works/tools'

const VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05']

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)

export interface McpInfo {
  name: string
  version: string
}

const fail = (id: unknown, code: number, message: string): Obj => ({
  jsonrpc: '2.0',
  id: id ?? null,
  error: { code, message }
})

/** 메시지 하나 → 응답 하나. 알림(id 없는 메시지)은 응답이 없어 null. */
export function createMcpHandler(
  info: McpInfo,
  tools: ToolDef[]
): (message: unknown) => Promise<Obj | null> {
  const byName = new Map(tools.map((t) => [t.name, t]))

  return async (message) => {
    if (!isObj(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string')
      return fail(isObj(message) ? message.id : null, -32600, 'Invalid Request')
    const { id, method } = message
    const params = isObj(message.params) ? message.params : {}
    if (id === undefined || id === null) return null // 알림
    const ok = (result: unknown): Obj => ({ jsonrpc: '2.0', id, result })

    switch (method) {
      case 'initialize': {
        const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : ''
        return ok({
          protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: info,
          instructions:
            '캐릭터챗 플랫폼에 올린 내 작품을 읽는 도구예요. 먼저 sites_list와 works_list로 ' +
            '플랫폼과 작품 번호를 찾고, work_read로 개요를 본 뒤 필요한 칸만 읽어 주세요.'
        })
      }
      case 'ping':
        return ok({})
      case 'tools/list':
        return ok({
          tools: tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema
          }))
        })
      case 'tools/call': {
        const tool = byName.get(String(params.name))
        if (!tool) return fail(id, -32602, 'Unknown tool')
        try {
          const result = await tool.run(isObj(params.arguments) ? params.arguments : {})
          return ok({
            content: [{ type: 'text', text: JSON.stringify({ ok: true, ...(result as Obj) }) }],
            isError: false
          })
        } catch (error) {
          return ok({
            content: [
              { type: 'text', text: JSON.stringify({ ok: false, message: toolMessage(error) }) }
            ],
            isError: true
          })
        }
      }
      default:
        return fail(id, -32601, 'Method not found')
    }
  }
}
