/**
 * 표지 탭 공용 계약. 배경 N장 × 타이포 PNG M장 × 캔버스 4종을 한 번에 출력한다.
 * 원본: cover-batch (SPEC.md v3). 순수 함수만 둔다 (main·renderer·테스트 공용).
 */

export type CoverCanvasId = '1x1' | '2x3' | '3x4' | '4x5'

export interface CoverCanvas {
  id: CoverCanvasId
  /** 플랫폼 이름 (폴더명에 들어감) */
  label: string
  w: number
  h: number
  ratio: string
}

export const COVER_CANVASES: readonly CoverCanvas[] = Object.freeze([
  { id: '1x1', label: '바베', w: 1200, h: 1200, ratio: '1:1' },
  { id: '2x3', label: '에덴', w: 800, h: 1200, ratio: '2:3' },
  { id: '3x4', label: '젠잇', w: 900, h: 1200, ratio: '3:4' },
  { id: '4x5', label: '알플', w: 1200, h: 1500, ratio: '4:5' }
])

export function getCoverCanvas(id: string | null | undefined): CoverCanvas | null {
  return COVER_CANVASES.find((c) => c.id === id) ?? null
}

export type CoverKind = 'backgrounds' | 'typos'

export interface CoverItem {
  id: string
  name: string
  /** blob 저장소 키 (main userData/cover/blobs) */
  blobKey: string
  /** 원본 픽셀 크기 */
  width: number
  height: number
  /** 배경 전용: 검열 마스크 PNG (배경 원본과 같은 크기, 투명 바탕) */
  maskKey?: string | null
  /**
   * 타이포 전용: 이 언어에 딸린 문구 이미지 (업데이트 이력 등).
   * 타이포와 함께 그려지고, 위치는 문구마다·캔버스마다 따로 저장된다.
   */
  extras?: CoverItem[]
}

export type CoverFrameStyle = 'solid' | 'double' | 'dashed' | 'dotted' | 'corners' | 'image'
export const COVER_FRAME_STYLES: readonly CoverFrameStyle[] = [
  'solid',
  'double',
  'dashed',
  'dotted',
  'corners',
  'image'
]

export interface CoverFrame {
  enabled: boolean
  style: CoverFrameStyle
  color: string
  /** null 이 아니면 (0,0)→(W,H) 선형 그라데이션 color→color2 */
  color2: string | null
  width: number
  inset: number
  radius: number
  gap: number
  cornerLen: number
  /** 0~1 */
  opacity: number
}

/** 정규화 좌표: cx·cy 중심, w 는 캔버스 너비 대비, h 는 캔버스 높이 대비 */
export interface CoverPlacement {
  cx: number
  cy: number
  w: number
  h: number
}

/** 0~1. 넘치는 축에서 어디를 보여 줄지 */
export interface CoverPan {
  px: number
  py: number
}

export interface CoverWebpFrame {
  bgId: string
  durationMs: number
}

export interface CoverWebpSettings {
  frames: CoverWebpFrame[]
  /** 0~1 */
  quality: number
}

export interface CoverSelection {
  canvasId: CoverCanvasId
  bgId: string | null
  typoId: string | null
  /** 편집 중인 문구 (null = 타이포 본체) */
  layerId: string | null
}

export interface CoverProject {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  backgrounds: CoverItem[]
  typos: CoverItem[]
  frame: CoverFrame
  frameImages: Partial<Record<CoverCanvasId, CoverItem>>
  /** '<typoId>@<canvasId>' */
  placements: Record<string, CoverPlacement>
  /** '<bgId>@<canvasId>' */
  pans: Record<string, CoverPan>
  selection: CoverSelection
  webp: CoverWebpSettings
}

export interface CoverProjectSummary {
  id: string
  name: string
  updatedAt: number
  backgrounds: number
  typos: number
}

/** 표지 기록: 표지에 한 번이라도 넣었던 그림·타이포·문구. 작품에서 빼도 남는다 */
export type CoverArchiveKind = 'background' | 'typo' | 'phrase'

