import { Download, Film, FolderOpen, Hand, Move, Paintbrush, Redo2, Undo2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { activeLayerId, COVER_CANVASES, findLayer, type CoverCanvasId } from '@shared/cover'
import { useCoverStore } from '../../stores/cover-store'
import { useLayoutStore } from '../../stores/layout-store'
import { Button } from '../ui/button'
import { Segmented, SegmentedItem } from '../ui/segmented'
import { CoverExportDialog } from './cover-export-dialog'
import { CoverInspector } from './cover-inspector'
import { CoverMaterials } from './cover-materials'
import { CoverPreviewStrip } from './cover-preview-strip'
import { CoverProjectPicker } from './cover-project-picker'
import { CoverWebpDialog } from './cover-webp-dialog'
import { createCoverEditor } from './engine/editor'
import { toEditorBrush, type CoverMode } from './engine/types'

/**
 * 표지 탭. 배경 N장 × 타이포 M장 × 캔버스 4종(바베·에덴·젠잇·알플)을 한 번에 출력한다.
 * 왼쪽 재료 · 가운데 편집기와 미리보기 · 오른쪽 설정.
 */
export function CoverView(): React.JSX.Element {
  const visible = useLayoutStore((s) => s.centerMode === 'cover')
  const ready = useCoverStore((s) => s.ready)
  const project = useCoverStore((s) => s.project)
  useCoverStore((s) => s.rev)
  const outputDir = useCoverStore((s) => s.outputDir)
  const [exportOpen, setExportOpen] = useState(false)
  const [webpOpen, setWebpOpen] = useState(false)

  useEffect(() => {
    void useCoverStore.getState().init()
  }, [])
  // 다른 탭으로 갈 때 저장을 미루지 않는다
  useEffect(() => {
    if (!visible) void useCoverStore.getState().flush()
  }, [visible])

  // Ctrl+Z 되돌리기 · Ctrl+Shift+Z / Ctrl+Y 다시 하기 (글자 입력 중이나 창이 떠 있을 땐 그쪽에 맡김)
  useEffect(() => {
    if (!visible) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || e.altKey || !(e.ctrlKey || e.metaKey)) return
      const isZ = e.code === 'KeyZ'
      const isY = e.code === 'KeyY'
      if (!isZ && !isY) return
      const t = e.target as HTMLElement | null
      if (t?.closest('input, textarea, select, [contenteditable="true"]')) return
      if (document.querySelector('[role="dialog"]')) return
      e.preventDefault()
      if (isZ && !e.shiftKey) coverUndo()
      else coverRedo()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [visible])

  const bgCount = project?.backgrounds.length ?? 0
  const typoCount = project?.typos.length ?? 0
  const pngCount = bgCount * typoCount * COVER_CANVASES.length

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-surface">
      <div className="flex h-[60px] shrink-0 items-center gap-3 px-5">
        <h1 className="shrink-0 text-[20px] font-bold tracking-tight text-ink">표지</h1>
        <CoverProjectPicker />
        <div className="flex-1" />
        {outputDir && (
          <Button
            variant="ghost"
            size="icon"
            className="no-drag"
            title={'출력 폴더 열기 · ' + outputDir}
            onClick={() => void window.nais.invoke('cover:openOutput', {})}
          >
            <FolderOpen size={16} />
          </Button>
        )}
        <Button
          variant="tint"
          className="no-drag"
          disabled={!bgCount}
          title={bgCount ? undefined : '배경 그림을 먼저 넣어 주세요'}
          onClick={() => setWebpOpen(true)}
        >
          <Film size={15} /> 움직이는 WEBP
        </Button>
        <Button
          variant="accent"
          className="no-drag"
          disabled={!bgCount || !typoCount}
          title={
            !bgCount
              ? '배경 그림을 먼저 넣어 주세요'
              : !typoCount
                ? '타이포를 먼저 넣어 주세요'
                : undefined
          }
          onClick={() => setExportOpen(true)}
        >
          <Download size={15} /> PNG 저장
          {pngCount > 0 && (
            <span className="rounded-full bg-white/20 px-1.5 text-[11px] tabular-nums">
              {pngCount}
            </span>
          )}
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 gap-4 px-5 pb-5">
        <CoverMaterials />
        <div className="@container flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl bg-paper">
          <Toolbar />
          <Stage visible={visible} />
          {ready && <CoverPreviewStrip />}
        </div>
        <CoverInspector />
      </div>
      <CoverExportDialog open={exportOpen} onOpenChange={setExportOpen} />
      <CoverWebpDialog open={webpOpen} onOpenChange={setWebpOpen} />
    </div>
  )
}

const MODES: { id: CoverMode; label: string; icon: typeof Move; hint: string }[] = [
  {
    id: 'typo',
    label: '타이포 배치',
    icon: Move,
    hint: '타이포를 끌어 옮기고 손잡이로 크기를 맞춰요'
  },
  { id: 'pan', label: '배경 위치', icon: Hand, hint: '그림을 끌어 보이는 부분을 고르세요' },
  { id: 'censor', label: '검열', icon: Paintbrush, hint: '칠한 부분은 모든 캔버스에 같이 들어가요' }
]

