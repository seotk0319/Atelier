import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  Eraser,
  Image as ImageIcon,
  Link2,
  Link2Off,
  Paintbrush,
  Redo2,
  RotateCcw,
  Trash2,
  Undo2,
  X
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import {
  activeLayerId,
  alignLayerAcrossTypos,
  COVER_CANVASES,
  coverRect,
  findLayer,
  getCoverCanvas,
  getPan,
  getPlacement,
  resetPlacement,
  setPan,
  setPlacement,
  type CoverCanvas,
  type CoverCanvasId,
  type CoverFrame,
  type CoverFrameStyle,
  type CoverItem,
  type CoverPlacement,
  type CoverProject
} from '@shared/cover'
import { droppedImagePaths, hasImageDrop } from '../../lib/image-drag'
import { cn } from '../../lib/utils'
import { useCoverStore } from '../../stores/cover-store'
import { toast } from '../../stores/toast-store'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/dialog'
import { Input } from '../ui/input'
import { Segmented, SegmentedItem } from '../ui/segmented'
import { Slider } from '../ui/slider'
import { Switch } from '../ui/switch'
import { useBlobThumb } from './cover-thumbs'
import { forgetBitmap } from './engine/render'
import { removeFrameImage, setFrameImage } from './engine/state'
import { toEditorBrush, type CoverBrushPrefs } from './engine/types'

const MIN_SIZE = 0.02
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/

const FRAME_TILES: readonly { style: CoverFrameStyle; label: string }[] = [
  { style: 'solid', label: '실선' },
  { style: 'double', label: '이중선' },
  { style: 'dashed', label: '파선' },
  { style: 'dotted', label: '점선' },
  { style: 'corners', label: '모서리만' },
  { style: 'image', label: 'PNG' }
]

const RADIUS_STYLES: readonly CoverFrameStyle[] = ['solid', 'double', 'dashed', 'dotted']

export function CoverInspector(): React.JSX.Element {
  const rev = useCoverStore((s) => s.rev)
  const project = useCoverStore((s) => s.project)
  const mode = useCoverStore((s) => s.mode)

  return (
    <aside data-rev={rev} className="flex w-[288px] shrink-0 flex-col rounded-xl bg-paper">
      <div className="min-h-0 flex-1 overflow-y-auto p-3 no-scrollbar">
        {!project ? (
          <EmptyHint>작품을 여는 중이에요.</EmptyHint>
        ) : (
          <>
            <div className="pb-3">
              {mode === 'typo' && <TypoSection project={project} />}
              {mode === 'pan' && <PanSection project={project} />}
              {mode === 'censor' && <CensorSection />}
            </div>
            <div className="border-t border-line pt-3">
              <FrameSection project={project} />
            </div>
          </>
        )}
      </div>
    </aside>
  )
}

