import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 실제 요청이 나가는 곳(collector의 workSend·workRead)을 본다. Electron 세션만 흉내로 바꾼다.
const electron = vi.hoisted(() => ({
  fetch: vi.fn<(url: string, init: RequestInit) => Promise<Response>>(),
  jar: [] as { domain: string; name: string; value: string }[],
  asked: [] as Record<string, unknown>[]
}))
vi.mock('electron', () => ({
  session: {
    fromPartition: () => ({
      fetch: (url: string, init: RequestInit) => electron.fetch(url, init),
      setUserAgent: () => undefined,
      cookies: {
        get: async (filter: { domain?: string; name?: string }) => {
          electron.asked.push(filter)
          return electron.jar.filter(
            (c) =>
              (!filter.name || c.name === filter.name) &&
              (!filter.domain || c.domain.endsWith(filter.domain))
          )
        },
        set: async () => undefined,
        remove: async () => undefined,
        flushStore: async () => undefined
      }
    })
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from('sealed:' + value),
    decryptString: (value: Buffer) => value.toString().replace(/^sealed:/, '')
  }
}))

import { createDirectCollector } from '../src/main/notifications/direct/collector'
import { lunaListBody } from '../src/main/works/luna'

const W = '11111111-2222-4333-8444-555555555555'
const DETAIL = 'https://api.genit.ai/api/characters/' + W + '/'
const LIST = 'https://lunatalk.chat/member/mypage_api'

const directories: string[] = []
afterEach(async () => {
  electron.fetch.mockReset()
  electron.jar.length = 0
  electron.asked.length = 0
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})
const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
const cookieOnly = { headers: {}, headersByOrigin: {}, routes: {}, queries: [] }

async function collector(): Promise<ReturnType<typeof createDirectCollector>> {
  const directory = await mkdtemp(join(tmpdir(), 'nais-genit-send-test-'))
  directories.push(directory)
  const connectedAt = new Date().toISOString()
  await writeFile(
    join(directory, 'direct-sessions.bin'),
    'sealed:' +
      JSON.stringify({
        version: 1,
        userAgent: null,
        platforms: {
          genit: { profile: cookieOnly, connectedAt },
          luna: { profile: cookieOnly, connectedAt }
        },
        checkpoints: {},
        lastRun: {}
      })
  )
  return createDirectCollector({
    directory,
    profileDir: join(directory, 'browser-profile'),
    version: 'test',
    store: {
      ingest: async () => ({ accepted: 0, added: 0 }),
      heartbeat: async () => ({ enabled: true, selection: {} })
    }
  })
}
const sent = (): { url: string; init: RequestInit; headers: Record<string, string> }[] =>
  electron.fetch.mock.calls.map(([url, init]) => ({
    url,
    init,
    headers: Object.fromEntries(
      Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [
        k.toLowerCase(),
        v
      ])
    )
  }))

describe('젠잇·루나 요청 통로', () => {
  it('젠잇 저장: 쿠키의 CSRF 토큰을 헤더로 붙여 파일 묶음 PATCH로 보낸다', async () => {
    const direct = await collector()
    electron.jar.push({ domain: '.genit.ai', name: 'wavechat_csrftoken', value: 'csrf-abc' })
    electron.fetch.mockResolvedValue(json({ id: W }))
    await direct.workSend('genit', {
      method: 'PATCH',
      url: DETAIL,
      form: [{ name: 'name', value: '제목' }],
      headers: { origin: 'https://genit.ai', referer: 'https://genit.ai/' }
    })
    const [call] = sent()
    expect(call.init.method).toBe('PATCH')
    expect(call.init.credentials).toBe('include')
    expect(call.headers['x-csrftoken']).toBe('csrf-abc')
    expect(call.headers.origin).toBe('https://genit.ai')
    expect(call.init.body).toBeInstanceOf(FormData)
    expect(electron.asked).toContainEqual({ domain: 'genit.ai', name: 'wavechat_csrftoken' })
  })

  it('젠잇: CSRF 쿠키가 없으면 보내지 않고, 규칙 밖 요청은 나가지 않는다', async () => {
    const direct = await collector()
    await expect(direct.workSend('genit', { method: 'DELETE', url: DETAIL })).rejects.toThrow(
      'LOGIN_REQUIRED'
    )
    // 요청이 직접 CSRF 헤더를 실을 수는 없다 (헤더 이름이 규칙 밖)
    electron.jar.push({ domain: '.genit.ai', name: 'wavechat_csrftoken', value: 'csrf-abc' })
    await expect(
      direct.workSend('genit', {
        method: 'DELETE',
        url: DETAIL,
        headers: { 'x-csrftoken': 'mine' }
      })
    ).rejects.toThrow('UNAPPROVED_WRITE_ROUTE')
    await expect(
      direct.workSend('genit', { method: 'PATCH', url: DETAIL, json: { name: 'x' } })
    ).rejects.toThrow('UNAPPROVED_WRITE_ROUTE')
    await expect(
      direct.workSend('luna', {
        method: 'POST',
        url: 'https://lunatalk.chat/character/api',
        form: []
      })
    ).rejects.toThrow('UNAPPROVED_WRITE_ROUTE')
    expect(electron.fetch).not.toHaveBeenCalled()
  })

  it('루나 목록: 허용된 본문 모양만 폼 POST로 읽는다', async () => {
    const direct = await collector()
    electron.fetch.mockResolvedValue(json({ success: true, characters: [], has_more: false }))
    await direct.workRead('luna', LIST, {
      method: 'POST',
      body: lunaListBody(0),
      contentType: 'application/x-www-form-urlencoded'
    })
    const [call] = sent()
    expect(call.init.method).toBe('POST')
    expect(call.init.body).toBe(lunaListBody(0))
    expect(call.headers['content-type']).toBe('application/x-www-form-urlencoded')
    // POST 읽기는 쿠키를 직접 실어 보낸다 (SameSite=Lax 자동 로그인 쿠키가 앱의 POST에는 안 실리기 때문)
    expect(call.init.credentials).toBe('omit')
    expect(call.headers.origin).toBe('https://lunatalk.chat')
    expect(typeof call.headers.cookie).toBe('string')

    for (const init of [
      {
        method: 'POST' as const,
        body: 'action=delete_character&idx=1',
        contentType: 'application/x-www-form-urlencoded'
      },
      { method: 'POST' as const, body: lunaListBody(0) },
      undefined
    ])
      await expect(direct.workRead('luna', LIST, init)).rejects.toThrow('UNAPPROVED_READ_ROUTE')
    // 에덴·베이비챗 읽기에는 POST가 열려 있지 않다
    await expect(
      direct.workRead('babe', 'https://api.babechatapi.com/ko/api/characters/my', {
        method: 'POST',
        body: '{}',
        contentType: 'application/json'
      })
    ).rejects.toThrow('UNAPPROVED_READ_ROUTE')
    expect(electron.fetch).toHaveBeenCalledTimes(1)
  })

  it('작품 읽기 GET은 예전처럼 본문 없이 나간다', async () => {
    const direct = await collector()
    electron.fetch.mockResolvedValue(json({ id: W }))
    await direct.workRead('genit', DETAIL + '?lang=ko')
    const [call] = sent()
    expect(call.init.method).toBe('GET')
    expect(call.init.body).toBeUndefined()
    expect(call.headers['content-type']).toBeUndefined()
  })
})
