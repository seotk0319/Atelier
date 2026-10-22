import { describe, expect, it } from 'vitest'
import {
  cleanCoverName,
  coverPngName,
  coverRect,
  coverWebpName,
  duplicateTypoNames,
  getPlacement,
  getCoverCanvas,
  normalizeCoverProject,
  typoRect,
  type CoverItem,
  type CoverProject
} from '@shared/cover'
import { buildAnimatedWebp, parseWebpChunks, type WebpFrameBytes } from '@shared/cover-webp'

const KEY = 'abcdefgh1'

function item(over: Partial<CoverItem> = {}): CoverItem {
  return { id: 'item-1', name: 'x', blobKey: KEY, width: 100, height: 200, ...over }
}

function rawProject(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: KEY,
    name: '작품',
    createdAt: 1,
    updatedAt: 2,
    backgrounds: [item({ id: 'bg-1' })],
    typos: [item({ id: 'typo-1' })],
    frame: {},
    frameImages: {},
    placements: {},
    pans: {},
    selection: { canvasId: '1x1', bgId: 'bg-1', typoId: 'typo-1' },
    webp: { frames: [], quality: 0.8 },
    ...over
  }
}

describe('normalizeCoverProject', () => {
  it('keeps a valid project and fills a missing h from the original ratio', () => {
    const raw = rawProject({
      placements: { 'typo-1@1x1': { cx: 0.5, cy: 0.5, w: 0.25 } }
    })
    const p = normalizeCoverProject(raw) as CoverProject
    expect(p).not.toBeNull()
    // (0.25 * 1200 * 200 / 100) / 1200
    expect(p.placements['typo-1@1x1'].h).toBeCloseTo(0.5, 6)
  })

  it('rejects a broken project id and bad blob keys', () => {
    expect(normalizeCoverProject(rawProject({ id: 'short' }))).toBeNull()
    expect(normalizeCoverProject(rawProject({ id: '../escape' }))).toBeNull()
    const p = normalizeCoverProject(
      rawProject({
        backgrounds: [item({ id: 'bg-1', blobKey: 'bad/key' }), item({ id: 'bg-2' })]
      })
    )
    expect(p?.backgrounds).toHaveLength(1)
    expect(p?.backgrounds[0].id).toBe('bg-2')
  })

  it('drops webp frames that point at a deleted background', () => {
    const p = normalizeCoverProject(
      rawProject({
        webp: {
          frames: [
            { bgId: 'bg-1', durationMs: 500 },
            { bgId: 'gone', durationMs: 500 }
          ],
          quality: 2
        }
      })
    )
    expect(p?.webp.frames).toHaveLength(1)
    expect(p?.webp.frames[0].bgId).toBe('bg-1')
    expect(p?.webp.quality).toBe(1)
  })

  it('rejects placements for a missing typo or canvas', () => {
    const p = normalizeCoverProject(
      rawProject({
        placements: {
          'nope@1x1': { cx: 0.5, cy: 0.5, w: 0.5 },
          'typo-1@9x9': { cx: 0.5, cy: 0.5, w: 0.5 }
        }
      })
    )
    expect(p?.placements).toEqual({})
  })
})

describe('geometry', () => {
  it('cover-fits a tall image and centers it', () => {
    const r = coverRect(100, 200, 1200, 1200, { px: 0.5, py: 0.5 })
    expect(r.x).toBeCloseTo(0, 6)
    expect(r.y).toBeCloseTo(-600, 6)
    expect(r.w).toBeCloseTo(1200, 6)
    expect(r.h).toBeCloseTo(2400, 6)
  })

  it('places a typo box by normalized center and size', () => {
    expect(typoRect(1200, 1200, { cx: 0.5, cy: 0.5, w: 0.5, h: 0.25 })).toEqual({
      x: 300,
      y: 450,
      w: 600,
      h: 300
    })
  })

  it('computes the default placement with a ratio-correct height', () => {
    const canvas = getCoverCanvas('1x1')
    expect(canvas).not.toBeNull()
    const pl = getPlacement(rawProject() as unknown as CoverProject, item(), canvas!)
    expect(pl.w).toBeCloseTo(0.4, 6)
    expect(pl.h).toBeCloseTo(0.8, 6)
    expect(pl.cx).toBe(0.5)
    expect(pl.cy).toBe(0.5)
  })
})

describe('output names', () => {
  it('replaces Windows-forbidden characters and trims trailing dots and spaces', () => {
    expect(cleanCoverName('a/b:c*?"<>|d')).toBe('a_b_c______d')
    expect(cleanCoverName('  이름. . ')).toBe('이름')
    expect(cleanCoverName('   ')).toBe('untitled')
    expect(cleanCoverName(null)).toBe('untitled')
  })

  it('pads the background number to two digits and keeps 100+ as is', () => {
    expect(coverPngName('작품', 0, 'ko')).toBe('작품_01_ko.png')
    expect(coverPngName('작품', 9, 'ko')).toBe('작품_10_ko.png')
    expect(coverPngName('작품', 99, 'ko')).toBe('작품_100_ko.png')
    expect(coverWebpName('작품', 'en')).toBe('작품_en.webp')
  })

  it('finds typo names that collide after cleaning (case-insensitive)', () => {
    expect(
      duplicateTypoNames([
        item({ id: 'a', name: 'KO' }),
        item({ id: 'b', name: 'ko' }),
        item({ id: 'c', name: 'ja' })
      ])
    ).toEqual(['ko'])
    expect(duplicateTypoNames([item({ name: 'ko' }), item({ id: 'b', name: 'ja' })])).toEqual([])
  })
})