function TypoSection({ project }: { project: CoverProject }): React.JSX.Element {
  const mutate = useCoverStore((s) => s.mutate)
  const [lock, setLock] = useState(true)
  const found = findLayer(project, activeLayerId(project))
  const typo = found?.item
  const canvas = getCoverCanvas(project.selection.canvasId)

  if (!typo || !canvas) {
    return (
      <section>
        <SectionHead title="타이포 위치" />
        <EmptyHint>왼쪽에서 타이포를 고르세요.</EmptyHint>
      </section>
    )
  }

  const pl = getPlacement(project, typo, canvas)
  const isExtra = found.item.id !== found.typo.id
  const layerIndex = [found.typo, ...(found.typo.extras ?? [])].indexOf(found.item)
  // 같은 순번 레이어가 있는 다른 언어 수
  const siblings = project.typos.filter(
    (t) => t.id !== found.typo.id && [t, ...(t.extras ?? [])][layerIndex]
  ).length
  const alignOthers = (all: boolean): void => {
    let n = 0
    mutate((p) => {
      n = alignLayerAcrossTypos(p, typo.id, all ? COVER_CANVASES.map((c) => c.id) : [canvas.id])
    })
    if (n) toast('다른 언어 ' + n + '개를 같은 자리로 맞췄어요', 'success')
  }
  const W = canvas.w
  const H = canvas.h
  const apply = (next: CoverPlacement): void => {
    mutate((p) => setPlacement(p, typo.id, canvas.id, next))
  }
  const ratio = (pl.h * H) / Math.max(0.0001, pl.w * W)
  const inverseRatio = 1 / Math.max(0.0001, ratio)

  const setX = (px: number): void => apply({ ...pl, cx: px / W })
  const setY = (px: number): void => apply({ ...pl, cy: px / H })
  const setW = (px: number): void => {
    if (!lock) {
      apply({ ...pl, w: Math.max(MIN_SIZE, px / W) })
      return
    }
    const nw = Math.max(px, MIN_SIZE * W, (MIN_SIZE * H) / Math.max(0.0001, ratio))
    apply({ ...pl, w: nw / W, h: (nw * ratio) / H })
  }
  const setH = (px: number): void => {
    if (!lock) {
      apply({ ...pl, h: Math.max(MIN_SIZE, px / H) })
      return
    }
    const nh = Math.max(px, MIN_SIZE * H, MIN_SIZE * W * inverseRatio)
    apply({ ...pl, h: nh / H, w: (nh * inverseRatio) / W })
  }

  return (
    <section>
      <SectionHead
        title={isExtra ? '문구 위치' : '타이포 위치'}
        hint={canvas.ratio + ' ' + canvas.label}
      />
      <p className="-mt-1 mb-2 truncate text-[11px] text-muted" title={found.item.name}>
        {found.typo.name}
        {isExtra ? ' · ' + (found.item.name || '문구 ' + layerIndex) : ''}
      </p>
      <div className="flex items-center justify-between">
        <span className="text-[11px] text-muted">중심·크기 (px)</span>
        <Button
          size="icon-sm"
          variant={lock ? 'tint' : 'ghost'}
          title={lock ? '비율 잠금 켜짐' : '비율 잠금 꺼짐'}
          aria-pressed={lock}
          onClick={() => setLock((v) => !v)}
        >
          {lock ? <Link2 size={14} /> : <Link2Off size={14} />}
        </Button>
      </div>
      <div className="mt-1 grid grid-cols-2 gap-1.5">
        <NumberField label="X" value={pl.cx * W} onCommit={setX} />
        <NumberField label="Y" value={pl.cy * H} onCommit={setY} />
        <NumberField label="너비" value={pl.w * W} min={2} onCommit={setW} />
        <NumberField label="높이" value={pl.h * H} min={2} onCommit={setH} />
      </div>
      <div className="mt-2 grid grid-cols-3 gap-1.5">
        <Button
          size="sm"
          variant="outline"
          className="px-1 text-[11px]"
          title="가로 가운데"
          onClick={() => apply({ ...pl, cx: 0.5 })}
        >
          <AlignCenterHorizontal size={13} /> 가로
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="px-1 text-[11px]"
          title="세로 가운데"
          onClick={() => apply({ ...pl, cy: 0.5 })}
        >
          <AlignCenterVertical size={13} /> 세로
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="px-1 text-[11px]"
          title="처음 크기로"
          onClick={() => mutate((p) => resetPlacement(p, typo.id, canvas.id))}
        >
          <RotateCcw size={13} /> 처음
        </Button>
      </div>
      {siblings > 0 && (
        <div className="mt-3 rounded-lg bg-surface p-2.5">
          <p className="text-[12px] font-medium text-ink">다른 언어도 이 자리로</p>
          <p className="mt-0.5 text-[11px] leading-relaxed text-faint">
            {isExtra ? layerIndex + '번째 문구' : '타이포'}끼리 중심과 높이를 맞춰요. 너비는 각
            이미지 비율대로예요.
          </p>
          <div className="mt-2 grid grid-cols-2 gap-1.5">
            <Button size="sm" variant="outline" onClick={() => alignOthers(false)}>
              이 캔버스만
            </Button>
            <Button size="sm" variant="outline" onClick={() => alignOthers(true)}>
              캔버스 4개 모두
            </Button>
          </div>
        </div>
      )}
    </section>
  )
}

