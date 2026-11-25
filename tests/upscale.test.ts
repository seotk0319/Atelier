import { afterEach, describe, expect, it, vi } from 'vitest'
import JSZip from 'jszip'
import { upscaleImage } from '../src/main/nai/client'
import { ENDPOINTS } from '../src/main/nai/endpoints'
import { UPSCALE_MODEL } from '../src/main/nai/upscale-request'
import { UPSCALE_ANLAS_COST, UPSCALE_SCALE } from '../src/shared/anlas'

// upstream NAIS3 tests/upscale.test.ts를 옮김 — 옛 주소(api.novelai.net, JSON)는 404다 (2026-11-25 실측)
describe('V5 업스케일러', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('image 호스트에 multipart로 그림과 요청을 보낸다', async () => {
    const zip = new JSZip()
    zip.file('image_0.png', Buffer.from('upscaled-png'))
    const responseBody = await zip.generateAsync({ type: 'uint8array' })
    const sourceImage = Buffer.from('source-image')
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(responseBody, { status: 200 }))

    const png = await upscaleImage(' token ', sourceImage.toString('base64'))

    expect(png).toEqual(Buffer.from('upscaled-png'))
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(ENDPOINTS.upscale)
    expect(url).toBe('https://image.novelai.net/ai/upscale')
    expect(init?.method).toBe('POST')

    const headers = new Headers(init?.headers)
    expect(headers.get('authorization')).toBe('Bearer token')
    // multipart 경계는 fetch가 붙인다 — Content-Type을 직접 넣으면 깨진다
    expect(headers.get('content-type')).toBeNull()

    const body = init?.body as FormData
    expect(body).toBeInstanceOf(FormData)
    const image = body.get('image') as Blob
    expect(image.type).toBe('image/png')
    expect(Buffer.from(await image.arrayBuffer())).toEqual(sourceImage)
    expect(JSON.parse(await (body.get('request') as Blob).text())).toEqual({
      image: 'image',
      model: UPSCALE_MODEL,
      declared_blur_sigma: 0
    })
  })

  it('2배 고정, 크기와 상관없이 1 Anlas (실측)', () => {
    expect(UPSCALE_SCALE).toBe(2)
    expect(UPSCALE_ANLAS_COST).toBe(1)
  })
})
