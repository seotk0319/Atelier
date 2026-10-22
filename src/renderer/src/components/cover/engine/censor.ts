/**
 * 검열 붓. 배경 원본 픽셀 크기의 투명 마스크 1장을 bgId 별로 유지한다 (SPEC 10.5).
 * 되돌리기는 마스크 전체가 아니라 바뀐 영역(횡 bounding box)만 ImageData 로 보관한다.
 */
import type { CoverProject } from '@shared/cover'
import { getBlob, setMaskBlob } from './state'
import type { EditorBrush } from './types'

const MAX_HISTORY = 20
const HISTORY_BYTE_LIMIT = 384 * 1024 * 1024
const CHECK_BAND = 256

interface RectD {
  x0: number
  y0: number
  x1: number
  y1: number
}

interface Snap {
  x: number
  y: number
  w: number
  h: number
  data: ImageData
  empty: boolean | null
  seq: number
}

interface Stroke {
  radius: number
  hardness: number
  opacity: number
  rgb: [number, number, number]
  erase: boolean
  spacing: number
  last: { x: number; y: number } | null
  carry: number
  dabs: number
  bounds: RectD | null
}

interface Entry {
  bgId: string
  width: number
  height: number
  mask: HTMLCanvasElement
  buf: HTMLCanvasElement
  view: HTMLCanvasElement
  stroke: Stroke | null
  undo: Snap[]
  redo: Snap[]
  empty: boolean | null
}

const entries = new Map<string, Entry>()
const opening = new Map<string, { token: object; promise: Promise<HTMLCanvasElement | null> }>()
const commits = new Map<string, Promise<MaskKeys>>()
let generation = 0
let historyBytes = 0
let snapSeq = 0

interface MaskKeys {
  oldKey: string | null
  newKey: string | null
}

function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return c
}

function ctx2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('캔버스 2D 컨텍스트를 만들지 못했어요')
  return ctx
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