function PanSection({ project }: { project: CoverProject }): React.JSX.Element {
  const mutate = useCoverStore((s) => s.mutate)
  const canvas = getCoverCanvas(project.selection.canvasId)
  const bg = project.backgrounds.find((b) => b.id === project.selection.bgId)

  if (!bg || !canvas) {
    return (
      <section>
        <SectionHead title="배경 위치" />
        <EmptyHint>왼쪽에서 배경을 고르세요.</EmptyHint>
      </section>
    )
  }

  const pan = getPan(project, bg.id, canvas.id)
  const rect = coverRect(bg.width, bg.height, canvas.w, canvas.h, pan)
  const canX = rect.w > canvas.w + 0.5
  const canY = rect.h > canvas.h + 0.5
  const message =
    canX && canY
      ? null
      : canY
        ? '이 캔버스에선 세로로만 움직여요.'
        : canX
          ? '이 캔버스에선 가로로만 움직여요.'
          : '이 캔버스에선 움직일 여유가 없어요.'

  return (
    <section>
      <SectionHead title="배경 위치" hint={canvas.ratio + ' ' + canvas.label} />
      <div className="py-1">
        <SliderRow
          label="가로"
          value={pan.px * 100}
          min={0}
          max={100}
          unit="%"
          disabled={!canX}
          onChange={(v) => mutate((p) => setPan(p, bg.id, canvas.id, { px: v / 100, py: pan.py }))}
        />
        <SliderRow
          label="세로"
          value={pan.py * 100}
          min={0}
          max={100}
          unit="%"
          disabled={!canY}
          onChange={(v) => mutate((p) => setPan(p, bg.id, canvas.id, { px: pan.px, py: v / 100 }))}
        />
      </div>
      {message && <p className="mt-1 text-[11px] leading-relaxed text-faint">{message}</p>}
      <Button
        size="sm"
        variant="outline"
        className="mt-2 w-full"
        onClick={() => mutate((p) => setPan(p, bg.id, canvas.id, { px: 0.5, py: 0.5 }))}
      >
        가운데로
      </Button>
    </section>
  )
}

function CensorSection(): React.JSX.Element {
  const brush = useCoverStore((s) => s.brush)
  const history = useCoverStore((s) => s.history)
  const editor = useCoverStore((s) => s.editor)
  const [confirm, setConfirm] = useState(false)

  const apply = (patch: Partial<CoverBrushPrefs>): void => {
    const st = useCoverStore.getState()
    const next = { ...st.brush, ...patch }
    st.setBrush(patch)
    st.editor?.setBrush(toEditorBrush(next))
  }

  return (
    <section>
      <SectionHead title="검열 붓" />
      <div className="py-1">
        <div className="flex items-center gap-2">
          <span className="w-[52px] shrink-0 text-[11px] text-muted">크기</span>
          <Slider
            min={5}
            max={400}
            step={1}
            value={[brush.size]}
            onValueChange={(v) => apply({ size: v[0] ?? brush.size })}
          />
          <span className="w-9 shrink-0 text-right text-[12px] tabular-nums text-muted">
            {Math.round(brush.size)}
          </span>
        </div>
        <SliderRow
          label="부드러움"
          value={brush.softness}
          min={0}
          max={100}
          unit=""
          onChange={(v) => apply({ softness: v })}
        />
        <SliderRow
          label="불투명도"
          value={brush.opacity}
          min={10}
          max={100}
          unit="%"
          onChange={(v) => apply({ opacity: v })}
        />
      </div>
      <div className="flex items-center gap-2 py-1">
        <span className="w-[52px] shrink-0 text-[11px] text-muted">색</span>
        <SwatchButton
          color="#ffffff"
          title="흰색"
          selected={brush.color.toLowerCase() === '#ffffff'}
          onClick={() => apply({ color: '#ffffff' })}
        />
        <SwatchButton
          color="#000000"
          title="검정"
          selected={brush.color.toLowerCase() === '#000000'}
          onClick={() => apply({ color: '#000000' })}
        />
        <ColorSwatch
          title="직접 고르기"
          value={brush.color}
          onChange={(color) => apply({ color })}
        />
      </div>
      <Segmented
        className="mt-1 flex w-full"
        value={brush.erase ? 'erase' : 'paint'}
        onValueChange={(v) => {
          if (v) apply({ erase: v === 'erase' })
        }}
      >
        <SegmentedItem value="paint" className="flex-1">
          <Paintbrush size={13} /> 칠하기
        </SegmentedItem>
        <SegmentedItem value="erase" className="flex-1">
          <Eraser size={13} /> 지우개
        </SegmentedItem>
      </Segmented>
      <div className="mt-1.5 grid grid-cols-2 gap-1.5">
        <Button
          size="sm"
          variant="outline"
          className="px-1 text-[11px]"
          disabled={!editor || !history.canUndo}
          onClick={() => {
            void editor?.undo()
          }}
        >
          <Undo2 size={13} /> 되돌리기
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="px-1 text-[11px]"
          disabled={!editor || !history.canRedo}
          onClick={() => {
            void editor?.redo()
          }}
        >
          <Redo2 size={13} /> 다시
        </Button>
      </div>
      <Button
        size="sm"
        variant="danger"
        className="mt-1 w-full justify-start"
        disabled={!editor}
        onClick={() => setConfirm(true)}
      >
        <Trash2 size={13} /> 전체 지우기
      </Button>
      <p className="mt-2 text-[11px] leading-relaxed text-faint">
        검열은 이 그림의 모든 캔버스 크기에 같이 들어가요 · Ctrl+Z 되돌리기
      </p>

      <Dialog open={confirm} onOpenChange={setConfirm}>
        <DialogContent>
          <div className="p-5">
            <DialogTitle>이 그림의 검열을 모두 지울까요?</DialogTitle>
            <DialogDescription className="mt-1">되돌리기로 되살릴 수 있어요.</DialogDescription>
            <div className="mt-4 flex justify-end gap-2">
              <Button size="md" variant="ghost" onClick={() => setConfirm(false)}>
                취소
              </Button>
              <Button
                size="md"
                variant="danger"
                onClick={() => {
                  setConfirm(false)
                  void editor?.clearMask()
                }}
              >
                지우기
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </section>
  )
}

