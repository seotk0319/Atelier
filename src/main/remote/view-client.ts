// 집 PC 쪽: 맥미니(아틀리에MCP)의 /view 에서 화면에 쓸 내용을 받아 온다.
// 읽기 채널의 답은 디스크에 두었다가, 맥미니와 끊겼을 때 받은 시각과 함께 돌려준다.
// 이 파일은 캐챗 사이트에 닿지 않는다. 닿는 곳은 127.0.0.1의 통로(맥미니)뿐이다.
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RemoteStamp, ViewReply } from '../../shared/remote-view'

export const REMOTE_DOWN = '맥미니와 끊겨 있어요. 연결되면 다시 해주세요.'

export class RemoteError extends Error {
  /** down: 맥미니에 닿지 못함 / refused: 닿았지만 맥미니가 실패로 답함 */
  constructor(
    readonly kind: 'down' | 'refused',
    message: string
  ) {
    super(message)
  }
}

export interface ViewClient {
  /** 읽기: 받으면 캐시에 남기고, 못 받으면 마지막으로 받은 것을 stale로 돌려준다 */
  read<T>(
    channel: string,
    req?: unknown,
    options?: { cacheAs?: unknown }
  ): Promise<{ res: T; stamp: RemoteStamp }>
  /** 단추: 맥미니에 전한다. 끊겼으면 RemoteError('down') */
  act<T>(channel: string, req?: unknown): Promise<T>
  /** 작품 썸네일. 받은 것은 디스크에 두고 끊겼을 때 다시 쓴다 */
  thumb(url: string): Promise<{ type: string; bytes: Uint8Array } | null>
  /** 통로 너머가 답하는지 */
  reachable(): Promise<boolean>
}

const READ_TIMEOUT = 20_000
const ACT_TIMEOUT = 90_000
const KEEP_PER_CHANNEL = 40
const THUMB_TTL = 3 * 24 * 60 * 60_000

const hash = (value: unknown): string =>
  createHash('sha1')
    .update(JSON.stringify(value ?? null))
    .digest('hex')
    .slice(0, 16)
const safeName = (channel: string): string => channel.replace(/[^A-Za-z0-9]/g, '_')

