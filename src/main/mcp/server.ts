// AI 도구(Claude Code 등)가 NAIS3의 작품 도구를 부르는 창구. 이 PC 안에서만 열린다.
// - 127.0.0.1에만 묶는다. 다른 기기에서는 닿지 않는다.
// - 연결 정보 파일의 비밀값(Bearer)이 맞아야 한다.
// - 웹 페이지가 몰래 부르지 못하게 Origin이 붙은 요청과 다른 Host는 거절한다.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { createMcpHandler, type McpInfo } from './protocol'
import type { ToolDef } from '../works/tools'

export const MCP_DEFAULT_PORT = 39317
const MAX_BODY = 1_000_000

export interface McpConnection {
  url: string
  token: string
}

/** 연결 정보(주소·비밀값)를 읽고, 없으면 새로 만든다. 비밀값은 포트가 바뀌어도 그대로 둔다. */
export async function loadConnection(file: string, port: number): Promise<McpConnection> {
  const url = 'http://127.0.0.1:' + port + '/mcp'
  let token = ''
  try {
    const saved = JSON.parse(await readFile(file, 'utf8')) as Partial<McpConnection>
    if (typeof saved.token === 'string' && saved.token.length >= 32) token = saved.token
  } catch {
    // 처음이거나 손상된 파일
  }
  if (!token) token = randomBytes(32).toString('base64url')
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify({ url, token }, null, 2))
  return { url, token }
}

function sameToken(header: string | undefined, token: string): boolean {
  const given = Buffer.from(String(header || '').replace(/^Bearer\s+/i, ''))
  const wanted = Buffer.from(token)
  return given.length === wanted.length && timingSafeEqual(given, wanted)
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('TOO_LARGE'))
        req.destroy()
      } else chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

export function createMcpServer(options: {
  port: number
  token: string
  info: McpInfo
  tools: ToolDef[]
}): { start(): Promise<void>; stop(): Promise<void> } {
  const handle = createMcpHandler(options.info, options.tools)
  const hosts = new Set(['127.0.0.1:' + options.port, 'localhost:' + options.port])
  let server: Server | null = null

  const send = (res: ServerResponse, status: number, body?: unknown): void => {
    if (body === undefined) {
      res.writeHead(status).end()
      return
    }
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body))
  }

  async function onRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!hosts.has(String(req.headers.host || ''))) return send(res, 403)
    if (req.headers.origin !== undefined) return send(res, 403)
    if ((req.url || '').split('?')[0] !== '/mcp') return send(res, 404)
    if (!sameToken(req.headers.authorization, options.token)) return send(res, 401)
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST' }).end()
      return
    }
    let message: unknown
    try {
      message = JSON.parse(await readBody(req))
    } catch {
      return send(res, 400, {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' }
      })
    }
    if (Array.isArray(message)) {
      const replies = (await Promise.all(message.map(handle))).filter((r) => r !== null)
      return replies.length ? send(res, 200, replies) : send(res, 202)
    }
    const reply = await handle(message)
    return reply ? send(res, 200, reply) : send(res, 202)
  }

  return {
    start() {
      return new Promise((resolve, reject) => {
        const s = createServer((req, res) => {
          void onRequest(req, res).catch(() => {
            if (!res.headersSent) send(res, 500)
            else res.end()
          })
        })
        s.once('error', reject)
        s.listen(options.port, '127.0.0.1', () => {
          s.off('error', reject)
          server = s
          resolve()
        })
      })
    },
    stop() {
      return new Promise((resolve) => {
        if (!server) return resolve()
        const s = server
        server = null
        s.close(() => resolve())
        s.closeAllConnections()
      })
    }
  }
}
