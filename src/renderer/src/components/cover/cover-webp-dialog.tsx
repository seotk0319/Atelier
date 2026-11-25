import { ArrowLeft, ArrowRight, Pause, Play, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import {
  COVER_CANVASES,
  clampDuration,
  coverFolderName,
  coverWebpName,
  getCoverCanvas,
  type CoverCanvas,
  type CoverCanvasId,
  type CoverWebpSettings,
  type CoverWebpFrame
} from '@shared/cover'
import { buildAnimatedWebp } from '@shared/cover-webp'
import { cn } from '../../lib/utils'
import { useCoverStore } from '../../stores/cover-store'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/dialog'
import { Input } from '../ui/input'
import { Slider } from '../ui/slider'
import { isWebpEncodeSupported, encodeFrame } from './engine/webp'
import { renderCoverCanvas } from './engine/render'
import { CoverOutputFolder } from './cover-output-folder'

const PICK_LONG = 120
const PREVIEW_LONG = 260
const DEFAULT_DURATION_MS = 500
const DEFAULT_QUALITY = 80

/** 합성 썸네일 캐시. 프로젝트 rev 가 바뀌면 통째로 버린다. */
const thumbCache = new Map<string, HTMLCanvasElement>()
const previewCache = new Map<string, HTMLCanvasElement>()
let thumbCacheKey = ''

type WebpProgress = {
  combo: number
  totalCombos: number
  frame: number
  totalFrames: number
  file: string
}

type WebpResult = {
  saved: number
  failed: number
  firstError: string | null
  stopped: boolean
}

const secText = (ms: number): string => String(Math.round(ms) / 1000)

function totalText(ms: number): string {
  return (Math.round(ms) / 1000).toFixed(2).replace(/0+$/, '').replace(/\.$/, '')
}

function safeSupported(): boolean {
  try {
    return isWebpEncodeSupported()
  } catch {
    return false
  }
}

/** 표지 WEBP(움직이는 이미지) 만들기 창 */
export function CoverWebpDialog({
  open,
  onOpenChange
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
}): React.JSX.Element {
  const project = useCoverStore((s) => s.project)
  const rev = useCoverStore((s) => s.rev)
  const outputDir = useCoverStore((s) => s.outputDir)
  const refreshOutputDir = useCoverStore((s) => s.refreshOutputDir)

  const [canvasId, setCanvasId] = useState<CoverCanvasId>('1x1')
  const [typoId, setTypoId] = useState<string | null>(null)
  const [outCanvases, setOutCanvases] = useState<Set<CoverCanvasId>>(new Set())
  const [outTypos, setOutTypos] = useState<Set<string>>(new Set())
  const [quality, setQuality] = useState(DEFAULT_QUALITY)
  const [played, setPlayIndex] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [batchSec, setBatchSec] = useState('0.5')
  const [supported, setSupported] = useState(true)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<WebpProgress | null>(null)
  const [result, setResult] = useState<WebpResult | null>(null)
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [cacheTick, setCacheTick] = useState(0)
  const runningRef = useRef(false)
  const stopRef = useRef(false)

  const frames = project?.webp.frames ?? []
  const canvas = getCoverCanvas(canvasId) ?? COVER_CANVASES[0]
  const currentTypo = project?.typos.find((t) => t.id === typoId) ?? null
  const outCanvasList = COVER_CANVASES.filter((c) => outCanvases.has(c.id))
  const outTypoList = (project?.typos ?? []).filter((t) => outTypos.has(t.id))
  const fileCount = outCanvasList.length * outTypoList.length
  const totalMs = frames.reduce((sum, frame) => sum + frame.durationMs, 0)

  const reason = !project
    ? '작품을 먼저 열어 주세요'
    : !supported
      ? '이 환경에서는 WEBP 인코딩을 지원하지 않아요'
      : frames.length === 0
        ? '프레임을 하나 이상 넣어 주세요'
        : outCanvasList.length === 0
          ? '출력할 캔버스를 골라 주세요'
          : outTypoList.length === 0
            ? '타이포를 하나 이상 골라 주세요'
            : !outputDir
              ? '저장할 폴더를 골라 주세요'
              : ''

  const mutateWebp = (fn: (webp: CoverWebpSettings) => void): void => {
    useCoverStore.getState().mutate(
      (p) => {
        fn(p.webp)
      },
      { redraw: false }
    )
  }

  useEffect(() => {
    if (!open) {
      setPlaying(false)
      thumbCache.clear()
      previewCache.clear()
      thumbCacheKey = ''
      return
    }
    const p = useCoverStore.getState().project
    if (!p) return
    const curCanvas = getCoverCanvas(p.selection.canvasId) ?? COVER_CANVASES[0]
    const curTypo = p.typos.some((t) => t.id === p.selection.typoId) ? p.selection.typoId : null
    setCanvasId(curCanvas.id)
    setTypoId(curTypo)
    setOutCanvases(new Set([curCanvas.id]))
    setOutTypos(new Set(p.typos.map((t) => t.id)))
    setQuality(Math.round(p.webp.quality * 100))
    setPlayIndex(0)
    setPlaying(false)
    setProgress(null)
    setResult(null)
    setSupported(safeSupported())
    setBatchSec(secText(DEFAULT_DURATION_MS))
    void refreshOutputDir()

    const ids = new Set(p.backgrounds.map((b) => b.id))
    if (p.webp.frames.some((f) => !ids.has(f.bgId))) {
      useCoverStore.getState().mutate(
        (q) => {
          q.webp.frames = q.webp.frames.filter((f) => ids.has(f.bgId))
        },
        { redraw: false }
      )
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    if (!open || !project) return
    const key = project.id + '|' + rev + '|' + canvasId + '|' + (typoId ?? '')
    if (key === thumbCacheKey) return
    thumbCacheKey = key
    thumbCache.clear()
    previewCache.clear()
    let cancelled = false
    const c = getCoverCanvas(canvasId) ?? COVER_CANVASES[0]
    const scale = PICK_LONG / Math.max(c.w, c.h)
    const previewScale = PREVIEW_LONG / Math.max(c.w, c.h)
    const used = new Set(project.webp.frames.map((f) => f.bgId))
    const order: string[] = []
    const seen = new Set<string>()
    for (const f of project.webp.frames) {
      if (!seen.has(f.bgId)) {
        seen.add(f.bgId)
        order.push(f.bgId)
      }
    }
    for (const bg of project.backgrounds) {
      if (!seen.has(bg.id)) {
        seen.add(bg.id)
        order.push(bg.id)
      }
    }
    void (async () => {
      for (const bgId of order) {
        if (cancelled) return
        try {
          const rendered = await renderCoverCanvas(project, bgId, typoId, c.id, scale)
          if (cancelled) return
          thumbCache.set(bgId, rendered)
          if (used.has(bgId)) {
            const preview = await renderCoverCanvas(project, bgId, typoId, c.id, previewScale)
            if (cancelled) return
            previewCache.set(bgId, preview)
          }
          setCacheTick((tick) => tick + 1)
        } catch {
          // 한 배경을 못 그려도 나머지 썸네일은 계속 만든다.
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open, project, rev, canvasId, typoId])

  useEffect(() => {
    if (frames.length === 0) setPlaying(false)
    else if (played >= frames.length) setPlayIndex(frames.length - 1)
  }, [frames.length, played])

  useEffect(() => {
    if (!playing || running || !open) return
    if (frames.length === 0) return
    const at = Math.min(played, frames.length - 1)
    const timer = window.setTimeout(() => {
      setPlayIndex((at + 1) % frames.length)
    }, frames[at].durationMs)
    return () => window.clearTimeout(timer)
  }, [playing, running, open, played, frames.length, rev])

  const addFrame = (bgId: string): void => {
    if (runningRef.current) return
    mutateWebp((webp) => {
      webp.frames.push({ bgId, durationMs: DEFAULT_DURATION_MS })
    })
    const count = useCoverStore.getState().project?.webp.frames.length ?? 0
    setPlayIndex(Math.max(0, count - 1))
    setResult(null)
  }

  const addAllFrames = (): void => {
    if (runningRef.current || !project) return
    mutateWebp((webp) => {
      webp.frames = project.backgrounds.map((bg) => ({
        bgId: bg.id,
        durationMs: DEFAULT_DURATION_MS
      }))
    })
    setPlayIndex(0)
    setResult(null)
  }

  const clearFrames = (): void => {
    if (runningRef.current) return
    mutateWebp((webp) => {
      webp.frames = []
    })
    setPlaying(false)
    setPlayIndex(0)
    setResult(null)
  }

  const moveFrame = (from: number, to: number): void => {
    if (from === to) return
    mutateWebp((webp) => {
      if (from < 0 || from >= webp.frames.length) return
      const [frame] = webp.frames.splice(from, 1)
      webp.frames.splice(Math.max(0, Math.min(webp.frames.length, to)), 0, frame)
    })
    setResult(null)
  }

  const removeFrame = (index: number): void => {
    mutateWebp((webp) => {
      webp.frames.splice(index, 1)
    })
    setPlayIndex((at) => Math.max(0, Math.min(at, frames.length - 2)))
    setResult(null)
  }

  const setFrameDuration = (index: number, ms: number): void => {
    mutateWebp((webp) => {
      const frame = webp.frames[index]
      if (frame) frame.durationMs = clampDuration(ms)
    })
    setResult(null)
  }

  const applyBatch = (): void => {
    const n = Number(batchSec)
    if (!Number.isFinite(n) || n < 0.01) {
      setBatchSec(secText(DEFAULT_DURATION_MS))
      return
    }
    const ms = clampDuration(n * 1000)
    setBatchSec(secText(ms))
    mutateWebp((webp) => {
      for (const frame of webp.frames) frame.durationMs = ms
    })
    setResult(null)
  }

  const commitQuality = (next: number[]): void => {
    const pct = Math.min(100, Math.max(0, Math.round(next[0] ?? quality)))
    setQuality(pct)
    mutateWebp((webp) => {
      webp.quality = pct / 100
    })
    setResult(null)
  }

  const toggleCanvas = (id: CoverCanvasId): void => {
    setOutCanvases((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
    setResult(null)
  }

  const toggleTypo = (id: string): void => {
    setOutTypos((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
    setResult(null)
  }

  const run = async (): Promise<void> => {
    if (runningRef.current || reason) return
    const p = useCoverStore.getState().project
    if (!p) return
    const canvases = COVER_CANVASES.filter((c) => outCanvases.has(c.id))
    const typos = p.typos.filter((t) => outTypos.has(t.id))
    const frameList: CoverWebpFrame[] = p.webp.frames.map((f) => ({ ...f }))
    const combos: { canvas: CoverCanvas; typoName: string; typoId: string }[] = []
    for (const c of canvases) {
      for (const t of typos) combos.push({ canvas: c, typoName: t.name, typoId: t.id })
    }
    if (!combos.length || !frameList.length) return

    const totalFrames = frameList.length
    const qualityValue = Math.min(1, Math.max(0, p.webp.quality))
    runningRef.current = true
    stopRef.current = false
    setRunning(true)
    setPlaying(false)
    setResult(null)
    setProgress({
      combo: 0,
      totalCombos: combos.length,
      frame: 0,
      totalFrames,
      file: ''
    })

    let saved = 0
    let failed = 0
    let firstError: string | null = null
    let stopped = false

    try {
      for (let i = 0; i < combos.length; i++) {
        if (stopRef.current) {
          stopped = true
          break
        }
        const combo = combos[i]
        const folder = coverFolderName(combo.canvas)
        const file = coverWebpName(p.name, combo.typoName)
        const encoded: { bytes: Uint8Array; durationMs: number }[] = []
        let comboError: string | null = null

        for (let k = 0; k < frameList.length; k++) {
          setProgress({
            combo: i + 1,
            totalCombos: combos.length,
            frame: k + 1,
            totalFrames,
            file
          })
          try {
            const frameCanvas = await renderCoverCanvas(
              p,
              frameList[k].bgId,
              combo.typoId,
              combo.canvas.id,
              1,
              true
            )
            const bytes = await encodeFrame(frameCanvas, qualityValue)
            frameCanvas.width = 1
            frameCanvas.height = 1
            encoded.push({ bytes, durationMs: frameList[k].durationMs })
          } catch (err) {
            comboError = err instanceof Error ? err.message : String(err)
            break
          }
          await new Promise((resolve) => setTimeout(resolve, 0))
        }

        if (comboError) {
          failed++
          if (!firstError) firstError = comboError
          continue
        }
        if (encoded.length !== totalFrames) continue

        try {
          const bytes = buildAnimatedWebp(encoded, combo.canvas.w, combo.canvas.h)
          const res = await window.nais.invoke('cover:writeOutput', { folder, file, bytes })
          if ('error' in res) {
            failed++
            if (!firstError) firstError = res.error
          } else {
            saved++
          }
        } catch (err) {
          failed++
          if (!firstError) firstError = err instanceof Error ? err.message : String(err)
        }
        encoded.length = 0
        setProgress({
          combo: i + 1,
          totalCombos: combos.length,
          frame: totalFrames,
          totalFrames,
          file
        })
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
    } finally {
      runningRef.current = false
      setRunning(false)
      setResult({ saved, failed, firstError, stopped })
    }
  }

  const openOutput = async (): Promise<void> => {
    const one = outCanvasList.length === 1 ? outCanvasList[0] : null
    await window.nais.invoke('cover:openOutput', one ? { folder: coverFolderName(one) } : {})
  }

  const requestClose = (): void => {
    if (runningRef.current) return
    onOpenChange(false)
  }

  const positions = new Map<string, number[]>()
  frames.forEach((frame, index) => {
    const list = positions.get(frame.bgId) ?? []
    list.push(index + 1)
    positions.set(frame.bgId, list)
  })

  const progressTotal = (progress?.totalCombos ?? 0) * (progress?.totalFrames ?? 0)
  const progressDone = progress
    ? Math.max(0, (progress.combo - 1) * progress.totalFrames + progress.frame)
    : 0
  const percent = progressTotal > 0 ? Math.round((progressDone / progressTotal) * 100) : 0
  const previewScale = PREVIEW_LONG / Math.max(canvas.w, canvas.h)
  const previewW = Math.round(canvas.w * previewScale)
  const previewH = Math.round(canvas.h * previewScale)

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v && runningRef.current) return
        onOpenChange(v)
      }}
    >
      <DialogContent
        className="flex h-[88vh] w-[min(1100px,94vw)] max-w-none flex-col p-0"
        onInteractOutside={(e) => {
          if (runningRef.current) e.preventDefault()
        }}
        onEscapeKeyDown={(e) => {
          if (runningRef.current) e.preventDefault()
        }}
      >
        <div className="shrink-0 px-5 pb-3 pr-10 pt-4">
          <DialogTitle>움직이는 WEBP</DialogTitle>
          <DialogDescription>
            {canvas.ratio} {canvas.label} · {currentTypo?.name || '타이포 없음'} 기준으로 보여요
          </DialogDescription>
        </div>

        <div className="flex min-h-0 flex-1 overflow-hidden">
          <div className="flex min-w-0 flex-1 flex-col gap-3 px-4 pb-4">
            <section className="flex min-h-0 flex-1 flex-col">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <span className="text-[13px] font-bold text-ink">프레임 고르기</span>
                <span className="text-[11px] text-faint">그림을 누르면 끝에 들어가요</span>
                <div className="flex-1" />
                <Button
                  type="button"
                  size="sm"
                  variant="default"
                  disabled={running || !project?.backgrounds.length}
                  onClick={addAllFrames}
                >
                  전부 순서대로 넣기
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={running || frames.length === 0}
                  onClick={clearFrames}
                >
                  모두 빼기
                </Button>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto pb-1">
                {project && project.backgrounds.length > 0 ? (
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(126px,1fr))] gap-2">
                    {project.backgrounds.map((bg, index) => {
                      const places = positions.get(bg.id) ?? []
                      return (
                        <PickerTile
                          key={bg.id}
                          bgId={bg.id}
                          name={bg.name}
                          index={index}
                          places={places}
                          tick={cacheTick}
                          disabled={running}
                          onClick={() => addFrame(bg.id)}
                        />
                      )
                    })}
                  </div>
                ) : (
                  <div className="grid h-full place-items-center text-[12px] text-faint">
                    배경을 먼저 넣어 주세요
                  </div>
                )}
              </div>
            </section>

            <section className="shrink-0 rounded-lg border border-line p-2.5">
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <span className="text-[13px] font-bold text-ink">프레임</span>
                <span className="text-[12px] text-muted">
                  {frames.length}프레임
                  {frames.length ? ' · 총 ' + totalText(totalMs) + '초' : ''}
                </span>
                <div className="flex-1" />
                <span className="text-[11px] text-faint">모두</span>
                <Input
                  type="number"
                  min="0.01"
                  step="0.1"
                  value={batchSec}
                  disabled={running || frames.length === 0}
                  onChange={(e) => setBatchSec(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      applyBatch()
                    }
                  }}
                  className="h-7 w-16 text-[12px]"
                  aria-label="모든 프레임 시간(초)"
                />
                <span className="text-[11px] text-faint">초로</span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={running || frames.length === 0}
                  onClick={applyBatch}
                >
                  적용
                </Button>
              </div>
              <div className="flex gap-2 overflow-x-auto pb-1">
                {frames.length === 0 ? (
                  <div className="flex h-[122px] w-full items-center justify-center text-[12px] text-faint">
                    위에서 그림을 눌러 프레임을 넣어 주세요
                  </div>
                ) : (
                  frames.map((frame, index) => (
                    <FrameCard
                      key={index}
                      bgId={frame.bgId}
                      index={index}
                      count={frames.length}
                      durationMs={frame.durationMs}
                      current={index === played}
                      dragging={dragIndex === index}
                      disabled={running}
                      tick={cacheTick}
                      onPick={() => setPlayIndex(index)}
                      onLeft={() => moveFrame(index, index - 1)}
                      onRight={() => moveFrame(index, index + 1)}
                      onRemove={() => removeFrame(index)}
                      onDuration={(ms) => setFrameDuration(index, ms)}
                      onDragStart={() => setDragIndex(index)}
                      onDragEnd={() => setDragIndex(null)}
                      onDrop={() => {
                        if (dragIndex !== null) moveFrame(dragIndex, index)
                        setDragIndex(null)
                      }}
                    />
                  ))
                )}
              </div>
            </section>
          </div>

          <aside className="flex w-[300px] shrink-0 flex-col border-l border-line">
            <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
              <section>
                <div className="mb-2 text-[13px] font-bold text-ink">미리보기</div>
                <div className="relative flex min-h-[140px] items-center justify-center rounded-lg bg-surface-2 p-2">
                  <canvas
                    ref={(node) => {
                      if (!node) return
                      node.width = previewW
                      node.height = previewH
                      const ctx = node.getContext('2d')
                      if (!ctx) return
                      ctx.clearRect(0, 0, previewW, previewH)
                      const frame = frames[Math.min(played, Math.max(0, frames.length - 1))]
                      const source = frame
                        ? (previewCache.get(frame.bgId) ?? thumbCache.get(frame.bgId))
                        : undefined
                      if (source) {
                        ctx.imageSmoothingEnabled = true
                        ctx.imageSmoothingQuality = 'high'
                        ctx.drawImage(source, 0, 0, previewW, previewH)
                      }
                    }}
                    style={{ width: previewW, height: previewH }}
                    className="max-h-[260px] max-w-full rounded-md"
                  />
                  {frames.length === 0 && (
                    <span className="absolute text-[11px] text-faint">프레임을 골라 주세요</span>
                  )}
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="default"
                    disabled={frames.length === 0 || running}
                    onClick={() => setPlaying((v) => !v)}
                  >
                    {playing ? <Pause size={13} /> : <Play size={13} />}
                    {playing ? '정지' : '재생'}
                  </Button>
                  <span className="min-w-0 truncate text-[11px] text-faint">
                    {frames.length
                      ? '프레임 ' +
                        (Math.min(played, frames.length - 1) + 1) +
                        ' / ' +
                        frames.length +
                        ' · ' +
                        secText(frames[Math.min(played, frames.length - 1)].durationMs) +
                        '초'
                      : '프레임 없음'}
                  </span>
                </div>
              </section>

              <section>
                <div className="mb-1.5 flex items-baseline justify-between">
                  <span className="text-[12px] font-semibold text-muted">품질</span>
                  <span className="text-[12px] font-semibold tabular-nums text-ink">{quality}</span>
                </div>
                <Slider
                  value={[quality]}
                  min={0}
                  max={100}
                  step={1}
                  disabled={running}
                  onValueChange={(v) => setQuality(v[0] ?? quality)}
                  onValueCommit={commitQuality}
                  aria-label="WEBP 품질"
                />
              </section>

              <section>
                <div className="mb-1.5 text-[12px] font-semibold text-muted">출력 캔버스</div>
                <div className="grid grid-cols-2 gap-1.5">
                  {COVER_CANVASES.map((item) => (
                    <WebpCanvasChip
                      key={item.id}
                      canvas={item}
                      on={outCanvases.has(item.id)}
                      disabled={running}
                      onClick={() => toggleCanvas(item.id)}
                    />
                  ))}
                </div>
              </section>

              <section>
                <div className="mb-1.5 text-[12px] font-semibold text-muted">타이포</div>
                {project && project.typos.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {project.typos.map((typo) => {
                      const on = outTypos.has(typo.id)
                      return (
                        <button
                          key={typo.id}
                          type="button"
                          aria-pressed={on}
                          disabled={running}
                          onClick={() => toggleTypo(typo.id)}
                          title={typo.name}
                          className={cn(
                            'h-7 max-w-full truncate rounded-md border px-2.5 text-[12px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50',
                            on
                              ? 'border-accent bg-accent-soft text-accent'
                              : 'border-line bg-surface-2 text-muted hover:text-ink'
                          )}
                        >
                          {typo.name || '(이름 없음)'}
                        </button>
                      )
                    })}
                  </div>
                ) : (
                  <p className="text-[12px] text-faint">타이포 없음</p>
                )}
              </section>

              <section className="border-t border-line pt-3">
                <div className="flex items-baseline justify-between">
                  <span className="text-[13px] font-semibold text-ink">
                    만들 파일 {fileCount}개
                  </span>
                  <span className="text-[11px] text-faint">
                    캔버스 {outCanvasList.length} × 타이포 {outTypoList.length}
                  </span>
                </div>
                <div className={cn('mt-2', running && 'pointer-events-none opacity-50')}>
                  <CoverOutputFolder />
                </div>
                {reason && !running && !result && (
                  <p className="mt-2 text-[11px] text-danger">{reason}</p>
                )}
              </section>
            </div>

            <div className="shrink-0 border-t border-line p-3">
              {running && progress ? (
                <div>
                  <div className="h-1 overflow-hidden rounded-md bg-surface-2">
                    <div
                      className="h-full bg-mark transition-[width]"
                      style={{ width: percent + '%' }}
                    />
                  </div>
                  <div className="mt-1 flex items-center justify-between gap-2 text-[11px]">
                    <span className="shrink-0 tabular-nums text-muted">
                      조합 {progress.combo} / {progress.totalCombos} · 프레임 {progress.frame} /{' '}
                      {progress.totalFrames}
                    </span>
                  </div>
                  <div className="mt-0.5 truncate text-[11px] text-faint" title={progress.file}>
                    {progress.file}
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="lg"
                    className="mt-2 w-full"
                    onClick={() => (stopRef.current = true)}
                  >
                    그만하기
                  </Button>
                </div>
              ) : result ? (
                <div>
                  <p className="text-[13px] font-semibold text-ink">
                    {result.saved > 0
                      ? 'WEBP ' + result.saved + '개 저장했어요'
                      : '저장한 파일이 없어요'}
                  </p>
                  {result.stopped && (
                    <p className="mt-0.5 text-[11px] text-muted">중간에 멈췄어요.</p>
                  )}
                  {result.failed > 0 && (
                    <p className="mt-0.5 text-[11px] text-danger">
                      {result.failed}개는 만들지 못했어요
                      {result.firstError ? ': ' + result.firstError : ''}
                    </p>
                  )}
                  <div className="mt-2 flex gap-2">
                    <Button
                      type="button"
                      variant="default"
                      size="md"
                      className="flex-1"
                      onClick={() => void openOutput()}
                    >
                      폴더 열기
                    </Button>
                    <Button
                      type="button"
                      variant="accent"
                      size="md"
                      className="flex-1"
                      onClick={requestClose}
                    >
                      닫기
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex gap-2">
                  <Button type="button" variant="ghost" size="lg" onClick={requestClose}>
                    닫기
                  </Button>
                  <Button
                    type="button"
                    variant="accent"
                    size="lg"
                    className="flex-1"
                    disabled={!!reason}
                    onClick={() => void run()}
                  >
                    WEBP 만들기
                  </Button>
                </div>
              )}
            </div>
          </aside>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function PickerTile({
  bgId,
  name,
  index,
  places,
  tick,
  disabled,
  onClick
}: {
  bgId: string
  name: string
  index: number
  places: number[]
  tick: number
  disabled: boolean
  onClick: () => void
}): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    host.replaceChildren()
    const rendered = thumbCache.get(bgId)
    if (rendered) {
      rendered.style.maxWidth = '100%'
      rendered.style.maxHeight = '100%'
      rendered.style.objectFit = 'contain'
      host.append(rendered)
    }
  }, [bgId, tick])

  const badge = places.length > 2 ? places[0] + '+' + (places.length - 1) : places.join(',')

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      title={name}
      className={cn(
        'group relative flex flex-col gap-1 rounded-md border p-1.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50',
        places.length > 0
          ? 'border-accent bg-accent-soft'
          : 'border-line bg-surface hover:bg-surface-2'
      )}
    >
      <div
        ref={hostRef}
        className="flex h-[120px] w-full items-center justify-center overflow-hidden rounded-md bg-surface-2"
      />
      {places.length > 0 && (
        <span className="absolute right-2 top-2 grid min-w-5 place-items-center rounded-full bg-accent-fill px-1 text-[11px] font-semibold tabular-nums text-on-accent">
          {badge}
        </span>
      )}
      <span className="max-w-full truncate text-[11px] text-muted">
        {String(index + 1).padStart(2, '0')} {name}
      </span>
    </button>
  )
}

function FrameCard({
  bgId,
  index,
  count,
  durationMs,
  current,
  dragging,
  disabled,
  tick,
  onPick,
  onLeft,
  onRight,
  onRemove,
  onDuration,
  onDragStart,
  onDragEnd,
  onDrop
}: {
  bgId: string
  index: number
  count: number
  durationMs: number
  current: boolean
  dragging: boolean
  disabled: boolean
  tick: number
  onPick: () => void
  onLeft: () => void
  onRight: () => void
  onRemove: () => void
  onDuration: (ms: number) => void
  onDragStart: () => void
  onDragEnd: () => void
  onDrop: () => void
}): React.JSX.Element {
  return (
    <div
      draggable={!disabled}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData('text/plain', String(index))
        onDragStart()
      }}
      onDragEnd={onDragEnd}
      onDragOver={(e) => {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
      }}
      onDrop={(e) => {
        e.preventDefault()
        onDrop()
      }}
      className={cn(
        'w-[108px] shrink-0 rounded-md border p-1.5 transition-colors',
        current ? 'border-accent bg-accent-soft' : 'border-line bg-surface',
        dragging && 'opacity-50'
      )}
    >
      <button
        type="button"
        disabled={disabled}
        onClick={onPick}
        title="이 프레임 미리 보기"
        className="block w-full"
      >
        <FrameThumb bgId={bgId} tick={tick} />
      </button>
      <div className="mt-1 flex items-center gap-1">
        <span className="text-[11px] font-semibold tabular-nums text-muted">
          {String(index + 1).padStart(2, '0')}
        </span>
        <DurationInput ms={durationMs} disabled={disabled} onCommit={onDuration} />
        <span className="text-[11px] text-faint">초</span>
      </div>
      <div className="mt-1 flex items-center gap-0.5">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          disabled={disabled || index === 0}
          title="앞으로"
          onClick={onLeft}
        >
          <ArrowLeft size={12} />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          disabled={disabled || index === count - 1}
          title="뒤로"
          onClick={onRight}
        >
          <ArrowRight size={12} />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          disabled={disabled}
          title="빼기"
          onClick={onRemove}
        >
          <X size={12} />
        </Button>
      </div>
    </div>
  )
}

