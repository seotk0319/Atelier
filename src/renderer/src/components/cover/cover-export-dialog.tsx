import { useEffect, useRef, useState } from 'react'
import {
  COVER_CANVASES,
  coverFolderName,
  coverPngName,
  duplicateTypoNames,
  type CoverCanvas,
  type CoverCanvasId
} from '@shared/cover'
import { cn } from '../../lib/utils'
import { useCoverStore } from '../../stores/cover-store'
import { Button } from '../ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '../ui/dialog'
import { renderCoverBlob } from './engine/render'
import { CoverOutputFolder } from './cover-output-folder'

type ExportResult = {
  saved: number
  failed: number
  firstError: string | null
  stopped: boolean
}

const ALL_CANVASES = (): Set<CoverCanvasId> => new Set(COVER_CANVASES.map((canvas) => canvas.id))

/** 표지 PNG 일괄 출력 창 */
export function CoverExportDialog({
  open,
  onOpenChange
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
}): React.JSX.Element {
  const project = useCoverStore((s) => s.project)
  const outputDir = useCoverStore((s) => s.outputDir)
  const refreshOutputDir = useCoverStore((s) => s.refreshOutputDir)

  const [canvases, setCanvases] = useState<Set<CoverCanvasId>>(ALL_CANVASES)
  const [typos, setTypos] = useState<Set<string>>(new Set())
  const [running, setRunning] = useState(false)
  const [done, setDone] = useState(0)
  const [total, setTotal] = useState(0)
  const [currentFile, setCurrentFile] = useState('')
  const [result, setResult] = useState<ExportResult | null>(null)
  const runningRef = useRef(false)
  const stopRef = useRef(false)

  useEffect(() => {
    if (!open) return
    setCanvases(ALL_CANVASES())
    setTypos(new Set(project?.typos.map((t) => t.id) ?? []))
    setDone(0)
    setTotal(0)
    setCurrentFile('')
    setResult(null)
    void refreshOutputDir()
    // 창을 열 때마다 재료 전체를 기본으로 고른다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const canvasList = COVER_CANVASES.filter((canvas) => canvases.has(canvas.id))
  const typoList = (project?.typos ?? []).filter((typo) => typos.has(typo.id))
  const backgroundCount = project?.backgrounds.length ?? 0
  const count = backgroundCount * canvasList.length * typoList.length

  const reason = !project
    ? '작품을 먼저 열어 주세요'
    : backgroundCount === 0
      ? '배경을 먼저 넣어 주세요'
      : canvasList.length === 0
        ? '캔버스를 하나 이상 골라 주세요'
        : typoList.length === 0
          ? '타이포를 하나 이상 골라 주세요'
          : !outputDir
            ? '저장할 폴더를 골라 주세요'
            : count === 0
              ? '출력할 장이 없어요'
              : ''

  const firstCanvas = canvasList[0]
  const firstTypo = typoList[0]
  const example =
    project && firstCanvas && firstTypo
      ? coverFolderName(firstCanvas) + '/' + coverPngName(project.name, 0, firstTypo.name)
      : ''
  const duplicates = project ? duplicateTypoNames(project.typos) : []

  const toggleCanvas = (id: CoverCanvasId): void => {
    setCanvases((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
    setResult(null)
  }

  const toggleTypo = (id: string): void => {
    setTypos((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
    setResult(null)
  }

  const run = async (): Promise<void> => {
    if (runningRef.current || reason) return
    const current = useCoverStore.getState().project
    if (!current) return
    const jobs = COVER_CANVASES.filter((canvas) => canvases.has(canvas.id))
    const jobTypos = current.typos.filter((typo) => typos.has(typo.id))
    const all = current.backgrounds.length * jobs.length * jobTypos.length
    if (!all) return

    runningRef.current = true
    stopRef.current = false
    setRunning(true)
    setResult(null)
    setDone(0)
    setTotal(all)
    setCurrentFile('')

    let saved = 0
    let failed = 0
    let firstError: string | null = null
    let stopped = false
    let attempted = 0

    try {
      for (const canvas of jobs) {
        for (let i = 0; i < current.backgrounds.length; i++) {
          for (const typo of jobTypos) {
            if (stopRef.current) {
              stopped = true
              break
            }
            const folder = coverFolderName(canvas)
            const file = coverPngName(current.name, i, typo.name)
            setCurrentFile(file)
            try {
              const blob = await renderCoverBlob(
                current,
                current.backgrounds[i].id,
                typo.id,
                canvas.id
              )
              const bytes = new Uint8Array(await blob.arrayBuffer())
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
            attempted++
            setDone(attempted)
            await new Promise((resolve) => setTimeout(resolve, 0))
          }
          if (stopped) break
        }
        if (stopped) break
      }
    } finally {
      runningRef.current = false
      setRunning(false)
      setResult({ saved, failed, firstError, stopped })
    }
  }

  const openOutput = async (): Promise<void> => {
    const one = canvasList.length === 1 ? canvasList[0] : null
    await window.nais.invoke('cover:openOutput', one ? { folder: coverFolderName(one) } : {})
  }

  const requestClose = (): void => {
    if (runningRef.current) return
    onOpenChange(false)
  }

  const percent = total > 0 ? Math.round((done / total) * 100) : 0

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v && runningRef.current) return
        onOpenChange(v)
      }}
    >
      <DialogContent
        className="flex max-h-[calc(100vh-4rem)] max-w-[520px] flex-col p-0"
        onInteractOutside={(e) => {
          if (runningRef.current) e.preventDefault()
        }}
        onEscapeKeyDown={(e) => {
          if (runningRef.current) e.preventDefault()
        }}
      >
        <div className="shrink-0 px-5 pb-3 pr-10 pt-4">
          <DialogTitle>PNG 저장</DialogTitle>
          <DialogDescription>캔버스별 폴더에 한 번에 저장해요.</DialogDescription>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-4">
          <div className="mb-1.5 text-[12px] font-semibold text-muted">캔버스</div>
          <div className="grid grid-cols-2 gap-1.5">
            {COVER_CANVASES.map((canvas) => {
              const on = canvases.has(canvas.id)
              return (
                <CanvasChip
                  key={canvas.id}
                  canvas={canvas}
                  on={on}
                  disabled={running}
                  onClick={() => toggleCanvas(canvas.id)}
                />
              )
            })}
          </div>

          <div className="mb-1.5 mt-4 text-[12px] font-semibold text-muted">타이포</div>
          {project && project.typos.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {project.typos.map((typo) => {
                const on = typos.has(typo.id)
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

          <div className="mt-4 rounded-lg bg-surface-2 px-3 py-2.5">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span className="text-[20px] font-bold tabular-nums text-ink">{count}장</span>
              <span className="text-[12px] text-muted">
                배경 {backgroundCount} × 타이포 {typoList.length} × 캔버스 {canvasList.length}
              </span>
            </div>
            {example && (
              <div className="mt-1.5 truncate text-[11px] text-faint" title={example}>
                {example}
              </div>
            )}
          </div>

          <div className={cn('mt-3', running && 'pointer-events-none opacity-50')}>
            <CoverOutputFolder />
          </div>

          {duplicates.length > 0 && (
            <p className="mt-2 text-[11px] text-danger">
              이름이 같은 타이포가 있어 파일이 덮어써져요
            </p>
          )}
          <p className="mt-2 text-[11px] text-faint">같은 이름의 파일은 덮어써요.</p>

          {running && (
            <div className="mt-3">
              <div className="h-1 overflow-hidden rounded-md bg-surface-2">
                <div
                  className="h-full bg-mark transition-[width]"
                  style={{ width: percent + '%' }}
                />
              </div>
              <div className="mt-1 flex items-center justify-between gap-2 text-[11px]">
                <span className="shrink-0 tabular-nums text-muted">
                  {done} / {total}
                </span>
                <span className="min-w-0 truncate text-faint" title={currentFile}>
                  {currentFile}
                </span>
              </div>
            </div>
          )}

          {result && (
            <div className="mt-3 rounded-lg bg-surface-2 px-3 py-2.5">
              <p className="text-[13px] font-semibold text-ink">
                {result.saved > 0 ? result.saved + '장 저장했어요' : '저장한 장이 없어요'}
              </p>
              {result.stopped && <p className="mt-1 text-[11px] text-muted">중간에 멈췄어요.</p>}
              {result.failed > 0 && (
                <p className="mt-1 text-[11px] text-danger">
                  {result.failed}장은 저장하지 못했어요
                  {result.firstError ? ': ' + result.firstError : ''}
                </p>
              )}
            </div>
          )}

          {!running && !result && reason && (
            <p className="mt-3 text-[11px] text-danger">{reason}</p>
          )}
        </div>

        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-line px-5 py-3">
          {running ? (
            <Button type="button" variant="outline" onClick={() => (stopRef.current = true)}>
              그만하기
            </Button>
          ) : result ? (
            <>
              <Button type="button" variant="default" onClick={() => void openOutput()}>
                폴더 열기
              </Button>
              <Button type="button" variant="accent" onClick={requestClose}>
                닫기
              </Button>
            </>
          ) : (
            <>
              <Button type="button" variant="ghost" onClick={requestClose}>
                닫기
              </Button>
              <Button
                type="button"
                variant="accent"
                size="lg"
                disabled={!!reason}
                onClick={() => void run()}
              >
                PNG 저장하기
              </Button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function CanvasChip({
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
        'flex h-10 flex-col items-start justify-center rounded-md border px-2.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/40 disabled:opacity-50',
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
