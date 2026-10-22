import { ChevronDown, ChevronUp } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { getCoverCanvas } from '@shared/cover'
import { cn } from '../../lib/utils'
import { useCoverStore } from '../../stores/cover-store'
import { renderCoverCanvas } from './engine/render'

const COLLAPSE_KEY = 'nais3.cover.previewCollapsed'
const THUMB = 104

/**
 * 편집기 아래 미리보기 줄: 지금 캔버스로 만들어질 표지 전부 (배경 순서 × 타이포).
 * 누르면 그 배경·타이포로 편집기가 바뀐다. 내용이 바뀌면 250ms 뒤 한 장씩 다시 그린다.
 */
export function CoverPreviewStrip(): React.JSX.Element | null {
  const project = useCoverStore((s) => s.project)
  useCoverStore((s) => s.rev)
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSE_KEY) === '1')
  const [urls, setUrls] = useState<Record<string, string>>({})
  const urlsRef = useRef<Record<string, string>>({})

  const canvas = getCoverCanvas(project?.selection.canvasId) ?? null
  // 선택·이름만 바뀐 것은 다시 그릴 이유가 없다
  const signature = project
    ? JSON.stringify([
        project.id,
        project.selection.canvasId,
        project.backgrounds.map((b) => [b.id, b.blobKey, b.maskKey]),
        project.typos.map((t) => [t.id, t.blobKey]),
        project.frame,
        project.frameImages,
        project.placements,
        project.pans
      ])
    : ''
  const names = project
    ? JSON.stringify(project.typos.map((t) => t.name)) + project.backgrounds.length
    : ''
  const cells = useMemo(() => {
    if (!project) return []
    const typos = project.typos.length ? project.typos : [null]
    return project.backgrounds.flatMap((bg, i) =>
      typos.map((t) => ({ key: bg.id + '|' + (t?.id ?? ''), bg, bgIndex: i, typo: t }))
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, names])

  useEffect(() => {
    if (collapsed || !project || !canvas || !cells.length) return
    let cancelled = false
    const timer = window.setTimeout(async () => {
      const scale = THUMB / Math.max(canvas.w, canvas.h)
      for (const c of cells) {
        if (cancelled) return
        try {
          const cv = await renderCoverCanvas(project, c.bg.id, c.typo?.id ?? null, canvas.id, scale)
          const blob = await new Promise<Blob | null>((r) => cv.toBlob(r, 'image/png'))
          if (cancelled || !blob) return
          const url = URL.createObjectURL(blob)
          const old = urlsRef.current[c.key]
          urlsRef.current = { ...urlsRef.current, [c.key]: url }
          setUrls(urlsRef.current)
          if (old) URL.revokeObjectURL(old)
        } catch {
          // 한 장이 실패해도 나머지는 그린다
        }
        await new Promise((r) => window.setTimeout(r, 0))
      }
    }, 250)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, collapsed])

  // 빠진 칸의 주소 정리 + 화면이 사라질 때 전부 정리
  useEffect(() => {
    const keep = new Set(cells.map((c) => c.key))
    const next: Record<string, string> = {}
    for (const [k, u] of Object.entries(urlsRef.current)) {
      if (keep.has(k)) next[k] = u
      else URL.revokeObjectURL(u)
    }
    urlsRef.current = next
    setUrls(next)
  }, [cells])
  useEffect(
    () => () => {
      for (const u of Object.values(urlsRef.current)) URL.revokeObjectURL(u)
    },
    []
  )

  if (!project || !canvas) return null
  const sel = project.selection
  const toggle = (): void => {
    const v = !collapsed
    setCollapsed(v)
    localStorage.setItem(COLLAPSE_KEY, v ? '1' : '0')
  }
  const thumbW = canvas.w >= canvas.h ? THUMB : Math.round((THUMB * canvas.w) / canvas.h)
  const thumbH = canvas.h >= canvas.w ? THUMB : Math.round((THUMB * canvas.h) / canvas.w)

  return (
    <div className="shrink-0 border-t border-line">
      <button
        onClick={toggle}
        className="flex h-9 w-full items-center gap-2 px-3 text-left text-[12px] text-muted hover:text-ink"
      >
        <span className="font-semibold text-ink">미리보기</span>
        <span className="tabular-nums text-faint">
          {canvas.ratio} {canvas.label} · {project.backgrounds.length}×
          {Math.max(1, project.typos.length)}장
        </span>
        <span className="flex-1" />
        {collapsed ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </button>
      {!collapsed && (
        <div className="flex gap-2 overflow-x-auto px-3 pb-3 no-scrollbar">
          {!cells.length && (
            <div className="flex h-[104px] w-full items-center justify-center text-[12px] text-faint">
              배경을 넣으면 여기서 결과를 한눈에 볼 수 있어요
            </div>
          )}
          {cells.map((c) => {
            const active = sel.bgId === c.bg.id && (c.typo ? sel.typoId === c.typo.id : true)
            return (
              <button
                key={c.key}
                onClick={() =>
                  useCoverStore
                    .getState()
                    .select({ bgId: c.bg.id, ...(c.typo ? { typoId: c.typo.id } : {}) })
                }
                className="group flex shrink-0 flex-col items-center gap-1"
                title={(c.typo ? c.typo.name + ' · ' : '') + c.bg.name}
              >
                <div
                  className={cn(
                    'overflow-hidden rounded-md bg-surface-2 ring-offset-2 ring-offset-paper transition-shadow',
                    active ? 'ring-2 ring-accent' : 'group-hover:ring-1 group-hover:ring-line'
                  )}
                  style={{ width: thumbW, height: thumbH }}
                >
                  {urls[c.key] && (
                    <img src={urls[c.key]} alt="" draggable={false} className="size-full" />
                  )}
                </div>
                <span
                  className={cn(
                    'max-w-[104px] truncate text-[11px] tabular-nums',
                    active ? 'font-semibold text-accent' : 'text-faint'
                  )}
                >
                  {String(c.bgIndex + 1).padStart(2, '0')}
                  {c.typo ? ' · ' + c.typo.name : ''}
                </span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
