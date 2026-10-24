/**
 * 표지 합성. 배경 cover 맞춤 → 검열 마스크 → 액자(6종) → 타이포 → PNG.
 * 원본 cover-batch src/render.js 이식 (SPEC 10.4).
 */
import {
  coverRect,
  findLayer,
  getCoverCanvas,
  getPan,
  getPlacement,
  typoRect,
  typoLayers,
  type CoverCanvasId,
  type CoverFrame,
  type CoverItem,
  type CoverPan,
  type CoverPlacement,
  type CoverProject
} from '@shared/cover'
import { getMaskCanvas } from './censor'
import { getBlob } from './state'

const EMPTY_BG = '#d9d9d9'
const CACHE_PIXEL_LIMIT = 300_000_000

interface BitmapEntry {
  promise: Promise<ImageBitmap | null>
  pixels: number
}

const bitmapCache = new Map<string, BitmapEntry>()
let cachePixels = 0

/** 300M 픽셀을 넘으면 오래된 항목을 맵에서만 뺀다. 그리는 중일 수 있어 close 하지 않는다. */
function evictBitmaps(keepKey: string): void {
  if (cachePixels <= CACHE_PIXEL_LIMIT) return
  for (const [key, entry] of bitmapCache) {
    if (cachePixels <= CACHE_PIXEL_LIMIT) break
    if (key === keepKey || entry.pixels === 0) continue
    bitmapCache.delete(key)
    cachePixels -= entry.pixels
  }
}

/** blobKey → ImageBitmap. Promise 를 캐시해 같은 그림을 중복 로드하지 않는다. */
export function getBitmap(key: string): Promise<ImageBitmap | null> {
  if (!key) return Promise.resolve(null)
  const hit = bitmapCache.get(key)
  if (hit) return hit.promise

  const entry: BitmapEntry = { promise: Promise.resolve(null), pixels: 0 }
  const promise = (async (): Promise<ImageBitmap | null> => {
    const blob = await getBlob(key)
    if (!blob) return null
    try {
      return await createImageBitmap(blob)
    } catch {
      return null
    }
  })()
  entry.promise = promise
  bitmapCache.set(key, entry)

  promise.then(
    (bmp) => {
      if (bitmapCache.get(key) !== entry) return
      if (!bmp) {
        bitmapCache.delete(key)
        return
      }
      entry.pixels = bmp.width * bmp.height
      cachePixels += entry.pixels
      evictBitmaps(key)
    },
    () => {
      if (bitmapCache.get(key) === entry) bitmapCache.delete(key)
    }
  )
  return promise
}

export function forgetBitmap(key: string): void {
  const entry = bitmapCache.get(key)
  if (!entry) return
  bitmapCache.delete(key)
  cachePixels = Math.max(0, cachePixels - entry.pixels)
}

/** 타이포 본체나 문구 한 장 */
export interface CoverLayer {
  id: string
  item: CoverItem
  image: CanvasImageSource
  placement: CoverPlacement
}

export interface CoverDrawSpec {
  W: number
  H: number
  bg: { image: CanvasImageSource; width: number; height: number; pan: CoverPan } | null
  mask: CanvasImageSource | null
  typo: { image: CanvasImageSource; placement: CoverPlacement } | null
  /**
   * 타이포 본체와 문구 전부 (그리는 순서). 있으면 typo 대신 이것을 그리고,
   * id 가 activeId 인 레이어는 typo.placement 로 그린다 (편집 중인 위치).
   */
  layers?: CoverLayer[]
  activeId?: string | null
  typoAlpha?: number
  frame: CoverFrame
  frameImage: CanvasImageSource | null
  /** bg 가 없을 때 채움. 기본 '#d9d9d9' */
  emptyFill?: string
}

function clamp01(v: unknown, fallback: number): number {
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  return n < 0 ? 0 : n > 1 ? 1 : n
}

function num(v: unknown, fallback: number): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number
): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2))
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, w, h, rr)
  } else if (rr <= 0) {
    ctx.rect(x, y, w, h)
  } else {
    ctx.moveTo(x + rr, y)
    ctx.arcTo(x + w, y, x + w, y + h, rr)
    ctx.arcTo(x + w, y + h, x, y + h, rr)
    ctx.arcTo(x, y + h, x, y, rr)
    ctx.arcTo(x, y, x + w, y, rr)
    ctx.closePath()
  }
}