function parseColor(color: string): [number, number, number] {
  let s = typeof color === 'string' ? color.trim() : ''
  if (/^#[0-9a-f]{3}$/i.test(s)) s = '#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3]
  if (!/^#[0-9a-f]{6}$/i.test(s)) s = '#ffffff'
  return [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)]
}

function clampRect(entry: Entry, r: RectD): RectD {
  return {
    x0: clamp(r.x0, 0, entry.width),
    y0: clamp(r.y0, 0, entry.height),
    x1: clamp(r.x1, 0, entry.width),
    y1: clamp(r.y1, 0, entry.height)
  }
}

/** 마스크의 지정 영역을 ImageData 로 떠 둔다. rect 가 null 이면 전체. */
function capture(entry: Entry, rect: RectD | null): Snap | null {
  const b = rect ? clampRect(entry, rect) : { x0: 0, y0: 0, x1: entry.width, y1: entry.height }
  const x = Math.floor(b.x0)
  const y = Math.floor(b.y0)
  const w = Math.min(entry.width - x, Math.ceil(b.x1) - x)
  const h = Math.min(entry.height - y, Math.ceil(b.y1) - y)
  if (w <= 0 || h <= 0) return null
  const data = ctx2d(entry.mask).getImageData(x, y, w, h)
  return { x, y, w, h, data, empty: entry.empty, seq: ++snapSeq }
}

function snapBytes(s: Snap): number {
  return s.data.data.byteLength
}

function releaseSnap(snap: Snap): void {
  historyBytes -= snapBytes(snap)
  if (historyBytes < 0) historyBytes = 0
}

function clearStack(stack: Snap[]): void {
  for (const s of stack) releaseSnap(s)
  stack.length = 0
}

function pushHistory(stack: Snap[], snap: Snap): void {
  stack.push(snap)
  historyBytes += snapBytes(snap)
  while (stack.length > MAX_HISTORY) {
    const old = stack.shift()
    if (old) releaseSnap(old)
  }
  trimHistory()
}

/** 전체 기록 바이트가 한도를 넘으면 모든 bgId 의 기록 중 가장 오래된 것부터 버린다. */
function trimHistory(): void {
  while (historyBytes > HISTORY_BYTE_LIMIT) {
    let oldest: { stack: Snap[]; snap: Snap } | null = null
    for (const entry of entries.values()) {
      for (const stack of [entry.undo, entry.redo]) {
        const snap = stack[0]
        if (snap && (!oldest || snap.seq < oldest.snap.seq)) oldest = { stack, snap }
      }
    }
    if (!oldest) break
    const removed = oldest.stack.shift()
    if (!removed) break
    releaseSnap(removed)
  }
}

function restoreSnap(entry: Entry, snap: Snap): void {
  ctx2d(entry.mask).putImageData(snap.data, snap.x, snap.y)
  entry.empty = snap.empty
}

function unionRect(a: RectD | null, b: RectD): RectD {
  if (!a) return { ...b }
  return {
    x0: Math.min(a.x0, b.x0),
    y0: Math.min(a.y0, b.y0),
    x1: Math.max(a.x1, b.x1),
    y1: Math.max(a.y1, b.y1)
  }
}

/** view 의 지정 영역을 확정 마스크 + 진행 중인 획으로 다시 만든다. rect 생략 시 전체. */
function refreshView(entry: Entry, rect?: RectD): void {
  const { view, mask, buf, stroke, width, height } = entry
  let x = 0
  let y = 0
  let w = width
  let h = height
  if (rect) {
    const b = clampRect(entry, rect)
    x = Math.floor(b.x0)
    y = Math.floor(b.y0)
    w = Math.ceil(b.x1) - x
    h = Math.ceil(b.y1) - y
    if (w <= 0 || h <= 0) return
  }
  const ctx = ctx2d(view)
  ctx.save()
  ctx.globalAlpha = 1
  ctx.globalCompositeOperation = 'source-over'
  ctx.clearRect(x, y, w, h)
  ctx.drawImage(mask, x, y, w, h, x, y, w, h)
  if (stroke && stroke.bounds) {
    ctx.globalAlpha = stroke.opacity
    ctx.globalCompositeOperation = stroke.erase ? 'destination-out' : 'source-over'
    ctx.drawImage(buf, x, y, w, h, x, y, w, h)
  }
  ctx.restore()
}

/** 획 버퍼에 dab 하나를 불투명하게 찍는다. 바뀐 영역을 반환. */
function drawDab(entry: Entry, stroke: Stroke, x: number, y: number): RectD {
  const r = stroke.radius
  const ctx = ctx2d(entry.buf)
  const [cr, cg, cb] = stroke.rgb
  const solid = 'rgba(' + cr + ',' + cg + ',' + cb + ',1)'
  const g = ctx.createRadialGradient(x, y, 0, x, y, r)
  g.addColorStop(0, solid)
  g.addColorStop(clamp(stroke.hardness, 0, 0.99), solid)
  g.addColorStop(1, 'rgba(' + cr + ',' + cg + ',' + cb + ',0)')
  ctx.fillStyle = g
  ctx.beginPath()
  ctx.arc(x, y, r, 0, Math.PI * 2)
  ctx.fill()
  stroke.dabs++
  return { x0: x - r - 1, y0: y - r - 1, x1: x + r + 1, y1: y + r + 1 }
}

function discardStroke(entry: Entry): void {
  const s = entry.stroke
  if (!s) return
  entry.stroke = null
  if (s.bounds) {
    const b = clampRect(entry, s.bounds)
    const x = Math.floor(b.x0)
    const y = Math.floor(b.y0)
    const w = Math.ceil(b.x1) - x
    const h = Math.ceil(b.y1) - y
    if (w > 0 && h > 0) ctx2d(entry.buf).clearRect(x, y, w, h)
    refreshView(entry, b)
  }
}

function checkEmpty(entry: Entry): boolean {
  const { mask, width, height } = entry
  const ctx = ctx2d(mask)
  for (let y = 0; y < height; y += CHECK_BAND) {
    const h = Math.min(CHECK_BAND, height - y)
    const data = ctx.getImageData(0, y, width, h).data
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] !== 0) return false
    }
  }
  return true
}

