import {
  coverRect,
  findLayer,
  getCoverCanvas,
  getPan,
  getPlacement,
  setPan,
  setPlacement,
  typoRect,
  type CoverCanvas,
  type CoverCanvasId,
  type CoverItem,
  type CoverPlacement,
  type CoverProject
} from '@shared/cover'
import { buildSpec, drawCover, forgetBitmap } from './render'
import type { CoverDrawSpec } from './render'
import * as censor from './censor'
import type {
  CoverChangeKind,
  CoverEditorApi,
  CoverEditorOptions,
  CoverMode,
  EditorBrush
} from './types'

/**
 * 표지 배치 편집기. 원본 cover-batch/src/editor.js (SPEC 7장 + 10.6장)를
 * Electron 렌더러용 TypeScript 로 옮겼다.
 */

const PAD = 24
const HANDLE = 12
const HANDLE_HIT = HANDLE / 2 + 3
const MIN_W_RATIO = 0.02
const MIN_H_RATIO = 0.02
const CENSOR_TYPO_ALPHA = 0.35
const SNAP_PX = 6
const HINT_FONT = '13px system-ui, -apple-system, "Segoe UI", "Malgun Gothic", sans-serif'
const MSG_BG = '배경 그림을 넣어 주세요'
const MSG_TYPO = '타이포 PNG를 넣어 주세요'

type HandleKey = 'nw' | 'ne' | 'sw' | 'se' | 'n' | 's' | 'w' | 'e'

const HANDLE_KEYS: readonly HandleKey[] = ['nw', 'ne', 'sw', 'se', 'n', 's', 'w', 'e']
const HANDLE_CURSOR: Record<HandleKey, string> = {
  nw: 'nwse-resize',
  se: 'nwse-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
  n: 'ns-resize',
  s: 'ns-resize',
  w: 'ew-resize',
  e: 'ew-resize'
}
const ARROWS: Record<string, readonly [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1]
}
const MODES: readonly CoverMode[] = ['typo', 'pan', 'censor']
const DEFAULT_BRUSH: EditorBrush = {
  size: 60,
  hardness: 0.7,
  opacity: 1,
  color: '#ffffff',
  erase: false
}

interface Point {
  x: number
  y: number
}

interface ClientPoint {
  clientX: number
  clientY: number
}

interface Measure {
  cssW: number
  cssH: number
  sx: number
  sy: number
}

interface Layout extends Measure {
  def: CoverCanvas
  W: number
  H: number
  vs: number
  ox: number
  oy: number
}

interface View {
  canvasId: CoverCanvasId
  bgId: string | null
  typoId: string | null
  bgItem: CoverItem | null
  typoItem: CoverItem | null
}

interface DragBase {
  pointerId: number
  ids: { canvasId: CoverCanvasId; bgId: string | null; typoId: string | null }
  changed: boolean
}

interface MoveDrag extends DragBase {
  kind: 'move'
  start: Point
  pl0: CoverPlacement
}

interface ResizeDrag extends DragBase {
  kind: 'resize'
  handle: HandleKey
  fixed: Point
  d: Point
  dd: number
  w0: number
  h0: number
  grab: Point
}

interface EdgeDrag extends DragBase {
  kind: 'edge'
  handle: HandleKey
  pl0: CoverPlacement
  left: number
  right: number
  top: number
  bottom: number
  grab: Point
}

interface PanDrag extends DragBase {
  kind: 'pan'
  start: Point
  pan0: { px: number; py: number }
}

interface StrokeDrag extends DragBase {
  kind: 'stroke'
  project: CoverProject
}

type Drag = MoveDrag | ResizeDrag | EdgeDrag | PanDrag | StrokeDrag

interface Theme {
  stage: string
  accent: string
  muted: string
}

interface CommitResult {
  oldKey: string | null
  newKey: string | null
}