/** 출력 픽셀 좌표 기준. 호출자가 scale 변환을 걸어 둔다. */
export function drawFrame(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  frame: CoverFrame,
  frameImage: CanvasImageSource | null
): void {
  if (!frame || !frame.enabled) return
  const style = frame.style || 'solid'
  const opacity = clamp01(frame.opacity, 1)
  if (opacity <= 0) return

  ctx.save()
  ctx.globalAlpha = ctx.globalAlpha * opacity

  if (style === 'image') {
    if (frameImage) ctx.drawImage(frameImage, 0, 0, W, H)
    ctx.restore()
    return
  }

  const width = Math.max(0, num(frame.width, 0))
  const inset = num(frame.inset, 0)
  const radius = Math.max(0, num(frame.radius, 0))
  const o = inset + width / 2
  const rw = W - 2 * o
  const rh = H - 2 * o
  if (!(width > 0) || !(rw > 0) || !(rh > 0)) {
    ctx.restore()
    return
  }

  ctx.lineWidth = width
  if (frame.color2) {
    const g = ctx.createLinearGradient(0, 0, W, H)
    g.addColorStop(0, frame.color)
    g.addColorStop(1, frame.color2)
    ctx.strokeStyle = g
  } else {
    ctx.strokeStyle = frame.color
  }
  ctx.setLineDash([])
  ctx.lineCap = 'butt'
  ctx.lineJoin = 'miter'

  switch (style) {
    case 'double': {
      ctx.beginPath()
      roundRectPath(ctx, o, o, rw, rh, radius)
      ctx.stroke()
      const d = width + Math.max(0, num(frame.gap, 0))
      const iw = rw - 2 * d
      const ih = rh - 2 * d
      if (iw > 0 && ih > 0) {
        ctx.beginPath()
        roundRectPath(ctx, o + d, o + d, iw, ih, Math.max(0, radius - d))
        ctx.stroke()
      }
      break
    }
    case 'dashed': {
      ctx.setLineDash([width * 4, width * 2.5])
      ctx.lineCap = 'butt'
      ctx.beginPath()
      roundRectPath(ctx, o, o, rw, rh, radius)
      ctx.stroke()
      break
    }
    case 'dotted': {
      ctx.setLineDash([0.001, width * 2.2])
      ctx.lineCap = 'round'
      ctx.beginPath()
      roundRectPath(ctx, o, o, rw, rh, radius)
      ctx.stroke()
      break
    }
    case 'corners': {
      const len = Math.max(0, num(frame.cornerLen, 0))
      const lx = Math.min(len, rw / 2)
      const ly = Math.min(len, rh / 2)
      if (lx > 0 || ly > 0) {
        const x0 = o
        const y0 = o
        const x1 = o + rw
        const y1 = o + rh
        ctx.lineCap = 'square'
        ctx.lineJoin = 'miter'
        ctx.beginPath()
        ctx.moveTo(x0, y0 + ly)
        ctx.lineTo(x0, y0)
        ctx.lineTo(x0 + lx, y0)
        ctx.moveTo(x1 - lx, y0)
        ctx.lineTo(x1, y0)
        ctx.lineTo(x1, y0 + ly)
        ctx.moveTo(x1, y1 - ly)
        ctx.lineTo(x1, y1)
        ctx.lineTo(x1 - lx, y1)
        ctx.moveTo(x0 + lx, y1)
        ctx.lineTo(x0, y1)
        ctx.lineTo(x0, y1 - ly)
        ctx.stroke()
      }
      break
    }
    case 'solid':
    default: {
      ctx.beginPath()
      roundRectPath(ctx, o, o, rw, rh, radius)
      ctx.stroke()
      break
    }
  }

  ctx.setLineDash([])
  ctx.restore()
}