function chunk(fourcc: string, data: number[]): Uint8Array {
  const pad = data.length % 2
  const out = new Uint8Array(8 + data.length + pad)
  for (let i = 0; i < 4; i++) out[i] = fourcc.charCodeAt(i)
  const size = data.length
  out[4] = size & 0xff
  out[5] = (size >> 8) & 0xff
  out[6] = (size >> 16) & 0xff
  out[7] = (size >> 24) & 0xff
  out.set(data, 8)
  return out
}

/** VP8L 청크만 가진 최소 RIFF. 픽셀은 유효하지 않아도 조립 테스트에는 충분하다. */
function fakeVp8lFrame(payload: number[] = [0x2f, 0x01, 0x02, 0x03]): Uint8Array {
  const body = chunk('VP8L', payload)
  const riff = new Uint8Array(12 + body.length)
  riff.set([0x52, 0x49, 0x46, 0x46], 0)
  const size = 4 + body.length
  riff[4] = size & 0xff
  riff[5] = (size >> 8) & 0xff
  riff[6] = (size >> 16) & 0xff
  riff[7] = (size >>> 24) & 0xff
  riff.set([0x57, 0x45, 0x42, 0x50], 8)
  riff.set(body, 12)
  return riff
}

function readU32(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] |
      (bytes[offset + 1] << 8) |
      (bytes[offset + 2] << 16) |
      (bytes[offset + 3] << 24)) >>>
    0
  )
}

function readU24(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16)
}

describe('buildAnimatedWebp', () => {
  it('assembles VP8X, ANIM and one ANMF per frame', () => {
    const frames: WebpFrameBytes[] = [
      { bytes: fakeVp8lFrame(), durationMs: 500 },
      { bytes: fakeVp8lFrame([0x2f, 0x09]), durationMs: 1200 }
    ]
    const out = buildAnimatedWebp(frames, 120, 300, { loop: 3 })
    // RIFF 크기 필드는 실제 파일 길이 - 8
    expect(readU32(out, 4)).toBe(out.length - 8)
    const chunks = parseWebpChunks(out)
    expect(chunks.map((c) => c.fourcc)).toEqual(['VP8X', 'ANIM', 'ANMF', 'ANMF'])

    const vp8x = chunks[0].data
    expect(vp8x).toHaveLength(10)
    expect(vp8x[0]).toBe(0x12) // animation + alpha (VP8L)
    expect(readU24(vp8x, 4) + 1).toBe(120)
    expect(readU24(vp8x, 7) + 1).toBe(300)

    const anim = chunks[1].data
    expect(anim).toHaveLength(6)
    expect(anim[0] | (anim[1] << 8) | (anim[2] << 16) | (anim[3] << 24)).toBe(0)
    expect(anim[4] | (anim[5] << 8)).toBe(3)

    const durations = chunks.slice(2).map((c) => readU24(c.data, 12))
    expect(durations).toEqual([500, 1200])
    for (const c of chunks.slice(2)) {
      expect(readU24(c.data, 0)).toBe(0)
      expect(readU24(c.data, 3)).toBe(0)
      expect(readU24(c.data, 6) + 1).toBe(120)
      expect(readU24(c.data, 9) + 1).toBe(300)
      expect(c.data[15]).toBe(0x02)
      // 프레임 헤더 뒤에 VP8L 청크가 그대로 들어 있다
      expect(String.fromCharCode(...c.data.slice(16, 20))).toBe('VP8L')
    }
  })

  it('clamps duration and honors the transparent flag', () => {
    const out = buildAnimatedWebp(
      [
        { bytes: fakeVp8lFrame(), durationMs: 0 },
        { bytes: fakeVp8lFrame(), durationMs: 999999999 }
      ],
      10,
      10,
      { transparent: true }
    )
    const chunks = parseWebpChunks(out)
    expect(chunks[0].data[0]).toBe(0x12)
    expect(readU24(chunks[2].data, 12)).toBe(1)
    expect(readU24(chunks[3].data, 12)).toBe(16777215)
  })

  it('rejects broken input', () => {
    expect(() => buildAnimatedWebp([], 10, 10)).toThrow()
    expect(() =>
      buildAnimatedWebp([{ bytes: new Uint8Array([1, 2, 3]), durationMs: 1 }], 10, 10)
    ).toThrow()
    expect(() => buildAnimatedWebp([{ bytes: fakeVp8lFrame(), durationMs: 1 }], 0, 10)).toThrow()
    expect(() => parseWebpChunks(new Uint8Array([0, 1, 2]))).toThrow()
  })
})
