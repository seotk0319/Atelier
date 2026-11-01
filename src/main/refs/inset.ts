// V5 레퍼런스 인셋. V5에는 캐릭터 레퍼런스가 없어서, 가로 캔버스 왼쪽 칸에 참고 그림을 두고
// 오른쪽만 인페인트로 그리게 해 같은 캐릭터를 뽑는다 (arca.live/b/aiart/180786125, 185554190).
// 결과는 참고 칸을 잘라 내고 새로 그린 쪽만 저장한다.
import { readFileSync } from 'fs'
import sharp from 'sharp'
import { INSET_MAX_SHARE as MAX_SHARE, INSET_MIN_SHARE as MIN_SHARE } from '../../shared/ref-inset'

export { insetShare } from '../../shared/ref-inset'

export interface InsetPlan {
  canvasW: number
  canvasH: number
  /** 참고 칸 폭 (경계선 포함). 이 오른쪽부터 그린다 */
  panelW: number
  /** 칸과 그림 사이 검은 경계선 두께 */
  divider: number
}

/** 무료 생성 상한 (Opus, 1024×1024) */
export const INSET_MAX_PX = 1024 * 1024
const floor64 = (v: number): number => Math.max(64, Math.floor(v / 64) * 64)
const round8 = (v: number): number => Math.max(8, Math.round(v / 8) * 8)

/**
 * 원하는 결과 비율(reqW:reqH)을 지키면서 캔버스 전체가 무료 상한을 넘지 않게 고른다.
 * 그리는 쪽 비율 = reqW/reqH, 캔버스 비율 = 그리는 쪽 비율 / (1 - 참고 칸 몫).
 */
export function insetPlan(reqW: number, reqH: number, share: number): InsetPlan {
  const r = reqW > 0 && reqH > 0 ? reqW / reqH : 1
  const s = Math.min(MAX_SHARE, Math.max(MIN_SHARE, share))
  const aspect = r / (1 - s)
  let canvasH = floor64(Math.sqrt(INSET_MAX_PX / aspect))
  let canvasW = floor64(canvasH * aspect)
  while (canvasW * canvasH > INSET_MAX_PX) {
    if (canvasW >= canvasH) canvasW -= 64
    else canvasH -= 64
  }
  const divider = 8
  const panelW = round8(canvasW * s)
  return { canvasW, canvasH, panelW, divider }
}

/** 참고 그림 가장자리가 어두우면 칸 바탕을 검정으로 (밝은 테두리 + 흰 바탕이 가장 잘 따라감) */
async function edgeIsDark(buf: Buffer): Promise<boolean> {
  const { data, info } = await sharp(buf)
    .flatten({ background: '#ffffff' })
    .resize(32, 32, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  let sum = 0
  let n = 0
  for (let y = 0; y < info.height; y++)
    for (let x = 0; x < info.width; x++) {
      if (x > 1 && y > 1 && x < info.width - 2 && y < info.height - 2) continue
      const i = (y * info.width + x) * info.channels
      sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
      n++
    }
  return sum / Math.max(1, n) < 90
}

/** 인셋 캔버스(참고 칸 + 경계선 + 빈 쪽)와 오른쪽만 흰색인 마스크 */
export async function buildInsetSource(
  refPath: string,
  plan: InsetPlan
): Promise<{ imageBase64: string; maskBase64: string; darkPanel: boolean }> {
  const ref = readFileSync(refPath)
  const dark = await edgeIsDark(ref)
  const bg = dark ? { r: 0, g: 0, b: 0 } : { r: 255, g: 255, b: 255 }
  const fitW = plan.panelW - plan.divider
  const fitted = await sharp(ref)
    .flatten({ background: bg })
    .resize(fitW, plan.canvasH, { fit: 'contain', background: bg })
    .png()
    .toBuffer()
  const divider = await sharp({
    create: { width: plan.divider, height: plan.canvasH, channels: 3, background: '#000000' }
  })
    .png()
    .toBuffer()
  const canvas = await sharp({
    create: {
      width: plan.canvasW,
      height: plan.canvasH,
      channels: 3,
      background: { r: 255, g: 255, b: 255 }
    }
  })
    .composite([
      { input: fitted, left: 0, top: 0 },
      { input: divider, left: fitW, top: 0 }
    ])
    .png()
    .toBuffer()
  const maskW = plan.canvasW - plan.panelW
  const white = await sharp({
    create: { width: maskW, height: plan.canvasH, channels: 3, background: '#ffffff' }
  })
    .png()
    .toBuffer()
  const mask = await sharp({
    create: { width: plan.canvasW, height: plan.canvasH, channels: 3, background: '#000000' }
  })
    .composite([{ input: white, left: plan.panelW, top: 0 }])
    .png()
    .toBuffer()
  return {
    imageBase64: canvas.toString('base64'),
    maskBase64: mask.toString('base64'),
    darkPanel: dark
  }
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const TEXT_CHUNKS = new Set(['tEXt', 'zTXt', 'iTXt'])

/** PNG에서 글자 청크(NAI 프롬프트·설정)만 뽑는다 */
export function pngTextChunks(png: Buffer): Buffer[] {
  if (png.length < 8 || !png.subarray(0, 8).equals(PNG_SIG)) return []
  const out: Buffer[] = []
  let p = 8
  while (p + 12 <= png.length) {
    const len = png.readUInt32BE(p)
    const type = png.toString('ascii', p + 4, p + 8)
    const end = p + 12 + len
    if (end > png.length) break
    if (TEXT_CHUNKS.has(type)) out.push(png.subarray(p, end))
    if (type === 'IEND') break
    p = end
  }
  return out
}

/** 경계선 바로 옆은 모델이 칸 테두리를 이어 그리기 쉬워서 조금 더 잘라 낸다 */
export const INSET_CROP_MARGIN = 16

/** 결과에서 참고 칸을 잘라 낸다. PNG는 NAI 글자 청크를 그대로 옮겨 메타데이터를 지킨다 */
export async function cropInsetResult(
  image: Buffer,
  format: 'png' | 'webp',
  plan: InsetPlan
): Promise<Buffer> {
  const meta = await sharp(image).metadata()
  const w = meta.width ?? plan.canvasW
  const h = meta.height ?? plan.canvasH
  const left = Math.min(w - 1, Math.round(((plan.panelW + INSET_CROP_MARGIN) / plan.canvasW) * w))
  const cropped = sharp(image).extract({ left, top: 0, width: w - left, height: h })
  if (format === 'webp') return cropped.keepMetadata().webp({ quality: 95 }).toBuffer()
  const png = await cropped.png({ compressionLevel: 6 }).toBuffer()
  const chunks = pngTextChunks(image)
  if (!chunks.length) return png
  return Buffer.concat([png.subarray(0, 33), ...chunks, png.subarray(33)])
}