export function drawCover(ctx: CanvasRenderingContext2D, scale: number, spec: CoverDrawSpec): void {
  const { W, H, bg, typo, frame } = spec
  const mask = spec.mask
  const frameImage = spec.frameImage
  const typoAlpha = clamp01(spec.typoAlpha, 1)

  ctx.save()
  ctx.beginPath()
  ctx.rect(0, 0, W * scale, H * scale)
  ctx.clip()
  ctx.scale(scale, scale)
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'

  // 1. 배경 + 2. 검열 마스크 (배경과 같은 coverRect)
  if (bg) {
    const r = coverRect(bg.width, bg.height, W, H, bg.pan)
    ctx.drawImage(bg.image, r.x, r.y, r.w, r.h)
    if (mask) ctx.drawImage(mask, r.x, r.y, r.w, r.h)
  } else {
    ctx.fillStyle = spec.emptyFill ?? EMPTY_BG
    ctx.fillRect(0, 0, W, H)
  }

  // 3. 액자
  if (frame && frame.enabled) drawFrame(ctx, W, H, frame, frameImage)

  // 4. 타이포
  if (typo && typoAlpha > 0) {
    const list = spec.layers?.length
      ? spec.layers.map((l) =>
          l.id === spec.activeId ? { image: typo.image, placement: typo.placement } : l
        )
      : [typo]
    ctx.save()
    ctx.globalAlpha = typoAlpha
    for (const l of list) {
      const r = typoRect(W, H, l.placement)
      if (r.w > 0 && r.h > 0) ctx.drawImage(l.image, r.x, r.y, r.w, r.h)
    }
    ctx.restore()
  }

  ctx.restore()
}

function findItem(list: CoverItem[], id: string | null): CoverItem | null {
  if (id == null) return null
  return list.find((it) => it.id === id) ?? null
}

export async function buildSpec(
  project: CoverProject,
  bgId: string | null,
  /** 타이포 번호 또는 그 타이포의 문구 번호 (문구면 그 문구가 편집 대상) */
  typoId: string | null,
  canvasId: CoverCanvasId
): Promise<CoverDrawSpec> {
  const canvas = getCoverCanvas(canvasId)
  if (!canvas) throw new Error('알 수 없는 캔버스: ' + canvasId)
  const W = canvas.w
  const H = canvas.h

  const bgItem = findItem(project.backgrounds, bgId)
  const found = findLayer(project, typoId)
  const typoItem = found?.item ?? null
  const layerItems = found ? typoLayers(found.typo) : []
  const frameItem = project.frameImages[canvasId] ?? null

  const [bgBitmap, frameImage, ...layerBitmaps] = await Promise.all([
    bgItem ? getBitmap(bgItem.blobKey) : null,
    frameItem ? getBitmap(frameItem.blobKey) : null,
    ...layerItems.map((it) => getBitmap(it.blobKey))
  ])
  const layers: CoverLayer[] = []
  layerItems.forEach((it, i) => {
    const image = layerBitmaps[i]
    if (image)
      layers.push({ id: it.id, item: it, image, placement: getPlacement(project, it, canvas) })
  })
  const active = layers.find((l) => l.id === typoItem?.id) ?? null

  let mask: CanvasImageSource | null = null
  if (bgItem) {
    mask = getMaskCanvas(bgItem.id) ?? (bgItem.maskKey ? await getBitmap(bgItem.maskKey) : null)
  }

  return {
    W,
    H,
    bg:
      bgItem && bgBitmap
        ? {
            image: bgBitmap,
            width: bgBitmap.width,
            height: bgBitmap.height,
            pan: getPan(project, bgItem.id, canvasId)
          }
        : null,
    mask: bgItem && bgBitmap ? mask : null,
    typo: active ? { image: active.image, placement: active.placement } : null,
    layers,
    activeId: active?.id ?? null,
    typoAlpha: 1,
    frame: project.frame,
    frameImage
  }
}

export async function renderCoverCanvas(
  project: CoverProject,
  bgId: string | null,
  typoId: string | null,
  canvasId: CoverCanvasId,
  scale = 1
): Promise<HTMLCanvasElement> {
  const canvas = getCoverCanvas(canvasId)
  if (!canvas) throw new Error('알 수 없는 캔버스: ' + canvasId)
  const spec = await buildSpec(project, bgId, typoId, canvasId)
  const el = document.createElement('canvas')
  el.width = Math.max(1, Math.round(canvas.w * scale))
  el.height = Math.max(1, Math.round(canvas.h * scale))
  const ctx = el.getContext('2d')
  if (!ctx) throw new Error('캔버스 2D 컨텍스트를 만들지 못했어요')
  drawCover(ctx, scale, spec)
  return el
}

export async function renderCoverBlob(
  project: CoverProject,
  bgId: string | null,
  typoId: string | null,
  canvasId: CoverCanvasId
): Promise<Blob> {
  const el = await renderCoverCanvas(project, bgId, typoId, canvasId, 1)
  return new Promise((resolve, reject) => {
    el.toBlob((blob) => {
      if (blob) resolve(blob)
      else reject(new Error('PNG 생성에 실패했어요'))
    }, 'image/png')
  })
}