function FrameSection({ project }: { project: CoverProject }): React.JSX.Element {
  const mutate = useCoverStore((s) => s.mutate)
  const frame = project.frame
  const [lastColor2, setLastColor2] = useState(frame.color2 ?? '#ffffff')

  useEffect(() => {
    if (frame.color2) setLastColor2(frame.color2)
  }, [frame.color2])

  const update = (patch: Partial<CoverFrame>): void => {
    mutate((p) => Object.assign(p.frame, patch))
  }
  const disabled = !frame.enabled

  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-[13px] font-semibold text-ink">액자</h3>
        <Switch
          checked={frame.enabled}
          aria-label="액자 사용"
          onCheckedChange={(enabled) => update({ enabled })}
        />
      </div>
      <div className={cn(disabled && 'pointer-events-none opacity-40')}>
        <div className="grid grid-cols-3 gap-1.5">
          {FRAME_TILES.map((tile) => (
            <button
              key={tile.style}
              type="button"
              aria-pressed={frame.style === tile.style}
              onClick={() => update({ style: tile.style })}
              className={cn(
                'flex flex-col items-center gap-1 rounded-lg border py-1.5 text-[11px] transition-colors',
                frame.style === tile.style
                  ? 'border-accent bg-accent-soft text-accent'
                  : 'border-line bg-surface text-muted hover:text-ink'
              )}
            >
              <FrameGlyph style={tile.style} />
              {tile.label}
            </button>
          ))}
        </div>

        {frame.style === 'image' ? (
          <>
            <div className="mt-2 space-y-1.5">
              {COVER_CANVASES.map((canvas) => (
                <FrameImageRow
                  key={canvas.id}
                  canvas={canvas}
                  item={project.frameImages[canvas.id]}
                  disabled={disabled}
                  onPick={(source) => void changeFrameImage(canvas.id, source)}
                  onRemove={() => removeFrameImageAt(canvas.id)}
                />
              ))}
            </div>
            <p className="mt-1.5 text-[11px] leading-relaxed text-faint">
              캔버스 크기에 맞춰 늘려 붙여요.
            </p>
            <div className="mt-1">
              <SliderRow
                label="불투명도"
                value={Math.round(frame.opacity * 100)}
                min={0}
                max={100}
                unit="%"
                onChange={(v) => update({ opacity: v / 100 })}
              />
            </div>
          </>
        ) : (
          <>
            <div className="flex items-center gap-2 py-1">
              <span className="w-[52px] shrink-0 text-[11px] text-muted">색</span>
              <ColorSwatch
                title="액자 색"
                value={frame.color}
                onChange={(color) => update({ color })}
              />
              <div className="flex-1" />
              <span className="text-[11px] text-muted">그라데이션</span>
              <Switch
                checked={frame.color2 !== null}
                aria-label="그라데이션"
                onCheckedChange={(on) => update({ color2: on ? lastColor2 : null })}
              />
            </div>
            {frame.color2 !== null && (
              <div className="flex items-center gap-2 py-1">
                <span className="w-[52px] shrink-0 text-[11px] text-muted">두 번째 색</span>
                <ColorSwatch
                  title="그라데이션 끝 색"
                  value={frame.color2}
                  onChange={(color) => {
                    setLastColor2(color)
                    update({ color2: color })
                  }}
                />
              </div>
            )}
            <div className="mt-1">
              <SliderRow
                label="두께"
                value={frame.width}
                min={1}
                max={60}
                unit="px"
                onChange={(v) => update({ width: v })}
              />
              <SliderRow
                label="안쪽 여백"
                value={frame.inset}
                min={0}
                max={200}
                unit="px"
                onChange={(v) => update({ inset: v })}
              />
              {RADIUS_STYLES.includes(frame.style) && (
                <SliderRow
                  label="둥글기"
                  value={frame.radius}
                  min={0}
                  max={200}
                  unit="px"
                  onChange={(v) => update({ radius: v })}
                />
              )}
              {frame.style === 'double' && (
                <SliderRow
                  label="간격"
                  value={frame.gap}
                  min={0}
                  max={60}
                  unit="px"
                  onChange={(v) => update({ gap: v })}
                />
              )}
              {frame.style === 'corners' && (
                <SliderRow
                  label="모서리 길이"
                  value={frame.cornerLen}
                  min={10}
                  max={600}
                  unit="px"
                  onChange={(v) => update({ cornerLen: v })}
                />
              )}
              <SliderRow
                label="불투명도"
                value={Math.round(frame.opacity * 100)}
                min={0}
                max={100}
                unit="%"
                onChange={(v) => update({ opacity: v / 100 })}
              />
            </div>
          </>
        )}
      </div>
    </section>
  )
}