export interface CoverArchiveItem {
  /** 기록 하나의 식별자 (같은 그림도 배경·타이포로 따로 기록) */
  id: string
  /** 이미지 내용 해시 (같은 그림은 하나로 묶인다) */
  hash: string
  kind: CoverArchiveKind
  name: string
  width: number
  height: number
  /** 보관본 파일 경로 (끌어 놓기·가져오기에 쓴다) */
  path: string
  /** 배경의 검열 마스크 보관본 */
  maskPath: string | null
  /** 썸네일 webp base64 */
  thumb: string
  /** 마지막으로 쓴 작품 */
  projectId: string
  projectName: string
  addedAt: number
  usedAt: number
  /** 이 그림을 가리켰던 작품 속 blob 키들 (지금 작품에 들어 있는지 표시용) */
  blobKeys: string[]
}

export function defaultCoverFrame(): CoverFrame {
  return {
    enabled: false,
    style: 'solid',
    color: '#e0457b',
    color2: null,
    width: 3,
    inset: 10,
    radius: 0,
    gap: 4,
    cornerLen: 80,
    opacity: 1
  }
}

export function defaultWebpSettings(): CoverWebpSettings {
  return { frames: [], quality: 0.8 }
}

export function newCoverProject(id: string, name: string, now = Date.now()): CoverProject {
  return {
    id,
    name,
    createdAt: now,
    updatedAt: now,
    backgrounds: [],
    typos: [],
    frame: defaultCoverFrame(),
    frameImages: {},
    placements: {},
    pans: {},
    selection: { canvasId: '1x1', bgId: null, typoId: null, layerId: null },
    webp: defaultWebpSettings()
  }
}

/** blob·프로젝트 키는 파일 이름이 되므로 경로 문자를 절대 허용하지 않는다 */
export const COVER_KEY_RE = /^[A-Za-z0-9_-]{8,80}$/