export async function openMask(
  project: CoverProject,
  bgId: string
): Promise<HTMLCanvasElement | null> {
  const existing = entries.get(bgId)
  if (existing) return existing.view
  const pending = opening.get(bgId)
  if (pending) return pending.promise

  const gen = generation
  const token = {}
  const promise = (async (): Promise<HTMLCanvasElement | null> => {
    await null
    const bg = project.backgrounds.find((b) => b.id === bgId)
    if (!bg) return null
    const width = Math.max(1, Math.round(bg.width || 1))
    const height = Math.max(1, Math.round(bg.height || 1))
    const mask = makeCanvas(width, height)
    const buf = makeCanvas(width, height)
    const view = makeCanvas(width, height)
    let empty: boolean | null = true
    if (bg.maskKey) {
      try {
        const blob = await getBlob(bg.maskKey)
        if (blob) {
          const bmp = await createImageBitmap(blob)
          ctx2d(mask).drawImage(bmp, 0, 0, width, height)
          bmp.close()
          empty = null
        }
      } catch (err) {
        console.warn('[censor] 마스크를 불러오지 못했어요', err)
      }
    }
    if (gen !== generation || opening.get(bgId)?.token !== token) return null
    const entry: Entry = {
      bgId,
      width,
      height,
      mask,
      buf,
      view,
      stroke: null,
      undo: [],
      redo: [],
      empty
    }
    refreshView(entry)
    entries.set(bgId, entry)
    return view
  })()
  opening.set(bgId, { token, promise })
  try {
    return await promise
  } finally {
    if (opening.get(bgId)?.token === token) opening.delete(bgId)
  }
}

export function getMaskCanvas(bgId: string): HTMLCanvasElement | null {
  const entry = entries.get(bgId)
  return entry ? entry.view : null
}

export function beginStroke(bgId: string, brush: EditorBrush): void {
  const entry = entries.get(bgId)
  if (!entry) return
  discardStroke(entry)
  const size = Math.max(1, Number(brush.size) || 1)
  const hardness = Number(brush.hardness)
  const opacity = Number(brush.opacity)
  entry.stroke = {
    radius: Math.max(0.5, size / 2),
    hardness: clamp(Number.isFinite(hardness) ? hardness : 1, 0, 1),
    opacity: clamp(Number.isFinite(opacity) ? opacity : 1, 0, 1),
    rgb: parseColor(brush.color),
    erase: !!brush.erase,
    spacing: Math.max(1, size * 0.12),
    last: null,
    carry: 0,
    dabs: 0,
    bounds: null
  }
}

export function strokeTo(bgId: string, x: number, y: number): void {
  const entry = entries.get(bgId)
  const s = entry?.stroke
  if (!entry || !s || !Number.isFinite(x) || !Number.isFinite(y)) return
  let dirty: RectD | null = null
  if (!s.last) {
    dirty = drawDab(entry, s, x, y)
    s.carry = 0
  } else {
    const dx = x - s.last.x
    const dy = y - s.last.y
    const dist = Math.hypot(dx, dy)
    if (dist === 0) return
    const ux = dx / dist
    const uy = dy / dist
    let t = s.spacing - s.carry
    let lastT = -1
    while (t <= dist) {
      dirty = unionRect(dirty, drawDab(entry, s, s.last.x + ux * t, s.last.y + uy * t))
      lastT = t
      t += s.spacing
    }
    s.carry = lastT >= 0 ? dist - lastT : s.carry + dist
  }
  s.last = { x, y }
  if (dirty) {
    s.bounds = unionRect(s.bounds, dirty)
    refreshView(entry, dirty)
  }
}

export function endStroke(bgId: string): boolean {
  const entry = entries.get(bgId)
  const s = entry?.stroke
  if (!entry || !s) return false
  const wasEmpty = entry.empty === true
  if (!s.bounds || s.dabs === 0 || s.opacity <= 0 || (s.erase && wasEmpty)) {
    discardStroke(entry)
    return false
  }

  const b = clampRect(entry, s.bounds)
  const x = Math.floor(b.x0)
  const y = Math.floor(b.y0)
  const w = Math.ceil(b.x1) - x
  const h = Math.ceil(b.y1) - y

  const snap = capture(entry, s.bounds)
  if (!snap) {
    discardStroke(entry)
    return false
  }
  pushHistory(entry.undo, snap)
  clearStack(entry.redo)

  if (w > 0 && h > 0) {
    const ctx = ctx2d(entry.mask)
    ctx.save()
    ctx.globalAlpha = s.opacity
    ctx.globalCompositeOperation = s.erase ? 'destination-out' : 'source-over'
    ctx.drawImage(entry.buf, x, y, w, h, x, y, w, h)
    ctx.restore()
    ctx2d(entry.buf).clearRect(x, y, w, h)
  }
  entry.empty = s.erase ? null : false
  entry.stroke = null
  refreshView(entry, b)
  return true
}