function FrameThumb({ bgId, tick }: { bgId: string; tick: number }): React.JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const source = thumbCache.get(bgId)
    if (!source) {
      canvas.width = 1
      canvas.height = 1
      return
    }
    const scale = Math.min(88 / source.width, 56 / source.height)
    canvas.width = Math.max(1, Math.round(source.width * scale))
    canvas.height = Math.max(1, Math.round(source.height * scale))
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height)
  }, [bgId, tick])
  return <canvas ref={ref} className="mx-auto max-h-14 max-w-full rounded-md bg-surface-2" />
}

function DurationInput({
  ms,
  disabled,
  onCommit
}: {
  ms: number
  disabled: boolean
  onCommit: (ms: number) => void
}): React.JSX.Element {
  const [text, setText] = useState(secText(ms))
  const [focused, setFocused] = useState(false)

  useEffect(() => {
    if (!focused) setText(secText(ms))
  }, [ms, focused])

  const commit = (): void => {
    const n = Number(text)
    if (!text.trim() || !Number.isFinite(n) || n < 0.01) {
      setText(secText(ms))
      return
    }
    const next = clampDuration(n * 1000)
    setText(secText(next))
    onCommit(next)
  }

  return (
    <Input
      type="number"
      min="0.01"
      step="0.1"
      value={text}
      disabled={disabled}
      onFocus={() => setFocused(true)}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        setFocused(false)
        commit()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          e.currentTarget.blur()
        }
      }}
      className="h-7 w-[54px] px-1 text-center text-[11px] tabular-nums"
      aria-label="프레임 시간(초)"
    />
  )
}

function WebpCanvasChip({
  canvas,
  on,
  disabled,
  onClick
}: {
  canvas: CoverCanvas
  on: boolean
  disabled: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={on}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex h-10 flex-col items-start justify-center rounded-md border px-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50',
        on
          ? 'border-accent bg-accent-soft text-accent'
          : 'border-line bg-surface-2 text-muted hover:text-ink'
      )}
    >
      <span className="text-[12px] font-semibold leading-tight">
        {canvas.ratio} {canvas.label}
      </span>
      <span className={cn('text-[11px] leading-tight', on ? 'text-accent' : 'text-faint')}>
        {canvas.w}×{canvas.h}
      </span>
    </button>
  )
}