export function createViewClient(options: {
  port: () => number
  /** 맥미니와 같은 비밀값이 든 연결 정보 파일 (mcp/connection.json) */
  tokenFile: string
  cacheDir: string
  fetchImpl?: typeof fetch
  now?: () => number
}): ViewClient {
  const fetchImpl = options.fetchImpl ?? fetch
  const now = options.now ?? Date.now
  const base = (): string => 'http://127.0.0.1:' + options.port()

  async function token(): Promise<string> {
    try {
      const saved = JSON.parse(await readFile(options.tokenFile, 'utf8')) as { token?: unknown }
      return typeof saved.token === 'string' ? saved.token : ''
    } catch {
      return ''
    }
  }

  async function call(path: string, init: RequestInit, timeoutMs: number): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      return await fetchImpl(base() + path, {
        ...init,
        headers: { ...(init.headers as object), authorization: 'Bearer ' + (await token()) },
        signal: controller.signal
      })
    } catch {
      throw new RemoteError('down', REMOTE_DOWN)
    } finally {
      clearTimeout(timer)
    }
  }

  async function ask(channel: string, req: unknown, timeoutMs: number): Promise<ViewReply> {
    const response = await call(
      '/view',
      { method: 'POST', body: JSON.stringify({ channel, req: req ?? null }) },
      timeoutMs
    )
    // 401·404: 통로 너머가 옛 판이거나 비밀값이 다르다. 받을 수 없으니 끊긴 것과 같이 다룬다
    if (!response.ok) throw new RemoteError('down', REMOTE_DOWN)
    try {
      return (await response.json()) as ViewReply
    } catch {
      throw new RemoteError('down', REMOTE_DOWN)
    }
  }

  const cacheFile = (channel: string, req: unknown): string =>
    join(options.cacheDir, safeName(channel) + '-' + hash(req) + '.json')

  async function writeCache(file: string, body: unknown): Promise<void> {
    await mkdir(options.cacheDir, { recursive: true })
    const temp = file + '.tmp'
    await writeFile(temp, JSON.stringify(body))
    await rename(temp, file)
  }

  /** 같은 채널의 캐시가 너무 많으면(검색어마다 하나씩 생긴다) 오래된 것부터 지운다 */
  async function prune(channel: string): Promise<void> {
    const prefix = safeName(channel) + '-'
    const names = (await readdir(options.cacheDir)).filter(
      (n) => n.startsWith(prefix) && n.endsWith('.json')
    )
    if (names.length <= KEEP_PER_CHANNEL) return
    const aged = await Promise.all(
      names.map(async (n) => ({ n, at: (await stat(join(options.cacheDir, n))).mtimeMs }))
    )
    aged.sort((a, b) => b.at - a.at)
    await Promise.all(
      aged
        .slice(KEEP_PER_CHANNEL)
        .map((x) => unlink(join(options.cacheDir, x.n)).catch(() => undefined))
    )
  }

  return {
    async read<T>(channel: string, req?: unknown, opts?: { cacheAs?: unknown }) {
      const file = cacheFile(channel, opts && 'cacheAs' in opts ? opts.cacheAs : req)
      let failure: RemoteError
      try {
        const reply = await ask(channel, req, READ_TIMEOUT)
        if (reply.ok) {
          const receivedAt = new Date(now()).toISOString()
          await writeCache(file, { receivedAt, res: reply.res })
            .then(() => prune(channel))
            .catch(() => undefined)
          return { res: reply.res as T, stamp: { receivedAt, stale: false } }
        }
        failure = new RemoteError('refused', reply.error)
      } catch (error) {
        failure = error instanceof RemoteError ? error : new RemoteError('down', REMOTE_DOWN)
      }
      try {
        const saved = JSON.parse(await readFile(file, 'utf8')) as { receivedAt: string; res: T }
        if (typeof saved.receivedAt === 'string')
          return { res: saved.res, stamp: { receivedAt: saved.receivedAt, stale: true } }
      } catch {
        // 받아 둔 것이 없다
      }
      throw failure
    },

    async act<T>(channel: string, req?: unknown) {
      const reply = await ask(channel, req, ACT_TIMEOUT)
      if (!reply.ok) throw new RemoteError('refused', reply.error)
      return reply.res as T
    },

    async thumb(url) {
      const dir = join(options.cacheDir, 'thumbs')
      const file = join(dir, hash(url))
      const fromDisk = async (): Promise<{ type: string; bytes: Uint8Array } | null> => {
        try {
          const type = await readFile(file + '.type', 'utf8')
          return { type, bytes: new Uint8Array(await readFile(file)) }
        } catch {
          return null
        }
      }
      try {
        if (now() - (await stat(file)).mtimeMs < THUMB_TTL) {
          const saved = await fromDisk()
          if (saved) return saved
        }
      } catch {
        // 아직 받은 적 없다
      }
      try {
        const response = await call(
          '/view/thumb?u=' + encodeURIComponent(url),
          { method: 'GET' },
          READ_TIMEOUT
        )
        if (!response.ok) return fromDisk()
        const type = response.headers.get('content-type') || ''
        if (!type.startsWith('image/')) return null
        const bytes = new Uint8Array(await response.arrayBuffer())
        await mkdir(dir, { recursive: true })
        await writeFile(file, bytes)
        await writeFile(file + '.type', type)
        return { type, bytes }
      } catch {
        return fromDisk()
      }
    },

    async reachable() {
      try {
        const response = await call('/view', { method: 'GET' }, 1500)
        return response.status === 405
      } catch {
        return false
      }
    }
  }
}
