import sharp from 'sharp'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '' }, safeStorage: {}, net: {} }))
vi.mock('../src/main/db', () => ({ getDb: () => null }))
vi.mock('../src/main/images/storage', () => ({ saveGeneratedImage: vi.fn() }))
vi.mock('../src/main/gpt/auth', () => ({
  GptAuthError: class extends Error {},
  getCredentials: vi.fn()
}))
vi.mock('../src/main/gpt/client', () => ({
  GptHttpError: class extends Error {},
  GptNoImageError: class extends Error {},
  requestImage: vi.fn()
}))

import { prepareEdit } from '../src/main/gpt/service'

/** IEND 앞에 tEXt 덩어리를 끼워 넣는다 (CRC는 검사하지 않는 쪽만 읽으므로 0으로 둔다) */
function withTextChunk(png: Buffer, text: string): Buffer {
  const data = Buffer.from(`Comment\0${text}`, 'latin1')
  const chunk = Buffer.alloc(12 + data.length)
  chunk.writeUInt32BE(data.length, 0)
  chunk.write('tEXt', 4, 'ascii')
  data.copy(chunk, 8)
  const iend = png.length - 12
  return Buffer.concat([png.subarray(0, iend), chunk, png.subarray(iend)])
}

describe('GPT로 보내는 그림의 메타데이터', () => {
  it('작은 PNG도 프롬프트가 든 텍스트 덩어리를 지우고 보낸다', async () => {
    const png = await sharp({
      create: { width: 64, height: 64, channels: 3, background: { r: 200, g: 100, b: 50 } }
    })
      .png()
      .toBuffer()
    const tagged = withTextChunk(png, '{"prompt":"secret prompt"}')
    expect(tagged.includes(Buffer.from('secret prompt'))).toBe(true)
    const out = await prepareEdit({ b64: tagged.toString('base64'), mime: 'image/png', name: 'a' })
    const sent = Buffer.from(out.b64, 'base64')
    expect(sent.includes(Buffer.from('secret prompt'))).toBe(false)
    expect(sent.includes(Buffer.from('tEXt'))).toBe(false)
    const meta = await sharp(sent).metadata()
    expect([meta.width, meta.height]).toEqual([64, 64])
  })
})