async function changeFrameImage(canvasId: CoverCanvasId, source: File | string): Promise<void> {
  const project = useCoverStore.getState().project
  if (!project) return
  try {
    const res = await setFrameImage(project, canvasId, source)
    if (!res) {
      toast('액자 PNG를 읽지 못했어요', 'error')
      return
    }
    if (res.oldKey) forgetBitmap(res.oldKey)
    const st = useCoverStore.getState()
    if (st.project === project) st.mutate(() => {})
  } catch {
    toast('액자 PNG를 넣지 못했어요', 'error')
  }
}

function removeFrameImageAt(canvasId: CoverCanvasId): void {
  const st = useCoverStore.getState()
  const project = st.project
  if (!project) return
  const oldKey = removeFrameImage(project, canvasId)
  if (oldKey) forgetBitmap(oldKey)
  if (st.project === project) st.mutate(() => {})
}

function FrameImageRow({
  canvas,
  item,
  disabled,
  onPick,
  onRemove
}: {
  canvas: CoverCanvas
  item: CoverItem | undefined
  disabled: boolean
  onPick: (source: File | string) => void
  onRemove: () => void
}): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  const thumb = useBlobThumb(item?.blobKey ?? null, 40)

  return (
    <div
      onDragOver={(e) => {
        if (disabled || !hasImageDrop(e)) return
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false)
        if (disabled || !hasImageDrop(e)) return
        e.preventDefault()
        const paths = droppedImagePaths(e)
        if (paths[0]) {
          onPick(paths[0])
          return
        }
        const file = Array.from(e.dataTransfer.files).find((f) => f.type.startsWith('image/'))
        if (file) onPick(file)
      }}
      className={cn(
        'flex h-10 items-center gap-2 rounded-lg border px-2',
        over ? 'border-accent bg-accent-soft' : 'border-line bg-surface'
      )}
    >
      <div className="w-[62px] shrink-0">
        <div className="text-[11px] font-medium text-ink">
          {canvas.ratio} {canvas.label}
        </div>
        <div className="text-[11px] tabular-nums text-faint">
          {canvas.w}×{canvas.h}
        </div>
      </div>
      <div className="grid size-7 shrink-0 place-items-center overflow-hidden rounded-md bg-paper">
        {thumb ? (
          <img src={thumb} alt="" className="size-full object-contain" draggable={false} />
        ) : (
          <ImageIcon size={13} className="text-faint" />
        )}
      </div>
      <div className="flex-1" />
      <Button
        size="sm"
        variant="ghost"
        className="px-1.5 text-[11px]"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
      >
        고르기
      </Button>
      <Button
        size="icon-sm"
        variant="ghost"
        title="액자 지우기"
        disabled={disabled || !item}
        onClick={onRemove}
      >
        <X size={12} />
      </Button>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0]
          e.target.value = ''
          if (file) onPick(file)
        }}
      />
    </div>
  )
}

