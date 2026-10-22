/**
 * 움직이는 WEBP 조립. DOM 없이 바이트만 다루므로 node 테스트에서도 쓴다.
 * 정지 WEBP(프레임) → RIFF 청크 파싱 → VP8X + ANIM + ANMF (SPEC 11.2).
 */

const MAX_DURATION_MS = 16777215
const MAX_CANVAS_SIDE = 16777216

export interface WebpFrameBytes {
  bytes: Uint8Array
  durationMs: number
}

interface WebpChunk {
  fourcc: string
  data: Uint8Array
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let s = ''
  for (let i = 0; i < length; i++) s += String.fromCharCode(bytes[offset + i] ?? 0)
  return s
}

function readUint32LE(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)
  )
}

function writeAscii(target: Uint8Array, offset: number, value: string): void {
  for (let i = 0; i < value.length; i++) target[offset + i] = value.charCodeAt(i)
}

function writeUint16LE(target: Uint8Array, offset: number, value: number): void {
  target[offset] = value & 0xff
  target[offset + 1] = (value >> 8) & 0xff
}

function writeUint24LE(target: Uint8Array, offset: number, value: number): void {
  target[offset] = value & 0xff
  target[offset + 1] = (value >> 8) & 0xff
  target[offset + 2] = (value >> 16) & 0xff
}

function writeUint32LE(target: Uint8Array, offset: number, value: number): void {
  target[offset] = value & 0xff
  target[offset + 1] = (value >> 8) & 0xff
  target[offset + 2] = (value >> 16) & 0xff
  target[offset + 3] = (value >>> 24) & 0xff
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  let total = 0
  for (const part of parts) total += part.length
  const result = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.length
  }
  return result
}

function makeChunk(fourcc: string, payload: Uint8Array): Uint8Array {
  const pad = payload.length % 2
  const chunk = new Uint8Array(8 + payload.length + pad)
  writeAscii(chunk, 0, fourcc)
  writeUint32LE(chunk, 4, payload.length)
  chunk.set(payload, 8)
  return chunk
}

/** RIFF WEBP 의 청크 목록. 헤더·크기가 깨졌으면 던진다. */
export function parseWebpChunks(bytes: Uint8Array): WebpChunk[] {
  if (bytes.length < 12 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WEBP') {
    throw new Error('정지 WEBP 인코딩 결과를 읽을 수 없어요.')
  }
  const chunks: WebpChunk[] = []
  let offset = 12
  while (offset + 8 <= bytes.length) {
    const fourcc = ascii(bytes, offset, 4)
    const size = readUint32LE(bytes, offset + 4) >>> 0
    const start = offset + 8
    const end = start + size
    if (end > bytes.length) throw new Error('WEBP 청크 크기가 올바르지 않아요.')
    chunks.push({ fourcc, data: bytes.slice(start, end) })
    offset = end + (size % 2)
  }
  return chunks
}

function clampDuration(ms: number): number {
  const n = Math.round(Number(ms))
  if (!Number.isFinite(n)) return 1
  return Math.max(1, Math.min(MAX_DURATION_MS, n))
}

function makeVp8xChunk(width: number, height: number, hasAlpha: boolean): Uint8Array {
  const payload = new Uint8Array(10)
  payload[0] = 0x02 | (hasAlpha ? 0x10 : 0x00)
  writeUint24LE(payload, 4, width - 1)
  writeUint24LE(payload, 7, height - 1)
  return makeChunk('VP8X', payload)
}

function makeAnimChunk(loop: number): Uint8Array {
  const payload = new Uint8Array(6)
  writeUint16LE(payload, 4, loop)
  return makeChunk('ANIM', payload)
}

function makeAnmfChunk(
  bytes: Uint8Array,
  durationMs: number,
  width: number,
  height: number
): { chunk: Uint8Array; hasAlpha: boolean } {
  const chunks = parseWebpChunks(bytes)
  const frameChunks = chunks.filter(
    (c) => c.fourcc === 'ALPH' || c.fourcc === 'VP8 ' || c.fourcc === 'VP8L'
  )
  if (!frameChunks.some((c) => c.fourcc === 'VP8 ' || c.fourcc === 'VP8L')) {
    throw new Error('WEBP 이미지 청크를 찾을 수 없어요.')
  }
  const header = new Uint8Array(16)
  writeUint24LE(header, 0, 0)
  writeUint24LE(header, 3, 0)
  writeUint24LE(header, 6, width - 1)
  writeUint24LE(header, 9, height - 1)
  writeUint24LE(header, 12, clampDuration(durationMs))
  header[15] = 0x02
  const image = frameChunks.map((c) => makeChunk(c.fourcc, c.data))
  return {
    chunk: makeChunk('ANMF', concatBytes([header, ...image])),
    hasAlpha: frameChunks.some((c) => c.fourcc === 'ALPH' || c.fourcc === 'VP8L')
  }
}

export function buildAnimatedWebp(
  frames: WebpFrameBytes[],
  width: number,
  height: number,
  opts?: { loop?: number; transparent?: boolean }
): Uint8Array {
  if (!Array.isArray(frames) || frames.length === 0) {
    throw new Error('WEBP 프레임이 없어요.')
  }
  const w = Math.round(width)
  const h = Math.round(height)
  if (!(w >= 1 && h >= 1) || w > MAX_CANVAS_SIDE || h > MAX_CANVAS_SIDE) {
    throw new Error('WEBP 캔버스 크기가 올바르지 않아요.')
  }
  const loop = Math.max(0, Math.min(0xffff, Math.round(Number(opts?.loop) || 0)))
  const transparent = Boolean(opts?.transparent)

  const anmf = frames.map((f) => makeAnmfChunk(f.bytes, f.durationMs, w, h))
  const hasAlpha = transparent || anmf.some((f) => f.hasAlpha)
  const payload = concatBytes([
    makeVp8xChunk(w, h, hasAlpha),
    makeAnimChunk(loop),
    ...anmf.map((f) => f.chunk)
  ])
  const riff = new Uint8Array(12 + payload.length)
  writeAscii(riff, 0, 'RIFF')
  writeUint32LE(riff, 4, 4 + payload.length)
  writeAscii(riff, 8, 'WEBP')
  riff.set(payload, 12)
  return riff
}
