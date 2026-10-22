import { Check, ChevronDown, Pencil, Plus, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { cn } from '../../lib/utils'
import { useCoverStore } from '../../stores/cover-store'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'

function ago(ms: number): string {
  const d = Date.now() - ms
  if (d < 60_000) return '방금'
  if (d < 3_600_000) return Math.floor(d / 60_000) + '분 전'
  if (d < 86_400_000) return Math.floor(d / 3_600_000) + '시간 전'
  return new Date(ms).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' })
}

/** 상단 작품 고르기. 이름 바꾸기·삭제·새 작품도 여기서 */
export function CoverProjectPicker(): React.JSX.Element {
  const project = useCoverStore((s) => s.project)
  const projects = useCoverStore((s) => s.projects)
  const saveState = useCoverStore((s) => s.saveState)
  useCoverStore((s) => s.rev)
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [confirmDel, setConfirmDel] = useState<string | null>(null)

  useEffect(() => {
    if (!confirmDel) return
    const t = window.setTimeout(() => setConfirmDel(null), 2500)
    return () => window.clearTimeout(t)
  }, [confirmDel])

  return (
    <div className="no-drag flex min-w-0 items-center gap-2">
      <Popover
        open={open}
        onOpenChange={(v) => {
          setOpen(v)
          if (!v) {
            setEditing(null)
            setConfirmDel(null)
          }
        }}
      >
        <PopoverTrigger asChild>
          <button className="flex h-8 min-w-0 max-w-[260px] items-center gap-1.5 rounded-lg bg-paper px-3 text-[13px] font-semibold text-ink transition-colors hover:bg-surface-2">
            <span className="truncate">{project?.name || '이름 없는 작품'}</span>
            <ChevronDown size={14} className="shrink-0 text-muted" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[320px] p-1.5">
          <div className="px-2 pb-1.5 pt-1 text-[11px] font-semibold text-faint">작품</div>
          <div className="max-h-[360px] overflow-y-auto no-scrollbar">
            {projects.map((it) => {
              const current = it.id === project?.id
              if (editing === it.id) {
                return (
                  <RenameRow
                    key={it.id}
                    initial={it.name}
                    onDone={(name) => {
                      setEditing(null)
                      if (name === null) return
                      if (current) useCoverStore.getState().renameProject(name)
                    }}
                  />
                )
              }
              return (
                <div
                  key={it.id}
                  className={cn(
                    'group flex h-12 cursor-pointer items-center gap-2 rounded-md px-2 hover:bg-surface-2',
                    current && 'bg-surface-2'
                  )}
                  onClick={() => {
                    setOpen(false)
                    void useCoverStore.getState().openProject(it.id)
                  }}
                >
                  <Check
                    size={14}
                    className={cn('shrink-0 text-accent', !current && 'invisible')}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium text-ink">
                      {it.name || '이름 없는 작품'}
                    </div>
                    <div className="text-[11px] tabular-nums text-faint">
                      배경 {it.backgrounds} · 타이포 {it.typos} · {ago(it.updatedAt)}
                    </div>
                  </div>
                  {current && (
                    <button
                      title="이름 바꾸기"
                      className="grid size-7 place-items-center rounded-md text-muted opacity-0 hover:bg-surface hover:text-ink group-hover:opacity-100"
                      onClick={(e) => {
                        e.stopPropagation()
                        setEditing(it.id)
                      }}
                    >
                      <Pencil size={13} />
                    </button>
                  )}
                  <button
                    title={confirmDel === it.id ? '한 번 더 누르면 삭제돼요' : '삭제'}
                    className={cn(
                      'flex h-7 items-center gap-1 rounded-md px-1.5 text-[12px] font-semibold opacity-0 group-hover:opacity-100',
                      confirmDel === it.id
                        ? 'bg-danger/10 text-danger opacity-100'
                        : 'text-muted hover:bg-surface hover:text-danger'
                    )}
                    onClick={(e) => {
                      e.stopPropagation()
                      if (confirmDel !== it.id) return setConfirmDel(it.id)
                      setConfirmDel(null)
                      void useCoverStore.getState().deleteProject(it.id)
                    }}
                  >
                    <Trash2 size={13} />
                    {confirmDel === it.id && '삭제'}
                  </button>
                </div>
              )
            })}
          </div>
          <div className="mt-1 border-t border-line pt-1">
            <button
              className="flex h-9 w-full items-center gap-2 rounded-md px-2 text-[13px] font-medium text-accent hover:bg-surface-2"
              onClick={() => {
                void useCoverStore
                  .getState()
                  .createProject('새 작품')
                  .then(() => setEditing(useCoverStore.getState().project?.id ?? null))
              }}
            >
              <Plus size={14} /> 새 작품
            </button>
          </div>
        </PopoverContent>
      </Popover>
      <span className="shrink-0 text-[11px] text-faint" aria-live="polite">
        {saveState === 'saving' ? '저장 중…' : saveState === 'error' ? '저장 실패' : ''}
      </span>
    </div>
  )
}

function RenameRow({
  initial,
  onDone
}: {
  initial: string
  onDone: (name: string | null) => void
}): React.JSX.Element {
  const ref = useRef<HTMLInputElement>(null)
  const [v, setV] = useState(initial)
  const done = useRef(false)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  const finish = (name: string | null): void => {
    if (done.current) return
    done.current = true
    onDone(name)
  }
  return (
    <div className="flex h-12 items-center px-2">
      <input
        ref={ref}
        value={v}
        maxLength={80}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') finish(v.trim() || initial)
          if (e.key === 'Escape') finish(null)
        }}
        onBlur={() => finish(v.trim() || initial)}
        className="h-8 w-full rounded-md border border-accent/50 bg-paper px-2.5 text-[13px] text-ink outline-none"
        placeholder="작품 이름 (파일 이름 앞에 붙어요)"
      />
    </div>
  )
}
