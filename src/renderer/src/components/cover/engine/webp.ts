/**
 * 캔버스 → WEBP 바이트. 프레임마다 인코딩하고 조립은 @shared/cover-webp 가 한다.
 */
import { buildAnimatedWebp, type WebpFrameBytes } from '@shared/cover-webp'

export function isWebpEncodeSupported(): boolean {
  try {
    if (typeof document === 'undefined') return false
    const canvas = document.createElement('canvas')
    canvas.width = 1
    canvas.height = 1
    return canvas.toDataURL('image/webp').startsWith('data:image/webp')
  } catch {
    return false
  }
}

function clampedQuality(quality: number): number {
  const q = Number(quality)
  return Number.isFinite(q) ? Math.max(0, Math.min(1, q)) : 0.8
}

function canvasToWebpBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob || blob.type !== 'image/webp') {
          reject(new Error('브라우저가 WEBP 인코딩을 지원하지 않아요.'))
          return
        }
        resolve(blob)
      },
      'image/webp',
      quality
    )
  })
}

export async function encodeFrame(canvas: HTMLCanvasElement, quality: number): Promise<Uint8Array> {
  const blob = await canvasToWebpBlob(canvas, clampedQuality(quality))
  return new Uint8Array(await blob.arrayBuffer())
}

export async function makeAnimatedWebp(
  frames: { canvas: HTMLCanvasElement; durationMs: number }[],
  quality: number
): Promise<Blob> {
  if (!frames || frames.length === 0) throw new Error('WEBP 프레임이 없어요.')
  const width = frames[0].canvas.width
  const height = frames[0].canvas.height
  const encoded: WebpFrameBytes[] = []
  for (const frame of frames) {
    if (frame.canvas.width !== width || frame.canvas.height !== height) {
      throw new Error('WEBP 프레임 크기가 서로 달라요.')
    }
    encoded.push({
      bytes: await encodeFrame(frame.canvas, quality),
      durationMs: frame.durationMs
    })
  }
  const bytes = buildAnimatedWebp(encoded, width, height)
  return new Blob([new Uint8Array(bytes).buffer], { type: 'image/webp' })
}
