import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import sharp from 'sharp'
import { afterAll, describe, expect, it, vi } from 'vitest'

vi.mock('../src/main/refs/repo', () => ({
  enabledCharRefRows: () => [],
  enabledVibeRows: () => [],
  saveVibeEncoding: () => undefined
}))

const dir = mkdtempSync(join(tmpdir(), 'atelier-ref-orient-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('character reference from a rotated phone photo', () => {
  it('uses the upright shape (EXIF orientation) for the canvas and the pixels', async () => {
    // 가로로 저장된 300×200 JPEG + 회전값 6 → 화면에는 200×300 세로 사진
    const file = join(dir, 'phone.jpg')
    const stored = await sharp({
      create: { width: 300, height: 200, channels: 3, background: '#c00' }
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer()
    writeFileSync(file, stored)
    const { prepareExtraCharRefs } = await import('../src/main/refs/prepare')
    const refs = [{ filePath: file, refType: 'character' as const, strength: 1, fidelity: 1 }]
    const [ref] = await prepareExtraCharRefs(refs, 'nai-diffusion-4-5-full')
    const meta = await sharp(Buffer.from(ref.imageBase64!, 'base64')).metadata()
    expect([meta.width, meta.height]).toEqual([1024, 1536])
    // V5는 버킷으로 자른다 — 세운 모양(세로)의 버킷이어야 한다
    const [v5] = await prepareExtraCharRefs(refs, 'nai-diffusion-5-full')
    const v5meta = await sharp(Buffer.from(v5.imageBase64!, 'base64')).metadata()
    expect(v5meta.height!).toBeGreaterThan(v5meta.width!)
  })
})
