import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMcpServer } from '../src/main/mcp/server'
import { createViewClient, RemoteError, type ViewClient } from '../src/main/remote/view-client'

const PORT = 39411
const TOKEN = 'a'.repeat(43)

describe('맥미니에서 받아 오기 (view-client)', () => {
  let dir = ''
  let server: ReturnType<typeof createMcpServer> | null = null
  let client: ViewClient
  let clock = Date.parse('2026-11-13T06:00:00.000Z')
  let calls: { channel: string; req: unknown }[] = []
  let thumbs = 0

  const open = async (): Promise<void> => {
    server = createMcpServer({
      port: PORT,
      token: TOKEN,
      info: { name: 'test', version: '0' },
      tools: [],
      view: async (channel, req) => {
        calls.push({ channel, req })
        if (channel === 'inbox:reply') throw new Error('LOGIN_REQUIRED')
        return { channel, n: calls.length }
      },
      thumb: async (url) => {
        thumbs += 1
        return url === 'https://img.example/a.png'
          ? { type: 'image/png', bytes: new Uint8Array([1, 2, 3]) }
          : null
      }
    })
    await server.start()
  }
  const close = async (): Promise<void> => {
    await server?.stop()
    server = null
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'atelier-view-'))
    await writeFile(join(dir, 'connection.json'), JSON.stringify({ token: TOKEN }))
    calls = []
    thumbs = 0
    client = createViewClient({
      port: () => PORT,
      tokenFile: join(dir, 'connection.json'),
      cacheDir: join(dir, 'cache'),
      now: () => clock
    })
  })
  afterEach(async () => {
    await close()
    await rm(dir, { recursive: true, force: true })
  })

  it('받으면 받은 시각과 함께 돌려주고, 끊기면 마지막으로 받은 것을 stale로 돌려준다', async () => {
    await open()
    const first = await client.read<{ n: number }>('inbox:works', { cached: true })
    expect(first.res.n).toBe(1)
    expect(first.stamp).toEqual({ receivedAt: '2026-11-13T06:00:00.000Z', stale: false })
    await close()
    clock += 3_600_000
    const later = await client.read<{ n: number }>('inbox:works', { cached: true })
    expect(later.res.n).toBe(1)
    expect(later.stamp).toEqual({ receivedAt: '2026-11-13T06:00:00.000Z', stale: true })
  })

  it('받아 둔 것이 없는데 끊겼으면 실패한다', async () => {
    await expect(client.read('inbox:query', {})).rejects.toBeInstanceOf(RemoteError)
  })

  it('cacheAs: 새로고침으로 받은 것도 같은 자리에 둔다', async () => {
    await open()
    await client.read('inbox:works', { refresh: true }, { cacheAs: { cached: true } })
    await close()
    const cached = await client.read<{ n: number }>('inbox:works', { cached: true })
    expect(cached.stamp.stale).toBe(true)
    expect(calls[0].req).toEqual({ refresh: true })
  })

  it('단추는 캐시로 답하지 않는다: 끊기면 down, 맥미니가 실패하면 refused', async () => {
    await expect(client.act('inbox:control', { enabled: true })).rejects.toMatchObject({
      kind: 'down'
    })
    await open()
    expect(await client.act<{ channel: string }>('inbox:control', { enabled: true })).toMatchObject(
      { channel: 'inbox:control' }
    )
    await expect(client.act('inbox:reply', {})).rejects.toMatchObject({
      kind: 'refused',
      message: 'LOGIN_REQUIRED'
    })
  })

  it('비밀값이 다르면 받지 못한다 (끊긴 것과 같이 다룬다)', async () => {
    await open()
    await writeFile(join(dir, 'connection.json'), JSON.stringify({ token: 'b'.repeat(43) }))
    await expect(client.read('inbox:query', {})).rejects.toMatchObject({ kind: 'down' })
    expect(await client.reachable()).toBe(false)
  })

  it('reachable: 통로 너머가 답할 때만 true', async () => {
    expect(await client.reachable()).toBe(false)
    await open()
    expect(await client.reachable()).toBe(true)
  })

  it('썸네일은 한 번 받으면 디스크 것을 쓰고, 끊겨도 보여 준다', async () => {
    await open()
    const a = await client.thumb('https://img.example/a.png')
    expect(a).toMatchObject({ type: 'image/png' })
    expect([...a!.bytes]).toEqual([1, 2, 3])
    await client.thumb('https://img.example/a.png')
    expect(thumbs).toBe(1)
    expect(await client.thumb('https://other.example/x.png')).toBeNull()
    await close()
    expect([...(await client.thumb('https://img.example/a.png'))!.bytes]).toEqual([1, 2, 3])
  })

  it('같은 채널의 캐시는 40개까지만 둔다', async () => {
    await open()
    for (let i = 0; i < 45; i++) await client.read('inbox:query', { search: 'q' + i })
    const names = (await readdir(join(dir, 'cache'))).filter((n) => n.startsWith('inbox_query-'))
    expect(names.length).toBeLessThanOrEqual(40)
  })
})