interface SpecKeys {
  maskKey: string | null
  frameKey: string | null
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

function finite(v: unknown, fallback: number): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

function readTheme(): Theme {
  const root = getComputedStyle(document.documentElement)
  const body = getComputedStyle(document.body)
  return {
    stage: root.getPropertyValue('--surface-2').trim() || body.backgroundColor || 'Canvas',
    accent: root.getPropertyValue('--accent').trim() || body.color || 'CanvasText',
    muted: root.getPropertyValue('--muted').trim() || body.color || 'CanvasText'
  }
}

export function createCoverEditor(
  container: HTMLElement,
  opts: CoverEditorOptions
): CoverEditorApi {
  const { getProject, onChange, onHistory } = opts

  const canvas = document.createElement('canvas')
  canvas.tabIndex = 0
  canvas.setAttribute('aria-label', '표지 배치 편집기')
  Object.assign(canvas.style, {
    position: 'absolute',
    inset: '0',
    width: '100%',
    height: '100%',
    display: 'block',
    outline: 'none',
    touchAction: 'none',
    userSelect: 'none'
  })

  const prevPosition = container.style.position
  if (getComputedStyle(container).position === 'static') container.style.position = 'relative'
  container.appendChild(canvas)

  const context = canvas.getContext('2d')
  if (!context) throw new Error('표지 편집기 캔버스를 만들지 못했어요')
  const ctx: CanvasRenderingContext2D = context

  let mode: CoverMode = 'typo'
  let target: { canvasId: CoverCanvasId; bgId: string | null; typoId: string | null } | null = null
  let view: View | null = null
  let spec: CoverDrawSpec | null = null
  let specKeys: SpecKeys = { maskKey: null, frameKey: null }
  let specPending: string | null = null
  let loadSeq = 0
  let loading = false
  let drag: Drag | null = null
  let raf = 0
  let lay: Layout | null = null
  let destroyed = false
  let dprQuery: MediaQueryList | null = null
  let hover: Point | null = null
  let snapX: number | null = null
  let snapY: number | null = null
  let theme: Theme = readTheme()
  const brush: EditorBrush = { ...DEFAULT_BRUSH }

  let strokeQ: Promise<void> = Promise.resolve()
  let commitQ: Promise<void> = Promise.resolve()

  function project(): CoverProject | null {
    try {
      return getProject()
    } catch (err) {
      console.error(err)
      return null
    }
  }

  function notify(kind: CoverChangeKind): void {
    try {
      onChange(kind)
    } catch (err) {
      console.error(err)
    }
  }

  function findBg(p: CoverProject | null, id: string | null): CoverItem | null {
    return p && id ? (p.backgrounds.find((it) => it.id === id) ?? null) : null
  }

  function findTypo(p: CoverProject | null, id: string | null): CoverItem | null {
    // 타이포 본체 또는 그 타이포의 문구 (편집 대상)
    return p ? (findLayer(p, id)?.item ?? null) : null
  }

  /** 편집 대상이 아닌 같은 언어의 레이어들 (지금 위치) */
  function otherLayers(p: CoverProject): { id: string; rect: ReturnType<typeof coverRect> }[] {
    if (!spec?.layers || !lay || !view) return []
    const l = lay
    return spec.layers
      .filter((x) => x.id !== view!.typoId)
      .map((x) => ({ id: x.id, rect: typoRect(l.W, l.H, getPlacement(p, x.item, l.def)) }))
  }

  function specKeysOf(p: CoverProject | null, v: View | null): SpecKeys {
    if (!p || !v) return { maskKey: null, frameKey: null }
    const bg = findBg(p, v.bgId)
    return {
      maskKey: bg?.maskKey ?? null,
      frameKey: p.frameImages[v.canvasId]?.blobKey ?? null
    }
  }

  function sameSpecKeys(a: SpecKeys, b: SpecKeys): boolean {
    return a.maskKey === b.maskKey && a.frameKey === b.frameKey
  }

  // ---------- 크기 · 좌표 ----------

  function measure(): Measure {
    const cssW = Math.max(0, container.clientWidth)
    const cssH = Math.max(0, container.clientHeight)
    const dpr = window.devicePixelRatio || 1
    const bw = Math.max(1, Math.round(cssW * dpr))
    const bh = Math.max(1, Math.round(cssH * dpr))
    if (canvas.width !== bw) canvas.width = bw
    if (canvas.height !== bh) canvas.height = bh
    const sx = cssW > 0 ? bw / cssW : dpr
    const sy = cssH > 0 ? bh / cssH : dpr
    return { cssW, cssH, sx, sy }
  }

  function computeLayout(m: Measure): Layout | null {
    const def = view ? getCoverCanvas(view.canvasId) : null
    if (!def) return null
    const W = def.w
    const H = def.h
    const availW = Math.max(1, m.cssW - 2 * PAD)
    const availH = Math.max(1, m.cssH - 2 * PAD)
    const vs = Math.min(availW / W, availH / H)
    return {
      ...m,
      def,
      W,
      H,
      vs,
      ox: (m.cssW - W * vs) / 2,
      oy: (m.cssH - H * vs) / 2
    }
  }

  function updateLayout(): Layout | null {
    const bw = canvas.width
    const bh = canvas.height
    lay = computeLayout(measure())
    if (canvas.width !== bw || canvas.height !== bh) draw()
    return lay
  }

  function clientToCss(e: ClientPoint): Point {
    const rect = canvas.getBoundingClientRect()
    const l = lay
    if (!l) return { x: 0, y: 0 }
    const kx = rect.width > 0 ? l.cssW / rect.width : 1
    const ky = rect.height > 0 ? l.cssH / rect.height : 1
    return { x: (e.clientX - rect.left) * kx, y: (e.clientY - rect.top) * ky }
  }

  function cssToOut(p: Point): Point {
    const l = lay
    if (!l) return { x: 0, y: 0 }
    return { x: (p.x - l.ox) / l.vs, y: (p.y - l.oy) / l.vs }
  }

  function outToCss(p: Point): Point {
    const l = lay
    if (!l) return { x: 0, y: 0 }
    return { x: l.ox + p.x * l.vs, y: l.oy + p.y * l.vs }
  }

  function bgCover(p: CoverProject, v: View): ReturnType<typeof coverRect> {
    const item = v.bgItem
    if (!item) throw new Error('배경이 없어요')
    return coverRect(item.width, item.height, lay!.W, lay!.H, getPan(p, v.bgId!, v.canvasId))
  }

  function outToBg(po: Point, cr: ReturnType<typeof coverRect>, item: CoverItem): Point {
    return {
      x: ((po.x - cr.x) * item.width) / cr.w,
      y: ((po.y - cr.y) * item.height) / cr.h
    }
  }

  function coverScale(v: View): number {
    const item = v.bgItem
    if (!item || !lay) return 1
    return Math.max(lay.W / item.width, lay.H / item.height)
  }

  function currentPlacement(p: CoverProject, v: View): CoverPlacement {
    const item = v.typoItem
    if (!item || !lay) return { cx: 0.5, cy: 0.5, w: 0.5, h: 0.5 }
    return getPlacement(p, item, lay.def)
  }

  function currentTypoRect(p: CoverProject, v: View): ReturnType<typeof coverRect> {
    const item = v.typoItem
    if (!item || !lay) return { x: 0, y: 0, w: 0, h: 0 }
    return typoRect(lay.W, lay.H, currentPlacement(p, v))
  }

  // ---------- 그리기 ----------

  function scheduleDraw(): void {
    if (raf || destroyed) return
    raf = requestAnimationFrame(() => {
      raf = 0
      draw()
    })
  }

  function hasBg(): boolean {
    return !!(view && view.bgItem && spec && spec.bg)
  }

  function hasTypo(): boolean {
    return !!(view && view.typoItem && spec && spec.typo)
  }

  // ---------- 화면 크기 사본 ----------
  // 원본(수천 px)을 매 프레임 고화질로 줄여 그리면 끌기가 끊긴다.
  // 화면에 보이는 크기로 한 번 줄여 둔 사본을 그리고, 끄는 동안엔 크기가 조금 달라도 그 사본을 쓴다.
  interface Scaled {
    w: number
    h: number
    bmp: ImageBitmap | null
    pending: boolean
  }
  const scaled = new Map<CanvasImageSource, Scaled>()
  const usedSources = new Set<CanvasImageSource>()

  function sizeOf(src: CanvasImageSource): { w: number; h: number } | null {
    const s = src as { width?: unknown; height?: unknown }
    return typeof s.width === 'number' && typeof s.height === 'number'
      ? { w: s.width, h: s.height }
      : null
  }

  function scaledFor(src: CanvasImageSource, tw: number, th: number): CanvasImageSource {
    usedSources.add(src)
    const size = sizeOf(src)
    const w = Math.max(1, Math.round(tw))
    const h = Math.max(1, Math.round(th))
    // 거의 줄이지 않는 경우는 원본이 더 선명하고 충분히 빠르다
    if (!size || (w >= size.w * 0.8 && h >= size.h * 0.8)) return src
    const e = scaled.get(src)
    if (e?.bmp && Math.abs(e.w - w) <= 2 && Math.abs(e.h - h) <= 2) return e.bmp
    if (e?.bmp && drag) return e.bmp
    if (!e?.pending) {
      const entry: Scaled = { w, h, bmp: e?.bmp ?? null, pending: true }
      scaled.set(src, entry)
      createImageBitmap(src as ImageBitmapSource, {
        resizeWidth: w,
        resizeHeight: h,
        resizeQuality: 'high'
      })
        .then((bmp) => {
          if (destroyed || scaled.get(src) !== entry) {
            bmp.close()
            return
          }
          entry.bmp?.close()
          entry.bmp = bmp
          entry.w = w
          entry.h = h
          entry.pending = false
          scheduleDraw()
        })
        .catch(() => {
          entry.pending = false
        })
    }
    return e?.bmp ?? src
  }

  /** 이번 그리기에서 안 쓴 원본의 사본은 버린다 (배경을 바꾸면 옛 사본이 남지 않게) */
  function pruneScaled(): void {
    for (const [src, e] of scaled) {
      if (usedSources.has(src) || e.pending) continue
      e.bmp?.close()
      scaled.delete(src)
    }
    usedSources.clear()
  }

  function toDisplay(s: CoverDrawSpec, l: Layout, m: Measure, liveMask: boolean): CoverDrawSpec {
    const kx = l.vs * m.sx
    const ky = l.vs * m.sy
    const out: CoverDrawSpec = { ...s }
    if (s.bg) {
      const r = coverRect(s.bg.width, s.bg.height, s.W, s.H, s.bg.pan)
      out.bg = { ...s.bg, image: scaledFor(s.bg.image, r.w * kx, r.h * ky) }
      // 검열 중인 마스크는 붓질마다 바뀌므로 원본 그대로
      if (s.mask && !liveMask) out.mask = scaledFor(s.mask, r.w * kx, r.h * ky)
    }
    if (s.typo) {
      const r = typoRect(s.W, s.H, s.typo.placement)
      out.typo = { ...s.typo, image: scaledFor(s.typo.image, r.w * kx, r.h * ky) }
    }
    if (s.layers) {
      out.layers = s.layers.map((l) => {
        if (l.id === s.activeId) return l
        const r = typoRect(s.W, s.H, l.placement)
        return { ...l, image: scaledFor(l.image, r.w * kx, r.h * ky) }
      })
    }
    if (s.frameImage) out.frameImage = scaledFor(s.frameImage, s.W * kx, s.H * ky)
    return out
  }

  function draw(): void {
    if (destroyed) return
    if (raf) {
      cancelAnimationFrame(raf)
      raf = 0
    }
    const m = measure()
    lay = computeLayout(m)

    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.fillStyle = theme.stage
    ctx.fillRect(0, 0, canvas.width, canvas.height)

    const p = project()
    if (!lay || !p || !view) return

    syncSpec(p, view)

    const keys = specKeysOf(p, view)
    const liveMask = view.bgId ? censor.getMaskCanvas(view.bgId) : null
    const mask = liveMask ?? (keys.maskKey === specKeys.maskKey ? (spec?.mask ?? null) : null)
    const frameImage =
      keys.frameKey && keys.frameKey === specKeys.frameKey ? (spec?.frameImage ?? null) : null

    if (spec) {
      const drawSpec: CoverDrawSpec = {
        ...spec,
        bg: spec.bg && hasBg() ? { ...spec.bg, pan: getPan(p, view.bgId!, view.canvasId) } : null,
        typo:
          spec.typo && hasTypo() ? { ...spec.typo, placement: currentPlacement(p, view) } : null,
        // 다른 레이어는 저장된 위치를 그때그때 읽는다 (되돌리기·숫자 입력이 바로 보이게)
        layers: spec.layers?.map((l) =>
          l.id === spec!.activeId ? l : { ...l, placement: getPlacement(p, l.item, lay!.def) }
        ),
        mask,
        frame: p.frame,
        frameImage,
        typoAlpha: mode === 'censor' ? CENSOR_TYPO_ALPHA : 1
      }

      ctx.setTransform(m.sx, 0, 0, m.sy, 0, 0)
      ctx.save()
      ctx.translate(lay.ox, lay.oy)
      try {
        drawCover(ctx, lay.vs, toDisplay(drawSpec, lay, m, !!liveMask))
      } catch (err) {
        console.error(err)
      }
      ctx.restore()
      pruneScaled()
    }

    drawSnapGuides()
    drawGuides()
    if (mode === 'typo' && hasTypo()) drawTypoOverlay(p, view, m)
    if (mode === 'censor' && hasBg()) drawBrushCursor(m)
  }

  function syncSpec(p: CoverProject, v: View): void {
    if (!spec || loading) return
    const keys = specKeysOf(p, v)
    if (sameSpecKeys(keys, specKeys)) return
    const sig = (keys.maskKey ?? '') + '|' + (keys.frameKey ?? '')
    if (specPending === sig) return
    specPending = sig
    const captured = v
    buildSpec(p, captured.bgId, captured.typoId, captured.canvasId)
      .then((next) => {
        if (destroyed || loading || view !== captured) return
        spec = next
        specKeys = keys
        scheduleDraw()
      })
      .catch((err: unknown) => {
        console.error(err)
      })
      .finally(() => {
        if (specPending === sig) specPending = null
      })
  }

  function drawSnapGuides(): void {
    if ((snapX === null && snapY === null) || !lay) return
    const lw = Math.max(1, Math.round(lay.sx))
    const off = lw % 2 ? 0.5 : 0
    const top = Math.round(lay.oy * lay.sy) + off
    const bottom = Math.round((lay.oy + lay.H * lay.vs) * lay.sy) + off
    const left = Math.round(lay.ox * lay.sx) + off
    const right = Math.round((lay.ox + lay.W * lay.vs) * lay.sx) + off
    ctx.save()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.strokeStyle = theme.accent
    ctx.lineWidth = lw
    // 캔버스 가장자리에 붙은 선은 테두리 바로 안쪽에 보이게
    if (snapX !== null) {
      const sx = Math.min(Math.max(snapX, 1 / lay.vs), lay.W - 1 / lay.vs)
      const x = Math.round((lay.ox + sx * lay.vs) * lay.sx) + off
      ctx.beginPath()
      ctx.moveTo(x, top)
      ctx.lineTo(x, bottom)
      ctx.stroke()
    }
    if (snapY !== null) {
      const sy = Math.min(Math.max(snapY, 1 / lay.vs), lay.H - 1 / lay.vs)
      const y = Math.round((lay.oy + sy * lay.vs) * lay.sy) + off
      ctx.beginPath()
      ctx.moveTo(left, y)
      ctx.lineTo(right, y)
      ctx.stroke()
    }
    ctx.restore()
  }

  /**
   * 스냅: 상자 기준점들(anchors, 출력 px) 중 캔버스 가장자리·중앙선(targets)에 가장 가까운 것.
   * 화면 SNAP_PX 이내면 { delta: 옮길 거리, line: 붙은 선 } 을 돌려준다.
   */
  function nearestSnap(
    anchors: number[],
    targets: number[],
    vs: number
  ): { delta: number; line: number } | null {
    let best: { delta: number; line: number } | null = null
    for (const a of anchors) {
      for (const t of targets) {
        const delta = t - a
        if (Math.abs(delta) * vs > SNAP_PX) continue
        if (!best || Math.abs(delta) < Math.abs(best.delta)) best = { delta, line: t }
      }
    }
    return best
  }

  function drawGuides(): void {
    if (!lay) return
    const msgs: string[] = []
    if (!hasBg()) msgs.push(MSG_BG)
    if (!hasTypo() && mode !== 'censor') msgs.push(MSG_TYPO)
    if (!msgs.length) return
    const cx = lay.ox + (lay.W * lay.vs) / 2
    const cy = lay.oy + (lay.H * lay.vs) / 2
    const lineH = 22
    ctx.save()
    ctx.setTransform(lay.sx, 0, 0, lay.sy, 0, 0)
    ctx.font = HINT_FONT
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = theme.muted
    msgs.forEach((msg, i) => {
      const y = cy + (i - (msgs.length - 1) / 2) * lineH
      ctx.fillText(msg, cx, y)
    })
    ctx.restore()
  }

  function handlePoints(r: ReturnType<typeof coverRect>): {
    a: Point
    b: Point
    pts: Record<HandleKey, [number, number]>
  } {
    const a = outToCss({ x: r.x, y: r.y })
    const b = outToCss({ x: r.x + r.w, y: r.y + r.h })
    const mx = (a.x + b.x) / 2
    const my = (a.y + b.y) / 2
    return {
      a,
      b,
      pts: {
        nw: [a.x, a.y],
        ne: [b.x, a.y],
        sw: [a.x, b.y],
        se: [b.x, b.y],
        n: [mx, a.y],
        s: [mx, b.y],
        w: [a.x, my],
        e: [b.x, my]
      }
    }
  }

  function drawTypoOverlay(p: CoverProject, v: View, m: Measure): void {
    if (!lay) return
    // 같은 언어의 다른 레이어: 눌러서 고를 수 있게 옅은 점선 테두리
    const others = otherLayers(p)
    if (others.length) {
      ctx.save()
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.lineWidth = Math.max(1, Math.round(m.sx))
      ctx.strokeStyle = theme.accent
      ctx.globalAlpha = 0.55
      ctx.setLineDash([4 * m.sx, 3 * m.sx])
      for (const o of others) {
        const { a, b } = handlePoints(o.rect)
        ctx.strokeRect(
          Math.round(a.x * m.sx) + 0.5,
          Math.round(a.y * m.sy) + 0.5,
          Math.round((b.x - a.x) * m.sx),
          Math.round((b.y - a.y) * m.sy)
        )
      }
      ctx.restore()
    }
    const r = currentTypoRect(p, v)
    const { a, b, pts } = handlePoints(r)
    const lw = Math.max(1, Math.round(m.sx))
    const off = lw % 2 ? 0.5 : 0
    const x0 = Math.round(a.x * m.sx) + off
    const y0 = Math.round(a.y * m.sy) + off
    const x1 = Math.round(b.x * m.sx) + off
    const y1 = Math.round(b.y * m.sy) + off
    ctx.save()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.lineWidth = lw
    ctx.strokeStyle = theme.accent
    ctx.strokeRect(x0, y0, x1 - x0, y1 - y0)
    const hs = Math.max(2, Math.round(HANDLE * m.sx))
    for (const key of HANDLE_KEYS) {
      const hx = Math.round(pts[key][0] * m.sx) + off
      const hy = Math.round(pts[key][1] * m.sy) + off
      const left = Math.round(hx - hs / 2)
      const top = Math.round(hy - hs / 2)
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(left, top, hs, hs)
      ctx.strokeRect(left + lw / 2, top + lw / 2, hs - lw, hs - lw)
    }
    ctx.restore()
  }

  function drawBrushCursor(m: Measure): void {
    if (!hover || !lay) return
    const rCss = Math.max(0.5, (brush.size * lay.vs) / 2)
    const cx = hover.x * m.sx
    const cy = hover.y * m.sy
    const r = rCss * m.sx
    const lw = Math.max(1, Math.round(m.sx))
    ctx.save()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.lineWidth = lw
    ctx.strokeStyle = '#000000'
    ctx.beginPath()
    ctx.arc(cx, cy, r + lw, 0, Math.PI * 2)
    ctx.stroke()
    ctx.strokeStyle = '#ffffff'
    ctx.beginPath()
    ctx.arc(cx, cy, Math.max(0.5, r), 0, Math.PI * 2)
    ctx.stroke()
    ctx.restore()
  }

  // ---------- 판정 ----------

  function hitTypo(r: ReturnType<typeof coverRect>, pc: Point): HandleKey | 'move' | null {
    const { a, b, pts } = handlePoints(r)
    for (const key of HANDLE_KEYS) {
      const [cx, cy] = pts[key]
      if (Math.abs(pc.x - cx) <= HANDLE_HIT && Math.abs(pc.y - cy) <= HANDLE_HIT) return key
    }
    if (pc.x >= a.x && pc.x <= b.x && pc.y >= a.y && pc.y <= b.y) return 'move'
    return null
  }

  function setCursor(c: string): void {
    if (canvas.style.cursor !== c) canvas.style.cursor = c
  }

  function updateCursor(e: ClientPoint | null): void {
    if (mode === 'censor') {
      setCursor(hasBg() ? 'none' : 'default')
      return
    }
    if (drag) {
      if (drag.kind === 'pan') setCursor('grabbing')
      else if (drag.kind === 'move') setCursor('move')
      else if (drag.kind === 'edge' || drag.kind === 'resize') {
        setCursor(HANDLE_CURSOR[drag.handle])
      } else setCursor('default')
      return
    }
    if (mode === 'pan') {
      setCursor(hasBg() ? 'grab' : 'default')
      return
    }
    const p = project()
    if (!e || !p || !view || !hasTypo() || !lay) {
      setCursor('default')
      return
    }
    const hit = hitTypo(currentTypoRect(p, view), clientToCss(e))
    setCursor(hit === 'move' ? 'move' : hit ? HANDLE_CURSOR[hit] : 'default')
  }

  // ---------- 검열 순서 큐 ----------

  function enqueue<T>(fn: () => T | Promise<T>): Promise<T | undefined> {
    const run = strokeQ.then(fn)
    strokeQ = run.then(
      () => undefined,
      () => undefined
    )
    return run.catch((err: unknown) => {
      console.error(err)
      return undefined
    })
  }

  async function ensureOpen(p: CoverProject | null, bgId: string): Promise<boolean> {
    if (!p || !bgId || destroyed) return false
    if (censor.getMaskCanvas(bgId)) return true
    await censor.openMask(p, bgId)
    scheduleDraw()
    emitHistory(bgId)
    return !!censor.getMaskCanvas(bgId)
  }

  function emitHistory(bgId: string | null): void {
    if (destroyed || !onHistory) return
    if (!bgId) {
      onHistory({ canUndo: false, canRedo: false })
      return
    }
    onHistory({ canUndo: censor.canUndo(bgId), canRedo: censor.canRedo(bgId) })
  }

  function scheduleCommit(
    p: CoverProject,
    bgId: string,
    silent: boolean
  ): Promise<CommitResult | null> {
    const run = commitQ.then(async (): Promise<CommitResult | null> => {
      if (!findBg(p, bgId)) return null
      const res = await censor.commit(p, bgId)
      if (res.oldKey && res.oldKey !== res.newKey) forgetBitmap(res.oldKey)
      if (!destroyed) {
        scheduleDraw()
        if (view?.bgId === bgId) emitHistory(bgId)
        if (!silent) notify('mask')
      }
      return res
    })
    commitQ = run.then(
      () => undefined,
      (err: unknown) => {
        console.error(err)
      }
    )
    return run.catch((err: unknown) => {
      console.error(err)
      return null
    })
  }

  async function maskOp(fn: (bgId: string) => boolean): Promise<boolean> {
    if (destroyed || !view || !view.bgId || !view.bgItem) return false
    if (drag && drag.kind === 'stroke') return false
    const p = project()
    const bgId = view.bgId
    if (!p) return false
    const changed = await enqueue(async () => {
      if (!(await ensureOpen(p, bgId))) return false
      const ch = !!fn(bgId)
      scheduleDraw()
      emitHistory(bgId)
      return ch
    })
    if (changed) await scheduleCommit(p, bgId, false)
    return !!changed
  }

  function brushForBg(v: View): EditorBrush {
    const cs = coverScale(v)
    return {
      size: Math.max(0.5, brush.size / cs),
      hardness: clamp(brush.hardness, 0, 1),
      opacity: clamp(brush.opacity, 0, 1),
      color: brush.color,
      erase: !!brush.erase
    }
  }

  function queueStrokePoints(e: PointerEvent): void {
    if (!drag || drag.kind !== 'stroke' || !lay || !view) return
    const p = project()
    if (!p || !view.bgItem) return
    const cr = bgCover(p, view)
    const list = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : []
    const evs: ClientPoint[] = list.length ? list : [e]
    const item = view.bgItem
    const bgId = drag.ids.bgId
    if (!bgId) return
    for (const ev of evs) {
      const q = outToBg(cssToOut(clientToCss(ev)), cr, item)
      enqueue(() => {
        censor.strokeTo(bgId, q.x, q.y)
        scheduleDraw()
      })
    }
    drag.changed = true
  }

  // ---------- 드래그 ----------

  function onPointerDown(e: PointerEvent): void {
    if (e.button !== 0 || !view || drag || loading || destroyed) return
    const p = project()
    if (!p || !updateLayout()) return
    canvas.focus({ preventScroll: true })

    const pc = clientToCss(e)
    const po = cssToOut(pc)
    let ids = { canvasId: view.canvasId, bgId: view.bgId, typoId: view.typoId }
    let next: Drag | null = null

    if (mode === 'typo') {
      if (!hasTypo()) return
      let hit = hitTypo(currentTypoRect(p, view), pc)
      if (!hit) {
        // 같은 언어의 다른 레이어(문구·타이포)를 누르면 그것으로 바꿔 바로 끈다
        const picked = otherLayers(p)
          .reverse()
          .find((o) => {
            const { a, b } = handlePoints(o.rect)
            return pc.x >= a.x && pc.x <= b.x && pc.y >= a.y && pc.y <= b.y
          })
        const layer = picked && spec?.layers?.find((l) => l.id === picked.id)
        if (!layer || !spec) return
        view = { ...view, typoId: layer.id, typoItem: layer.item }
        spec = {
          ...spec,
          typo: { image: layer.image, placement: getPlacement(p, layer.item, lay!.def) },
          activeId: layer.id
        }
        ids = { ...ids, typoId: layer.id }
        hit = 'move'
        opts.onSelectLayer?.(layer.id)
      }
      const pl = currentPlacement(p, view)
      const r = currentTypoRect(p, view)
      const left = r.x
      const top = r.y
      const right = r.x + r.w
      const bottom = r.y + r.h
      if (hit === 'move') {
        next = { kind: 'move', start: po, pl0: pl, pointerId: e.pointerId, ids, changed: false }
      } else if (hit.length === 2) {
        const west = hit.includes('w')
        const north = hit.includes('n')
        const c0 = { x: west ? left : right, y: north ? top : bottom }
        const fixed = { x: west ? right : left, y: north ? bottom : top }
        const d = { x: c0.x - fixed.x, y: c0.y - fixed.y }
        const dd = d.x * d.x + d.y * d.y
        if (!(dd > 0) || !(r.w > 0) || !(r.h > 0)) return
        next = {
          kind: 'resize',
          handle: hit,
          fixed,
          d,
          dd,
          w0: r.w,
          h0: r.h,
          grab: { x: po.x - c0.x, y: po.y - c0.y },
          pointerId: e.pointerId,
          ids,
          changed: false
        }
      } else {
        const hc = {
          x: hit === 'w' ? left : hit === 'e' ? right : (left + right) / 2,
          y: hit === 'n' ? top : hit === 's' ? bottom : (top + bottom) / 2
        }
        next = {
          kind: 'edge',
          handle: hit,
          pl0: pl,
          left,
          right,
          top,
          bottom,
          grab: { x: po.x - hc.x, y: po.y - hc.y },
          pointerId: e.pointerId,
          ids,
          changed: false
        }
      }
    } else if (mode === 'pan') {
      if (!hasBg()) return
      next = {
        kind: 'pan',
        start: po,
        pan0: getPan(p, view.bgId!, view.canvasId),
        pointerId: e.pointerId,
        ids,
        changed: false
      }
    } else if (mode === 'censor') {
      if (!hasBg() || !view.bgId) return
      const bgId = view.bgId
      const b = brushForBg(view)
      next = { kind: 'stroke', project: p, pointerId: e.pointerId, ids, changed: false }
      enqueue(async () => {
        if (!(await ensureOpen(p, bgId))) return
        censor.beginStroke(bgId, b)
      })
      hover = pc
    }

    if (!next) return
    drag = next
    try {
      canvas.setPointerCapture(e.pointerId)
    } catch {
      /* 캡처를 못 해도 포인터 이동은 계속 받는다 */
    }
    e.preventDefault()
    if (drag.kind === 'stroke') queueStrokePoints(e)
    updateCursor(e)
  }

  function applyDrag(e: PointerEvent): void {
    if (!drag) return
    const p = project()
    if (!p || !lay || !view) return
    if (drag.kind === 'stroke') {
      hover = clientToCss(e)
      queueStrokePoints(e)
      scheduleDraw()
      return
    }

    const po = cssToOut(clientToCss(e))
    const { canvasId, bgId, typoId } = drag.ids
    const W = lay.W
    const H = lay.H
    const minW = MIN_W_RATIO * W
    const minH = MIN_H_RATIO * H

    if (drag.kind === 'move') {
      if (!typoId) return
      const { pl0, start } = drag
      let cx = clamp(pl0.cx + (po.x - start.x) / W, Math.min(0, pl0.cx), Math.max(1, pl0.cx))
      let cy = clamp(pl0.cy + (po.y - start.y) / H, Math.min(0, pl0.cy), Math.max(1, pl0.cy))
      snapX = null
      snapY = null
      if (!e.altKey) {
        // 상자 왼쪽·가운데·오른쪽 → 캔버스 왼쪽 끝·중앙·오른쪽 끝 (세로도 같게)
        const bw = pl0.w * W
        const bh = pl0.h * H
        const sxr = nearestSnap([cx * W - bw / 2, cx * W, cx * W + bw / 2], [0, W / 2, W], lay.vs)
        if (sxr) {
          cx += sxr.delta / W
          snapX = sxr.line
        }
        const syr = nearestSnap([cy * H - bh / 2, cy * H, cy * H + bh / 2], [0, H / 2, H], lay.vs)
        if (syr) {
          cy += syr.delta / H
          snapY = syr.line
        }
      }
      setPlacement(p, typoId, canvasId, { cx, cy, w: pl0.w, h: pl0.h })
    } else if (drag.kind === 'resize') {
      if (!typoId) return
      const { fixed, d, dd, w0, h0, grab } = drag
      const qx = po.x - grab.x - fixed.x
      const qy = po.y - grab.y - fixed.y
      const t = (qx * d.x + qy * d.y) / dd
      let k = Math.max(t, minW / w0, minH / h0)
      snapX = null
      snapY = null
      if (!e.altKey) {
        // 움직이는 모서리의 가로 변 또는 세로 변 중 더 가까운 쪽을 선에 붙이고 비율은 유지
        const mx = fixed.x + d.x * k
        const my = fixed.y + d.y * k
        const sxr = Math.abs(d.x) > 1e-6 ? nearestSnap([mx], [0, W / 2, W], lay.vs) : null
        const syr = Math.abs(d.y) > 1e-6 ? nearestSnap([my], [0, H / 2, H], lay.vs) : null
        const useX = sxr && (!syr || Math.abs(sxr.delta) <= Math.abs(syr.delta))
        if (useX && sxr) {
          const kk = (sxr.line - fixed.x) / d.x
          if (kk >= minW / w0 && kk >= minH / h0) {
            k = kk
            snapX = sxr.line
          }
        } else if (syr) {
          const kk = (syr.line - fixed.y) / d.y
          if (kk >= minW / w0 && kk >= minH / h0) {
            k = kk
            snapY = syr.line
          }
        }
      }
      const cx = fixed.x + (d.x * k) / 2
      const cy = fixed.y + (d.y * k) / 2
      setPlacement(p, typoId, canvasId, {
        cx: cx / W,
        cy: cy / H,
        w: (w0 * k) / W,
        h: (h0 * k) / H
      })
    } else if (drag.kind === 'edge') {
      if (!typoId) return
      const { handle, pl0, left, right, top, bottom, grab } = drag
      let x = po.x - grab.x
      let y = po.y - grab.y
      snapX = null
      snapY = null
      if (!e.altKey) {
        if (handle === 'e' || handle === 'w') {
          const s = nearestSnap([x], [0, W / 2, W], lay.vs)
          if (s) {
            x = s.line
            snapX = s.line
          }
        } else {
          const s = nearestSnap([y], [0, H / 2, H], lay.vs)
          if (s) {
            y = s.line
            snapY = s.line
          }
        }
      }
      const next = { cx: pl0.cx, cy: pl0.cy, w: pl0.w, h: pl0.h }
      if (handle === 'e' || handle === 'w') {
        const nw = handle === 'e' ? Math.max(x - left, minW) : Math.max(right - x, minW)
        next.w = nw / W
        next.cx = (handle === 'e' ? left + nw / 2 : right - nw / 2) / W
      } else {
        const nh = handle === 's' ? Math.max(y - top, minH) : Math.max(bottom - y, minH)
        next.h = nh / H
        next.cy = (handle === 's' ? top + nh / 2 : bottom - nh / 2) / H
      }
      setPlacement(p, typoId, canvasId, next)
    } else if (drag.kind === 'pan') {
      if (!bgId || !view.bgItem) return
      const item = view.bgItem
      const cr = coverRect(item.width, item.height, W, H, drag.pan0)
      const overX = cr.w - W
      const overY = cr.h - H
      let px = drag.pan0.px
      let py = drag.pan0.py
      if (overX > 0.5) px = clamp(drag.pan0.px - (po.x - drag.start.x) / overX, 0, 1)
      if (overY > 0.5) py = clamp(drag.pan0.py - (po.y - drag.start.y) / overY, 0, 1)
      setPan(p, bgId, canvasId, { px, py })
    }

    drag.changed = true
    scheduleDraw()
  }

  function onPointerMove(e: PointerEvent): void {
    if (drag) {
      if (e.pointerId === drag.pointerId) applyDrag(e)
      return
    }
    if (!lay) return
    if (mode === 'censor') {
      hover = hasBg() ? clientToCss(e) : null
      scheduleDraw()
    }
    updateCursor(e)
  }

  function endDrag(e: PointerEvent | null, silent = false): void {
    if (!drag) return
    if (e && e.pointerId !== drag.pointerId) return
    const d = drag
    drag = null
    snapX = null
    snapY = null
    try {
      if (canvas.hasPointerCapture(d.pointerId)) canvas.releasePointerCapture(d.pointerId)
    } catch {
      /* 이미 해제됐다 */
    }

    if (d.kind === 'stroke') {
      const bgId = d.ids.bgId
      const p = d.project
      if (bgId) {
        void enqueue(async () => {
          let changed = false
          try {
            changed = !!censor.endStroke(bgId)
          } finally {
            scheduleDraw()
          }
          if (changed) void scheduleCommit(p, bgId, silent)
        })
      }
      if (e && e.type === 'pointercancel') hover = null
      draw()
      updateCursor(null)
      return
    }

    draw()
    updateCursor(e && e.type !== 'lostpointercapture' ? e : null)
    if (d.changed && !silent) {
      if (d.kind === 'pan') notify('pan')
      else notify('placement')
    }
  }

  function onPointerUp(e: PointerEvent): void {
    endDrag(e)
  }

  function onLostCapture(e: PointerEvent): void {
    endDrag(e)
  }

  function onPointerLeave(): void {
    if (mode === 'censor') {
      if (!drag) {
        hover = null
        scheduleDraw()
      }
      return
    }
    if (!drag) setCursor(mode === 'pan' && hasBg() ? 'grab' : 'default')
  }

  // ---------- 키보드 ----------

  function undoCurrent(): Promise<boolean> {
    return maskOp((id) => censor.undo(id))
  }

  function redoCurrent(): Promise<boolean> {
    return maskOp((id) => censor.redo(id))
  }

  function clearCurrent(): Promise<boolean> {
    return maskOp((id) => censor.clear(id))
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (
      e.key === 'Alt' &&
      drag &&
      (drag.kind === 'move' || drag.kind === 'resize' || drag.kind === 'edge')
    ) {
      snapX = null
      snapY = null
      draw()
      return
    }

    if (mode === 'censor') {
      const mod = e.ctrlKey || e.metaKey
      if (!mod || e.altKey) return
      const key = e.key.toLowerCase()
      const code = e.code
      const isZ = code === 'KeyZ' || key === 'z'
      const isY = code === 'KeyY' || key === 'y'
      if (!isZ && !isY) return
      e.preventDefault()
      if (isZ && !e.shiftKey) void undoCurrent()
      else void redoCurrent()
      return
    }

    if (mode !== 'typo') return
    const dir = ARROWS[e.key]
    if (!dir) return
    if (e.altKey || e.ctrlKey || e.metaKey) return
    e.preventDefault()
    if (drag || !hasTypo() || !view || !view.typoId) return
    const p = project()
    if (!p || !updateLayout()) return
    const step = e.shiftKey ? 10 : 1
    const pl = currentPlacement(p, view)
    setPlacement(p, view.typoId, view.canvasId, {
      cx: pl.cx + (dir[0] * step) / lay!.W,
      cy: pl.cy + (dir[1] * step) / lay!.H,
      w: pl.w,
      h: pl.h
    })
    snapX = null
    snapY = null
    draw()
    notify('nudge')
  }

  // ---------- 로드 ----------

  async function load(): Promise<void> {
    const seq = ++loadSeq
    loading = true
    const t = target
    if (!t) {
      loading = false
      draw()
      return
    }

    const p = project()
    if (!p) {
      view = null
      spec = null
      loading = false
      draw()
      return
    }

    const bgItem = findBg(p, t.bgId)
    const typoItem = findTypo(p, t.typoId)

    // buildSpec 이 끝날 때까지 이전 view/spec 을 그대로 두어 로딩 중 깜빡임을 막는다.
    let nextSpec: CoverDrawSpec | null = null
    try {
      nextSpec = await buildSpec(p, bgItem?.id ?? null, typoItem?.id ?? null, t.canvasId)
    } catch (err) {
      console.error(err)
    }
    if (seq !== loadSeq || destroyed) return

    view = {
      canvasId: t.canvasId,
      bgId: bgItem?.id ?? null,
      typoId: typoItem?.id ?? null,
      bgItem,
      typoItem
    }
    spec = nextSpec
    specKeys = specKeysOf(p, view)
    specPending = null
    loading = false

    if (drag) {
      const ids = drag.ids
      const valid =
        ids.canvasId === view.canvasId &&
        (drag.kind === 'pan' || drag.kind === 'stroke'
          ? ids.bgId === view.bgId && hasBg()
          : ids.typoId === view.typoId && hasTypo())
      if (!valid) endDrag(null, true)
    }

    if (mode === 'censor' && view.bgId) openCurrentMask()
    else emitHistory(null)
    draw()
    updateCursor(null)
  }

  function openCurrentMask(): void {
    const v = view
    if (!v || !v.bgId || !v.bgItem || destroyed) return
    const bgId = v.bgId
    const p = project()
    if (!p) return
    void enqueue(async () => {
      const ok = await ensureOpen(p, bgId)
      if (!ok) return
      if (!destroyed && view === v) {
        scheduleDraw()
        emitHistory(bgId)
      }
    })
  }

  // ---------- 크기 · 테마 추적 ----------

  const ro = new ResizeObserver(() => draw())
  ro.observe(container)

  function onDprChange(): void {
    watchDpr()
    draw()
  }

  function watchDpr(): void {
    if (dprQuery) dprQuery.removeEventListener('change', onDprChange)
    if (destroyed || !window.matchMedia) return
    dprQuery = window.matchMedia('(resolution: ' + (window.devicePixelRatio || 1) + 'dppx)')
    dprQuery.addEventListener('change', onDprChange)
  }
  watchDpr()

  const themeObserver = new MutationObserver(() => {
    theme = readTheme()
    draw()
  })
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class', 'data-theme', 'style']
  })

  canvas.addEventListener('pointerdown', onPointerDown)
  canvas.addEventListener('pointermove', onPointerMove)
  canvas.addEventListener('pointerup', onPointerUp)
  canvas.addEventListener('pointercancel', onPointerUp)
  canvas.addEventListener('lostpointercapture', onLostCapture)
  canvas.addEventListener('pointerleave', onPointerLeave)
  canvas.addEventListener('keydown', onKeyDown)

  draw()

  return {
    async show(t): Promise<void> {
      if (destroyed) return
      const p = project()
      const cid = getCoverCanvas(t.canvasId)
        ? t.canvasId
        : (p?.selection.canvasId ?? ('1x1' as CoverCanvasId))
      // 편집기에서 레이어를 눌러 바꾼 경우엔 같은 대상이 다시 오므로 끌기를 이어 간다
      const same =
        drag &&
        drag.ids.canvasId === cid &&
        drag.ids.bgId === (t.bgId ?? null) &&
        drag.ids.typoId === (t.typoId ?? null)
      if (!same) endDrag(null)
      target = { canvasId: cid, bgId: t.bgId ?? null, typoId: t.typoId ?? null }
      if (!same) {
        snapX = null
        snapY = null
      }
      hover = null
      scheduleDraw()
      await load()
    },
    setMode(next: CoverMode): void {
      if (!MODES.includes(next) || next === mode) return
      endDrag(null)
      mode = next
      if (mode !== 'censor') hover = null
      else openCurrentMask()
      draw()
      updateCursor(null)
      if (mode !== 'censor') emitHistory(null)
    },
    setBrush(next: EditorBrush): void {
      brush.size = Math.max(1, finite(next.size, brush.size))
      brush.hardness = clamp(finite(next.hardness, brush.hardness), 0, 1)
      brush.opacity = clamp(finite(next.opacity, brush.opacity), 0, 1)
      if (typeof next.color === 'string' && /^#[0-9a-f]{6}$/i.test(next.color)) {
        brush.color = next.color.toLowerCase()
      }
      brush.erase = !!next.erase
      if (mode === 'censor') scheduleDraw()
    },
    undo(): Promise<boolean> {
      return undoCurrent()
    },
    redo(): Promise<boolean> {
      return redoCurrent()
    },
    clearMask(): Promise<boolean> {
      return clearCurrent()
    },
    async refresh(): Promise<void> {
      if (destroyed) return
      if (!target) {
        draw()
        return
      }
      await load()
    },
    destroy(): void {
      if (destroyed) return
      endDrag(null, true)
      destroyed = true
      loading = false
      loadSeq++
      if (raf) cancelAnimationFrame(raf)
      raf = 0
      for (const e of scaled.values()) e.bmp?.close()
      scaled.clear()
      ro.disconnect()
      themeObserver.disconnect()
      if (dprQuery) dprQuery.removeEventListener('change', onDprChange)
      dprQuery = null
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerup', onPointerUp)
      canvas.removeEventListener('pointercancel', onPointerUp)
      canvas.removeEventListener('lostpointercapture', onLostCapture)
      canvas.removeEventListener('pointerleave', onPointerLeave)
      canvas.removeEventListener('keydown', onKeyDown)
      canvas.remove()
      if (container.style.position !== prevPosition) container.style.position = prevPosition
      view = null
      spec = null
      target = null
      hover = null
    }
  }
}