/** 검열 모드에선 붓질, 나머지 모드에선 배치·배경 위치·액자를 되돌린다 */
function coverUndo(): void {
  const s = useCoverStore.getState()
  if (s.mode === 'censor') void s.editor?.undo()
  else s.undo()
}
function coverRedo(): void {
  const s = useCoverStore.getState()
  if (s.mode === 'censor') void s.editor?.redo()
  else s.redo()
}

function Toolbar(): React.JSX.Element {
  const project = useCoverStore((s) => s.project)
  useCoverStore((s) => s.rev)
  const mode = useCoverStore((s) => s.mode)
  const canUndo = useCoverStore((s) => (s.mode === 'censor' ? s.history.canUndo : s.canUndo))
  const canRedo = useCoverStore((s) => (s.mode === 'censor' ? s.history.canRedo : s.canRedo))
  const canvasId = project?.selection.canvasId ?? '1x1'
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2.5">
      <Segmented
        value={canvasId}
        onValueChange={(v) =>
          v && useCoverStore.getState().select({ canvasId: v as CoverCanvasId })
        }
        aria-label="캔버스 크기"
      >
        {COVER_CANVASES.map((c) => (
          <SegmentedItem key={c.id} value={c.id} title={c.w + '×' + c.h}>
            <span className="tabular-nums">{c.ratio}</span>
            <span className="hidden @[560px]:inline">{c.label}</span>
            <span className="hidden text-[11px] font-normal tabular-nums text-faint @[900px]:inline">
              {c.w}×{c.h}
            </span>
          </SegmentedItem>
        ))}
      </Segmented>
      <div className="flex-1" />
      <div className="flex shrink-0 items-center">
        <Button
          variant="ghost"
          size="icon"
          disabled={!canUndo}
          onClick={coverUndo}
          title={(mode === 'censor' ? '붓질 되돌리기' : '되돌리기') + ' (Ctrl+Z)'}
          aria-label="되돌리기"
        >
          <Undo2 size={15} />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          disabled={!canRedo}
          onClick={coverRedo}
          title={(mode === 'censor' ? '붓질 다시 하기' : '다시 하기') + ' (Ctrl+Shift+Z)'}
          aria-label="다시 하기"
        >
          <Redo2 size={15} />
        </Button>
      </div>
      <Segmented
        value={mode}
        onValueChange={(v) => v && useCoverStore.getState().setMode(v as CoverMode)}
        aria-label="편집 모드"
      >
        {MODES.map((m) => (
          <SegmentedItem key={m.id} value={m.id} title={m.label + ' · ' + m.hint}>
            <m.icon size={13} />
            <span className="hidden @[680px]:inline">{m.label}</span>
          </SegmentedItem>
        ))}
      </Segmented>
    </div>
  )
}

/** 편집기 무대. 편집기는 한 번만 만들고 대상·모드·붓만 바꿔 준다 */
function Stage({ visible }: { visible: boolean }): React.JSX.Element {
  const boxRef = useRef<HTMLDivElement>(null)
  const project = useCoverStore((s) => s.project)
  const editor = useCoverStore((s) => s.editor)
  const mode = useCoverStore((s) => s.mode)
  const brush = useCoverStore((s) => s.brush)
  useCoverStore((s) => s.rev)
  const sel = project?.selection
  const active = project ? activeLayerId(project) : null
  const target = sel ? sel.canvasId + '|' + sel.bgId + '|' + active : ''

  useEffect(() => {
    const box = boxRef.current
    if (!box) return
    const st = useCoverStore.getState()
    const api = createCoverEditor(box, {
      getProject: () => useCoverStore.getState().project,
      onChange: (kind) => useCoverStore.getState().touch(kind),
      onHistory: (h) => useCoverStore.getState().setHistory(h),
      onSelectLayer: (id) => {
        const st = useCoverStore.getState()
        const found = st.project ? findLayer(st.project, id) : null
        if (!found) return
        st.select({
          typoId: found.typo.id,
          layerId: found.item.id === found.typo.id ? null : found.item.id
        })
      }
    })
    api.setMode(st.mode)
    api.setBrush(toEditorBrush(st.brush))
    st.setEditor(api)
    return () => {
      useCoverStore.getState().setEditor(null)
      api.destroy()
    }
  }, [])

  useEffect(() => {
    if (!editor || !project) return
    const s = project.selection
    void editor.show({ canvasId: s.canvasId, bgId: s.bgId, typoId: activeLayerId(project) })
    // 프로젝트를 바꾸면 대상이 같아 보여도 새로 그린다
  }, [editor, project, target])

  useEffect(() => {
    editor?.setMode(mode)
  }, [editor, mode])

  useEffect(() => {
    editor?.setBrush(toEditorBrush(brush))
  }, [editor, brush])

  // 숨어 있던 동안 바뀐 것이 있을 수 있다
  useEffect(() => {
    if (visible) void editor?.refresh()
  }, [visible, editor])

  return <div ref={boxRef} className="relative min-h-0 flex-1 overflow-hidden bg-surface-2" />
}
