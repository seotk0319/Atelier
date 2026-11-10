import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 실제로 요청이 나가는 곳(collector의 workSend)을 본다. Electron의 세션만 흉내로 바꾸고
// 허용 규칙·로그인 정보 붙이기는 진짜 코드가 돈다.
const electron = vi.hoisted(() => ({
  fetch: vi.fn<(url: string, init: RequestInit) => Promise<Response>>(),
  cookies: [] as Record<string, unknown>[]
}))
vi.mock('electron', () => ({
  session: {
    fromPartition: () => ({
      fetch: (url: string, init: RequestInit) => electron.fetch(url, init),
      setUserAgent: () => undefined,
      cookies: {
        get: async () => [],
        set: async (cookie: Record<string, unknown>) => {
          electron.cookies.push(cookie)
        },
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
import { profileUpdate } from '../src/main/notifications/direct/engine.mjs'

const W = '11111111-2222-4333-8444-555555555555'
const C = 'aaaaaaaa-0000-4000-8000-000000000001'
const EDEN_BEARER = 'Bearer eden-session-token'
const BABE_BEARER = 'Bearer babe-session-token'
const STORE = 'https://jhbfalszdxacwjnrrvms.supabase.co'
const WEBP = new Uint8Array(32)
WEBP.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])
const file = { name: '표지.webp', type: 'image/webp', data: WEBP }

const directories: string[] = []
afterEach(async () => {
  electron.fetch.mockReset()
  electron.cookies.length = 0
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true })
})
const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })

async function collector(): Promise<ReturnType<typeof createDirectCollector>> {
  const directory = await mkdtemp(join(tmpdir(), 'nais-send-test-'))
  directories.push(directory)
  const connectedAt = new Date().toISOString()
  await writeFile(
    join(directory, 'direct-sessions.bin'),
    'sealed:' +
      JSON.stringify({
        version: 1,
        userAgent: null,
        platforms: {
          eden: {
            profile: profileUpdate('eden', {
              origin: STORE,
              headers: { authorization: EDEN_BEARER, apikey: 'eden-public-key' }
            }),
            connectedAt
          },
          babe: {
            profile: profileUpdate('babe', {
              origin: 'https://api.babechatapi.com',
              headers: { authorization: BABE_BEARER }
            }),
            connectedAt
          }
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
      Object.entries(init.headers as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])
    )
  }))

describe('작품 파일 통로 (workSend)', () => {
  it('허용되지 않은 주소·본문·헤더는 요청 자체가 나가지 않는다', async () => {
    const direct = await collector()
    const images = 'https://www.eden-chat.com/api/works/' + W + '/characters/' + C + '/images'
    for (const request of [
      { method: 'POST', url: 'https://www.eden-chat.com/api/user/avatar', form: [] },
      { method: 'DELETE', url: images },
      { method: 'POST', url: images, json: {} },
      { method: 'POST', url: images, form: [], headers: { authorization: 'Bearer other' } },
      { method: 'PUT', url: 'https://vercel.com/api/blob/?pathname=a.webp', form: [] },
      { method: 'POST', url: 'https://example.com/upload', form: [] }
    ] as never[])
      await expect(direct.workSend('eden', request)).rejects.toThrow('UNAPPROVED_WRITE_ROUTE')
    // 연결 안 된 플랫폼, 다른 플랫폼의 주소
    await expect(
      direct.workSend('babe', { method: 'POST', url: images, form: [] })
    ).rejects.toThrow('UNAPPROVED_WRITE_ROUTE')
    expect(electron.fetch).not.toHaveBeenCalled()
  })

  it('에덴 이미지: 로그인 헤더와 쿠키를 붙여 파일 묶음으로 보낸다', async () => {
    const direct = await collector()
    electron.fetch.mockResolvedValue(json({ images: [{ id: 'x' }] }))
    const url = 'https://www.eden-chat.com/api/works/' + W + '/characters/' + C + '/images'
    await direct.workSend('eden', {
      method: 'POST',
      url,
      form: [
        { name: 'images', file },
        { name: 'preview_codes', value: 'abcde' }
      ]
    })
    const [call] = sent()
    expect(call.url).toBe(url)
    expect(call.init.method).toBe('POST')
    expect(call.init.credentials).toBe('include')
    expect(call.init.redirect).toBe('error')
    expect(call.headers.authorization).toBe(EDEN_BEARER)
    // 파일 묶음의 경계 문자열은 fetch가 정하게 둔다
    expect(call.headers['content-type']).toBeUndefined()
    const body = call.init.body as FormData
    expect(body.get('preview_codes')).toBe('abcde')
    const uploaded = body.get('images') as File
    expect([uploaded.name, uploaded.type, uploaded.size]).toEqual(['표지.webp', 'image/webp', 32])
  })

  it('에덴 저장소: 쿠키 없이, 그 주소에 저장된 헤더와 허용된 헤더만 보낸다', async () => {
    const direct = await collector()
    electron.fetch.mockResolvedValue(json({ Key: 'work-covers/a.webp' }))
    const url =
      STORE + '/storage/v1/object/upload/sign/work-covers/u/a.webp?token=signed-upload-token-value'
    await direct.workSend('eden', {
      method: 'PUT',
      url,
      form: [
        { name: 'cacheControl', value: '3600' },
        { name: '', file }
      ],
      headers: { 'x-upsert': 'false' }
    })
    const [call] = sent()
    expect(call.init.method).toBe('PUT')
    expect(call.init.credentials).toBe('omit')
    expect(call.headers['x-upsert']).toBe('false')
    expect((call.init.body as FormData).get('cacheControl')).toBe('3600')
    expect(((call.init.body as FormData).get('') as File).size).toBe(32)
    // 실패해도 로그인 연장을 걸고 다시 보내지 않는다
    electron.fetch.mockResolvedValue(json({ message: 'jwt expired' }, 401))
    expect(
      (await direct.workSend('eden', { method: 'PUT', url, form: [{ name: '', file }] })).status
    ).toBe(401)
    expect(electron.fetch).toHaveBeenCalledTimes(2)
  })

  it('베이비챗: 토큰 받기는 쿠키로만, Blob 저장소에는 베이비챗 로그인 정보가 가지 않는다', async () => {
    const direct = await collector()
    electron.fetch.mockImplementation(async (url) =>
      url.startsWith('https://babechat.ai/')
        ? json({ clientToken: 'vercel_blob_client_store_abc' })
        : json({ url: 'https://store.public.blob.vercel-storage.com/a.webp' })
    )
    await direct.workSend('babe', {
      method: 'POST',
      url: 'https://babechat.ai/api/upload',
      json: { type: 'blob.generate-client-token', payload: { pathname: W + '.webp' } }
    })
    await direct.workSend('babe', {
      method: 'PUT',
      url: 'https://vercel.com/api/blob/?pathname=' + W + '.webp',
      bytes: { data: WEBP, contentType: 'image/webp' },
      headers: { authorization: 'Bearer vercel_blob_client_store_abc', 'x-api-version': '13' }
    })
    const [ticket, put] = sent()
    // 사이트의 Next 주소는 쿠키로 로그인을 본다. 지금 토큰을 사이트와 같은 쿠키에 맞춰 둔다.
    expect(ticket.init.credentials).toBe('include')
    expect(ticket.headers.authorization).toBeUndefined()
    expect(ticket.headers['content-type']).toBe('application/json')
    expect(JSON.parse(ticket.init.body as string).type).toBe('blob.generate-client-token')
    expect(electron.cookies).toEqual([
      expect.objectContaining({
        url: 'https://babechat.ai/',
        name: 'bc__session',
        value: 'babe-session-token',
        domain: '.babechat.ai',
        secure: true,
        sameSite: 'lax'
      })
    ])
    // 다른 회사 저장소: 쿠키 없음, 업로드 토큰만
    expect(put.init.credentials).toBe('omit')
    expect(put.headers.authorization).toBe('Bearer vercel_blob_client_store_abc')
    expect(JSON.stringify(put.headers)).not.toContain('babe-session-token')
    const body = put.init.body as Blob
    expect([body.type, body.size]).toEqual(['image/webp', 32])
    expect(electron.cookies).toHaveLength(1)
  })
})