export function isCoverKey(v: unknown): v is string {
  return typeof v === 'string' && COVER_KEY_RE.test(v)
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

function normItem(v: unknown, withMask: boolean): CoverItem | null {
  if (!isObj(v)) return null
  if (typeof v.id !== 'string' || !isCoverKey(v.blobKey)) return null
  if (!isNum(v.width) || !isNum(v.height) || v.width <= 0 || v.height <= 0) return null
  const item: CoverItem = {
    id: v.id,
    name: typeof v.name === 'string' ? v.name : '',
    blobKey: v.blobKey,
    width: v.width,
    height: v.height
  }
  if (withMask) item.maskKey = isCoverKey(v.maskKey) ? v.maskKey : null
  return item
}

function normTypo(v: unknown): CoverItem | null {
  const item = normItem(v, false)
  if (!item || !isObj(v)) return item
  const extras = (Array.isArray(v.extras) ? v.extras : [])
    .map((e) => normItem(e, false))
    .filter((e): e is CoverItem => !!e)
  if (extras.length) item.extras = extras
  return item
}

function normFrame(v: unknown): CoverFrame {
  const def = defaultCoverFrame()
  const s = isObj(v) ? v : {}
  return {
    enabled: Boolean(s.enabled),
    style: COVER_FRAME_STYLES.includes(s.style as CoverFrameStyle)
      ? (s.style as CoverFrameStyle)
      : def.style,
    color: typeof s.color === 'string' ? s.color : def.color,
    color2: typeof s.color2 === 'string' ? s.color2 : null,
    width: isNum(s.width) ? s.width : def.width,
    inset: isNum(s.inset) ? s.inset : def.inset,
    radius: isNum(s.radius) ? s.radius : def.radius,
    gap: isNum(s.gap) ? s.gap : def.gap,
    cornerLen: isNum(s.cornerLen) ? s.cornerLen : def.cornerLen,
    opacity: isNum(s.opacity) ? Math.min(1, Math.max(0, s.opacity)) : def.opacity
  }
}

/** 옛 데이터(h 없음)를 원본 비율 기준 높이로 채운다 */
export function heightFromWidth(
  w: number,
  item: CoverItem | undefined,
  canvas: CoverCanvas
): number {
  const iw = item && item.width > 0 ? item.width : 1
  const ih = item && item.height > 0 ? item.height : 1
  return (w * canvas.w * (ih / iw)) / canvas.h
}

export function clampDuration(ms: number): number {
  return Math.min(16777215, Math.max(10, Math.round(ms)))
}

/** 저장 파일을 읽은 뒤 깨진 값만 기본값으로 고친다 (원본 normalizeProject 와 같은 규칙) */
export function normalizeCoverProject(raw: unknown): CoverProject | null {
  if (!isObj(raw) || !isCoverKey(raw.id)) return null
  const now = Date.now()
  const backgrounds = (Array.isArray(raw.backgrounds) ? raw.backgrounds : [])
    .map((v) => normItem(v, true))
    .filter((v): v is CoverItem => !!v)
  const typos = (Array.isArray(raw.typos) ? raw.typos : [])
    .map((v) => normTypo(v))
    .filter((v): v is CoverItem => !!v)
  const layers = typos.flatMap((t) => [t, ...(t.extras ?? [])])
  const frameImages: CoverProject['frameImages'] = {}
  if (isObj(raw.frameImages)) {
    for (const [cid, v] of Object.entries(raw.frameImages)) {
      const c = getCoverCanvas(cid)
      const it = normItem(v, false)
      if (c && it) frameImages[c.id] = it
    }
  }
  const placements: Record<string, CoverPlacement> = {}
  if (isObj(raw.placements)) {
    for (const [key, v] of Object.entries(raw.placements)) {
      if (!isObj(v) || !isNum(v.cx) || !isNum(v.cy) || !isNum(v.w)) continue
      const at = key.lastIndexOf('@')
      const typo = layers.find((t) => t.id === key.slice(0, at))
      const canvas = getCoverCanvas(key.slice(at + 1))
      if (!typo || !canvas) continue
      placements[key] = {
        cx: v.cx,
        cy: v.cy,
        w: v.w,
        h: isNum(v.h) ? v.h : heightFromWidth(v.w, typo, canvas)
      }
    }
  }
  const pans: Record<string, CoverPan> = {}
  if (isObj(raw.pans)) {
    for (const [key, v] of Object.entries(raw.pans)) {
      if (!isObj(v) || !isNum(v.px) || !isNum(v.py)) continue
      if (!backgrounds.some((b) => key.startsWith(b.id + '@'))) continue
      pans[key] = { px: v.px, py: v.py }
    }
  }
  const sel = isObj(raw.selection) ? raw.selection : {}
  const selTypo = typos.find((t) => t.id === sel.typoId) ?? null
  const webpRaw = isObj(raw.webp) ? raw.webp : {}
  const bgIds = new Set(backgrounds.map((b) => b.id))
  const frames = (Array.isArray(webpRaw.frames) ? webpRaw.frames : [])
    .filter(
      (f): f is { bgId: string; durationMs: number } =>
        isObj(f) && typeof f.bgId === 'string' && bgIds.has(f.bgId) && isNum(f.durationMs)
    )
    .map((f) => ({ bgId: f.bgId, durationMs: clampDuration(f.durationMs) }))
  return {
    id: raw.id,
    name: typeof raw.name === 'string' ? raw.name : '',
    createdAt: isNum(raw.createdAt) ? raw.createdAt : now,
    updatedAt: isNum(raw.updatedAt) ? raw.updatedAt : now,
    backgrounds,
    typos,
    frame: normFrame(raw.frame),
    frameImages,
    placements,
    pans,
    selection: {
      canvasId: getCoverCanvas(sel.canvasId as string)?.id ?? '1x1',
      bgId: backgrounds.some((b) => b.id === sel.bgId) ? (sel.bgId as string) : null,
      typoId: selTypo ? selTypo.id : null,
      layerId:
        selTypo && selTypo.extras?.some((e) => e.id === sel.layerId)
          ? (sel.layerId as string)
          : null
    },
    webp: {
      frames,
      quality: isNum(webpRaw.quality) ? Math.min(1, Math.max(0, webpRaw.quality)) : 0.8
    }
  }
}

/** 프로젝트가 가리키는 모든 blob 키 (삭제·정리용) */
export function coverBlobKeys(p: CoverProject): string[] {
  const keys: string[] = []
  for (const b of p.backgrounds) {
    keys.push(b.blobKey)
    if (b.maskKey) keys.push(b.maskKey)
  }
  for (const t of p.typos) {
    keys.push(t.blobKey)
    for (const e of t.extras ?? []) keys.push(e.blobKey)
  }
  for (const f of Object.values(p.frameImages)) if (f) keys.push(f.blobKey)
  return keys
}

// ───────────── 타이포 + 문구 ─────────────

/** 타이포 본체와 문구를 그리는 순서대로 */
export function typoLayers(typo: CoverItem): CoverItem[] {
  return [typo, ...(typo.extras ?? [])]
}

/** 본체나 문구 번호 → 그 타이포와 해당 이미지 */
export function findLayer(
  p: CoverProject,
  id: string | null | undefined
): { typo: CoverItem; item: CoverItem } | null {
  if (!id) return null
  for (const t of p.typos) {
    if (t.id === id) return { typo: t, item: t }
    const e = t.extras?.find((x) => x.id === id)
    if (e) return { typo: t, item: e }
  }
  return null
}

/** 지금 편집 중인 이미지 번호 (문구를 골랐으면 문구, 아니면 타이포) */
export function activeLayerId(p: CoverProject): string | null {
  const s = p.selection
  const t = p.typos.find((x) => x.id === s.typoId)
  if (!t) return null
  return s.layerId && t.extras?.some((e) => e.id === s.layerId) ? s.layerId : t.id
}

// ───────────── 배치·팬 ─────────────

export function defaultPlacement(
  typo: CoverItem,
  canvas: CoverCanvas,
  extra = false
): CoverPlacement {
  const iw = typo.width > 0 ? typo.width : 1
  const ih = typo.height > 0 ? typo.height : 1
  if (extra) {
    // 문구는 위쪽에 조금 작게 (본체와 겹치지 않게)
    const w = Math.min(0.7, 0.3 * (canvas.h / canvas.w) * (iw / ih))
    const h = heightFromWidth(w, typo, canvas)
    return { cx: 0.5, cy: Math.min(0.5, 0.06 + h / 2), w, h }
  }
  const w = Math.min(0.8, 0.8 * (canvas.h / canvas.w) * (iw / ih))
  return { cx: 0.5, cy: 0.5, w, h: heightFromWidth(w, typo, canvas) }
}

export function getPlacement(
  p: CoverProject,
  typo: CoverItem,
  canvas: CoverCanvas
): CoverPlacement {
  const saved = p.placements[typo.id + '@' + canvas.id]
  if (saved) return { ...saved }
  const extra = p.typos.some((t) => t.extras?.some((e) => e.id === typo.id))
  return defaultPlacement(typo, canvas, extra)
}

export function setPlacement(
  p: CoverProject,
  typoId: string,
  canvasId: CoverCanvasId,
  pl: CoverPlacement
): void {
  p.placements[typoId + '@' + canvasId] = { cx: pl.cx, cy: pl.cy, w: pl.w, h: pl.h }
}

export function resetPlacement(p: CoverProject, typoId: string, canvasId: CoverCanvasId): void {
  delete p.placements[typoId + '@' + canvasId]
}

/**
 * 같은 순번의 레이어(본체끼리, 1번 문구끼리…)를 다른 타이포에서도 같은 자리에 둔다.
 * 중심과 높이를 맞추고 너비는 각 이미지 비율대로 (언어마다 글자 길이가 달라서).
 * 맞춘 타이포 수를 돌려준다.
 */
export function alignLayerAcrossTypos(
  p: CoverProject,
  layerId: string,
  canvasIds: CoverCanvasId[]
): number {
  const found = findLayer(p, layerId)
  if (!found) return 0
  const index = typoLayers(found.typo).indexOf(found.item)
  let count = 0
  for (const t of p.typos) {
    if (t.id === found.typo.id) continue
    const target = typoLayers(t)[index]
    if (!target) continue
    for (const cid of canvasIds) {
      const canvas = getCoverCanvas(cid)
      if (!canvas) continue
      const src = getPlacement(p, found.item, canvas)
      const h = src.h
      const w = (h * canvas.h * (target.width / Math.max(1, target.height))) / canvas.w
      setPlacement(p, target.id, canvas.id, { cx: src.cx, cy: src.cy, w, h })
    }
    count++
  }
  return count
}

export function getPan(p: CoverProject, bgId: string, canvasId: CoverCanvasId): CoverPan {
  const saved = p.pans[bgId + '@' + canvasId]
  return saved ? { ...saved } : { px: 0.5, py: 0.5 }
}

export function setPan(
  p: CoverProject,
  bgId: string,
  canvasId: CoverCanvasId,
  pan: CoverPan
): void {
  p.pans[bgId + '@' + canvasId] = {
    px: Math.min(1, Math.max(0, pan.px)),
    py: Math.min(1, Math.max(0, pan.py))
  }
}

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** 배경 cover 맞춤 (출력 픽셀 기준) */
export function coverRect(iw: number, ih: number, W: number, H: number, pan: CoverPan): Rect {
  const s = Math.max(W / iw, H / ih)
  const w = iw * s
  const h = ih * s
  return { x: -(w - W) * pan.px, y: -(h - H) * pan.py, w, h }
}

/** 타이포 상자 (출력 픽셀 기준) */
export function typoRect(W: number, H: number, pl: CoverPlacement): Rect {
  const w = pl.w * W
  const h = pl.h * H
  return { x: pl.cx * W - w / 2, y: pl.cy * H - h / 2, w, h }
}

export function moveInList(arr: CoverItem[], id: string, delta: number): boolean {
  const i = arr.findIndex((v) => v.id === id)
  const to = i + Math.sign(delta)
  if (i < 0 || to < 0 || to >= arr.length || to === i) return false
  const [it] = arr.splice(i, 1)
  arr.splice(to, 0, it)
  return true
}

// ───────────── 출력 이름 ─────────────

// eslint-disable-next-line no-control-regex
const INVALID = /[\\/:*?"<>|\u0000-\u001f]/g

export function cleanCoverName(name: unknown): string {
  const s = String(name ?? '')
    .replace(INVALID, '_')
    .trim()
    .replace(/[. ]+$/g, '')
  return s || 'untitled'
}

const pad2 = (n: number): string => (n < 100 ? String(n).padStart(2, '0') : String(n))

export function coverFolderName(canvas: CoverCanvas): string {
  return cleanCoverName(canvas.w + 'x' + canvas.h + '_' + canvas.label)
}

export function coverPngName(projectName: string, bgIndex: number, typoName: string): string {
  return (
    cleanCoverName(projectName) + '_' + pad2(bgIndex + 1) + '_' + cleanCoverName(typoName) + '.png'
  )
}

export function coverWebpName(projectName: string, typoName: string): string {
  return cleanCoverName(projectName) + '_' + cleanCoverName(typoName) + '.webp'
}

/** 정리 후 같은 파일 이름이 되는 타이포 이름들 (덮어쓰기 경고용) */
export function duplicateTypoNames(typos: CoverItem[]): string[] {
  const seen = new Map<string, number>()
  for (const t of typos) {
    const k = cleanCoverName(t.name).toLowerCase()
    seen.set(k, (seen.get(k) ?? 0) + 1)
  }
  return [...seen].filter(([, n]) => n > 1).map(([k]) => k)
}