export function undo(bgId: string): boolean {
  const entry = entries.get(bgId)
  if (!entry || entry.undo.length === 0) return false
  discardStroke(entry)
  const prev = entry.undo.pop()
  if (!prev) return false
  releaseSnap(prev)
  const current = capture(entry, {
    x0: prev.x,
    y0: prev.y,
    x1: prev.x + prev.w,
    y1: prev.y + prev.h
  })
  if (current) pushHistory(entry.redo, current)
  restoreSnap(entry, prev)
  refreshView(entry)
  return true
}

export function redo(bgId: string): boolean {
  const entry = entries.get(bgId)
  if (!entry || entry.redo.length === 0) return false
  discardStroke(entry)
  const next = entry.redo.pop()
  if (!next) return false
  releaseSnap(next)
  const current = capture(entry, {
    x0: next.x,
    y0: next.y,
    x1: next.x + next.w,
    y1: next.y + next.h
  })
  if (current) pushHistory(entry.undo, current)
  restoreSnap(entry, next)
  refreshView(entry)
  return true
}

export function clear(bgId: string): boolean {
  const entry = entries.get(bgId)
  if (!entry) return false
  discardStroke(entry)
  if (isEmpty(bgId)) return false
  const snap = capture(entry, null)
  if (!snap) return false
  pushHistory(entry.undo, snap)
  clearStack(entry.redo)
  ctx2d(entry.mask).clearRect(0, 0, entry.width, entry.height)
  entry.empty = true
  refreshView(entry)
  return true
}

export function isEmpty(bgId: string): boolean {
  const entry = entries.get(bgId)
  if (!entry) return true
  if (entry.empty === null || entry.empty === undefined) entry.empty = checkEmpty(entry)
  return entry.empty
}

async function doCommit(project: CoverProject, bgId: string): Promise<MaskKeys> {
  const entry = entries.get(bgId)
  if (!entry) {
    const bg = project.backgrounds.find((b) => b.id === bgId)
    const key = bg?.maskKey ?? null
    return { oldKey: key, newKey: key }
  }
  if (isEmpty(bgId)) return setMaskBlob(project, bgId, null)
  const blob = await new Promise<Blob | null>((resolve) => {
    entry.mask.toBlob((b) => resolve(b), 'image/png')
  })
  if (!blob) throw new Error('마스크 PNG 변환에 실패했어요')
  return setMaskBlob(project, bgId, blob)
}

/** 같은 bgId 의 commit 은 순서대로 실행한다 (마스크 blob 교체 경쟁 방지). */
export function commit(project: CoverProject, bgId: string): Promise<MaskKeys> {
  const prev = commits.get(bgId) ?? Promise.resolve({ oldKey: null, newKey: null })
  const next = prev
    .catch(() => ({ oldKey: null, newKey: null }))
    .then(() => doCommit(project, bgId))
  commits.set(bgId, next)
  void next.then(
    () => {
      if (commits.get(bgId) === next) commits.delete(bgId)
    },
    () => {
      if (commits.get(bgId) === next) commits.delete(bgId)
    }
  )
  return next
}

export function close(bgId: string): void {
  opening.delete(bgId)
  const entry = entries.get(bgId)
  if (!entry) return
  entries.delete(bgId)
  entry.stroke = null
  clearStack(entry.undo)
  clearStack(entry.redo)
  for (const c of [entry.mask, entry.buf, entry.view]) {
    c.width = 0
    c.height = 0
  }
}

export function closeAll(): void {
  generation++
  for (const id of [...entries.keys()]) close(id)
  opening.clear()
}

export function canUndo(bgId: string): boolean {
  return (entries.get(bgId)?.undo.length ?? 0) > 0
}

export function canRedo(bgId: string): boolean {
  return (entries.get(bgId)?.redo.length ?? 0) > 0
}