function NumberField({
  label,
  value,
  min = -Infinity,
  max = Infinity,
  onCommit
}: {
  label: string
  value: number
  min?: number
  max?: number
  onCommit: (value: number) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const [editing, setEditing] = useState(false)

  const clampValue = (n: number): number => Math.min(max, Math.max(min, n))
  const commit = (raw: string): void => {
    if (raw.trim() === '') {
      setEditing(false)
      return
    }
    const n = Number(raw.replace(',', '.'))
    if (Number.isFinite(n)) onCommit(clampValue(n))
    setEditing(false)
  }

  return (
    <label className="block">
      <span className="mb-0.5 block text-[11px] text-faint">{label}</span>
      <Input
        type="number"
        inputMode="decimal"
        value={editing ? draft : formatNumber(value)}
        onFocus={() => {
          setDraft(formatNumber(value))
          setEditing(true)
        }}
        onChange={(e) => {
          setDraft(e.target.value)
          setEditing(true)
        }}
        onBlur={(e) => commit(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            commit(e.currentTarget.value)
            e.currentTarget.blur()
            return
          }
          if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
          e.preventDefault()
          const parsed = editing && draft.trim() !== '' ? Number(draft) : value
          if (!Number.isFinite(parsed)) return
          const next = clampValue(parsed + (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 10 : 1))
          setDraft(formatNumber(next))
          setEditing(true)
          onCommit(next)
        }}
        className="h-7 px-1.5 text-[12px] tabular-nums"
      />
    </label>
  )
}

function SliderRow({
  label,
  value,
  min,
  max,
  unit,
  disabled = false,
  onChange
}: {
  label: string
  value: number
  min: number
  max: number
  unit: string
  disabled?: boolean
  onChange: (value: number) => void
}): React.JSX.Element {
  return (
    <div className={cn('flex items-center gap-2 py-1', disabled && 'opacity-50')}>
      <span className="w-[52px] shrink-0 text-[11px] text-muted">{label}</span>
      <Slider
        min={min}
        max={max}
        step={1}
        disabled={disabled}
        value={[value]}
        onValueChange={(v) => onChange(v[0] ?? value)}
      />
      <span className="w-11 shrink-0 text-right text-[12px] tabular-nums text-muted">
        {Math.round(value)}
        {unit}
      </span>
    </div>
  )
}

function SectionHead({ title, hint }: { title: string; hint?: string }): React.JSX.Element {
  return (
    <div className="mb-1.5 flex items-baseline justify-between gap-2">
      <h3 className="text-[13px] font-semibold text-ink">{title}</h3>
      {hint && <span className="truncate text-[11px] text-faint">{hint}</span>}
    </div>
  )
}

function EmptyHint({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <p className="rounded-lg bg-surface px-3 py-2 text-[12px] leading-relaxed text-faint">
      {children}
    </p>
  )
}

function ColorSwatch({
  title,
  value,
  onChange
}: {
  title: string
  value: string
  onChange: (value: string) => void
}): React.JSX.Element {
  const color = HEX_COLOR.test(value) ? value : '#000000'
  return (
    <label
      title={title}
      className="relative block size-7 shrink-0 cursor-pointer overflow-hidden rounded-md border border-line"
      style={{ backgroundColor: color }}
    >
      <input
        type="color"
        value={color}
        aria-label={title}
        onChange={(e) => onChange(e.target.value)}
        className="absolute inset-0 size-full cursor-pointer opacity-0"
      />
    </label>
  )
}

function SwatchButton({
  color,
  title,
  selected,
  onClick
}: {
  color: string
  title: string
  selected: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        'size-7 shrink-0 rounded-md border',
        selected ? 'border-accent ring-2 ring-accent/30' : 'border-line'
      )}
      style={{ backgroundColor: color }}
    />
  )
}

function FrameGlyph({ style }: { style: CoverFrameStyle }): React.JSX.Element {
  if (style === 'image') return <ImageIcon size={18} />
  if (style === 'corners') {
    return (
      <span className="relative block size-7">
        <span className="absolute left-0 top-0 size-2 border-l-2 border-t-2 border-current" />
        <span className="absolute right-0 top-0 size-2 border-r-2 border-t-2 border-current" />
        <span className="absolute bottom-0 left-0 size-2 border-b-2 border-l-2 border-current" />
        <span className="absolute bottom-0 right-0 size-2 border-b-2 border-r-2 border-current" />
      </span>
    )
  }
  return (
    <span
      className={cn(
        'block size-7 rounded-[3px] border-current',
        style === 'solid' && 'border-2 border-solid',
        style === 'double' && 'border-[3px] border-double',
        style === 'dashed' && 'border-2 border-dashed',
        style === 'dotted' && 'border-2 border-dotted'
      )}
    />
  )
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '0'
  // 출력 픽셀은 정수로 보여 준다 (끌어서 생긴 소수점은 숨김)
  return String(Math.round(value))
}
