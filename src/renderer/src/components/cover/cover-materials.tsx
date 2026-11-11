import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  ImagePlus,
  Loader2,
  Plus,
  TextQuote,
  Trash2,
  Type
} from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { cleanCoverName, duplicateTypoNames, type CoverItem, type CoverKind } from '@shared/cover'
import { droppedImagePaths, hasImageDrop } from '../../lib/image-drag'
import { cn } from '../../lib/utils'
import { useCoverStore } from '../../stores/cover-store'
import { Button } from '../ui/button'
import { readArchiveDrag } from './archive-drag'
import { useBlobThumb } from './cover-thumbs'

const ITEM_MIME = 'application/x-nais3-cover-item'
const CHECKER: React.CSSProperties = {
  backgroundImage:
    'repeating-conic-gradient(rgba(148, 163, 184, 0.35) 0% 25%, transparent 0% 25% 50%)',
  backgroundSize: '8px 8px'
}

type DraggedItem = { kind: CoverKind; id: string }

interface SectionSpec {
  kind: CoverKind
  title: string
  emptyTitle: string
  dropLabel: string
}

const SECTIONS: readonly SectionSpec[] = [
  {
    kind: 'backgrounds',
    title: '배경 그림',
    emptyTitle: '배경 그림을 끌어다 놓으세요',
    dropLabel: '여기에 놓으면 배경으로 들어가요'
  },
  {
    kind: 'typos',
    title: '타이포',
    emptyTitle: '투명 PNG 타이포를 끌어다 놓으세요',
    dropLabel: '타이포로 들어가요'
  }
]

export function CoverMaterials(): React.JSX.Element {
  useCoverStore((s) => s.rev)
  const project = useCoverStore((s) => s.project)
  const importing = useCoverStore((s) => s.importing)
  const [dragged, setDragged] = useState<DraggedItem | null>(null)

  if (!project) {
    return <aside className="flex w-[268px] shrink-0 flex-col rounded-xl bg-paper" />
  }

  const duplicates = new Set(duplicateTypoNames(project.typos))

  return (
    <aside className="flex w-[268px] shrink-0 flex-col rounded-xl bg-paper">
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-2 pt-2 no-scrollbar">
        {SECTIONS.map((spec) => (
          <MaterialsSection
            key={spec.kind}
            spec={spec}
            items={project[spec.kind]}
            selectedId={
              spec.kind === 'backgrounds' ? project.selection.bgId : project.selection.typoId
            }
            importing={importing}
            duplicates={duplicates}
            dragged={dragged}
            onDragStart={setDragged}
            onDragEnd={() => setDragged(null)}
          />
        ))}
      </div>
      <p className="border-t border-line px-3 py-2.5 text-[11px] leading-relaxed text-faint">
        타이포 이름이 파일 이름 끝에 붙어요 (예: ko, en)
      </p>
    </aside>
  )
}

function MaterialsSection({
  spec,
  items,
  selectedId,
  importing,
  duplicates,
  dragged,
  onDragStart,
  onDragEnd
}: {
  spec: SectionSpec
  items: CoverItem[]
  selectedId: string | null
  importing: number
  duplicates: Set<string>
  dragged: DraggedItem | null
  onDragStart: (value: DraggedItem) => void
  onDragEnd: () => void
}): React.JSX.Element {
  const fileRef = useRef<HTMLInputElement>(null)
  const dropIndexRef = useRef<number | null>(null)
  const [over, setOver] = useState(false)
  const [dropIndex, setDropIndex] = useState<number | null>(null)
  const kind = spec.kind
  const layerId = useCoverStore((s) => s.project?.selection.layerId ?? null)

  const setDrop = (index: number | null): void => {
    dropIndexRef.current = index
    setDropIndex(index)
  }

  const addFiles = (files: File[]): void => {
    const images = files.filter((file) => file.type.startsWith('image/'))
    if (images.length) void useCoverStore.getState().addFiles(kind, images)
  }

  const onDragOver = (e: React.DragEvent): void => {
    if (dragged && dragged.kind === kind) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      if (dropIndexRef.current === null) setDrop(items.length)
      return
    }
    if (!hasImageDrop(e)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    setOver(true)
  }

  const onDragLeave = (e: React.DragEvent): void => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
    setOver(false)
    setDrop(null)
  }

  const onDrop = (e: React.DragEvent): void => {
    e.preventDefault()
    setOver(false)
    if (dragged && dragged.kind === kind) {
      const from = items.findIndex((item) => item.id === dragged.id)
      let to = dropIndexRef.current ?? items.length
      if (from >= 0 && from < to) to -= 1
      if (from >= 0) useCoverStore.getState().reorderItem(kind, dragged.id, to)
      setDrop(null)
      return
    }
    const archived = readArchiveDrag(e)
    if (archived) {
      void useCoverStore.getState().addFromArchive(archived, kind)
      return
    }
    const paths = droppedImagePaths(e)
    if (paths.length) {
      void useCoverStore.getState().addPaths(kind, paths)
      return
    }
    addFiles(Array.from(e.dataTransfer.files))
  }

  return (
    <section
      className={cn('relative mt-3 rounded-lg first:mt-0', over && 'ring-1 ring-accent')}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="flex h-8 items-center gap-1.5 px-1">
        <h2 className="text-[13px] font-semibold text-ink">{spec.title}</h2>
        <span className="text-[11px] tabular-nums text-faint">{items.length}</span>
        {importing > 0 && <Loader2 size={12} className="animate-spin text-faint" />}
        <div className="flex-1" />
        <Button
          variant="ghost"
          size="icon-sm"
          title={spec.title + ' 추가'}
          aria-label={spec.title + ' 추가'}
          onClick={() => fileRef.current?.click()}
        >
          <Plus size={14} />
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => {
            addFiles(Array.from(e.target.files ?? []))
            e.target.value = ''
          }}
        />
      </div>

      {items.length === 0 ? (
        <button
          onClick={() => fileRef.current?.click()}
          className="flex min-h-[116px] w-full flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-line px-3 text-center transition-colors hover:bg-surface"
        >
          {kind === 'backgrounds' ? (
            <ImagePlus size={20} className="text-faint" />
          ) : (
            <Type size={20} className="text-faint" />
          )}
          <span className="text-[12px] font-medium text-muted">{spec.emptyTitle}</span>
          <span className="text-[11px] leading-relaxed text-faint">
            라이브러리·GPT 이미지에서 바로 끌어와도 돼요
          </span>
        </button>
      ) : (
        <ul className="flex flex-col">
          {items.map((item, index) => (
            <li key={item.id} className="relative">
              {dropIndex === index && (
                <span className="pointer-events-none absolute inset-x-1 -top-px z-10 h-0.5 rounded-full bg-mark" />
              )}
              <ItemRow
                kind={kind}
                item={item}
                index={index}
                count={items.length}
                selected={selectedId === item.id && !(kind === 'typos' && layerId)}
                duplicate={
                  kind === 'typos' && duplicates.has(cleanCoverName(item.name).toLowerCase())
                }
                onDragStart={onDragStart}
                onDragEnd={() => {
                  setDrop(null)
                  setOver(false)
                  onDragEnd()
                }}
                onDragOverRow={(e) => {
                  if (!dragged || dragged.kind !== kind) return
                  e.preventDefault()
                  e.stopPropagation()
                  const box = e.currentTarget.getBoundingClientRect()
                  const after = e.clientY > box.top + box.height / 2
                  setDrop(index + (after ? 1 : 0))
                }}
              />
              {kind === 'typos' && (
                <ExtraList
                  typo={item}
                  open={selectedId === item.id}
                  layerId={layerId}
                  draggingTypo={dragged?.kind === 'typos' ? dragged.id : null}
                  onSlotEnter={() => setDrop(null)}
                />
              )}
            </li>
          ))}
          {dropIndex === items.length && (
            <li className="pointer-events-none relative h-0">
              <span className="absolute inset-x-1 -top-px h-0.5 rounded-full bg-mark" />
            </li>
          )}
        </ul>
      )}

      {over && (
        <div className="pointer-events-none absolute inset-0 z-20 grid place-items-center rounded-lg bg-accent-soft">
          <span className="rounded-md border border-line bg-surface px-2.5 py-1.5 text-[12px] font-semibold text-accent">
            {spec.dropLabel}
          </span>
        </div>
      )}
    </section>
  )
}

function ItemRow({
  kind,
  item,
  index,
  count,
  selected,
  duplicate,
  onDragStart,
  onDragEnd,
  onDragOverRow
}: {
  kind: CoverKind
  item: CoverItem
  index: number
  count: number
  selected: boolean
  duplicate: boolean
  onDragStart: (value: DraggedItem) => void
  onDragEnd: () => void
  onDragOverRow: (e: React.DragEvent) => void
}): React.JSX.Element {
  const thumb = useBlobThumb(item.blobKey, 44)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const confirmTimer = useRef<number | null>(null)
  const dragStartTimer = useRef<number | null>(null)
  const isTypo = kind === 'typos'

  useEffect(
    () => () => {
      if (confirmTimer.current !== null) window.clearTimeout(confirmTimer.current)
    },
    []
  )

  const number = String(index + 1).padStart(2, '0')

  const askDelete = (): void => {
    if (confirmDelete) {
      if (confirmTimer.current !== null) window.clearTimeout(confirmTimer.current)
      confirmTimer.current = null
      setConfirmDelete(false)
      useCoverStore.getState().removeItem(kind, item.id)
      return
    }
    setConfirmDelete(true)
    if (confirmTimer.current !== null) window.clearTimeout(confirmTimer.current)
    confirmTimer.current = window.setTimeout(() => {
      confirmTimer.current = null
      setConfirmDelete(false)
    }, 2500)
  }

  return (
    <div
      className={cn(
        'group relative flex h-14 cursor-default items-center gap-2 rounded-lg pl-1 pr-1.5 transition-colors',
        selected ? 'bg-accent-soft' : 'hover:bg-surface'
      )}
      onClick={() =>
        useCoverStore.getState().select(isTypo ? { typoId: item.id } : { bgId: item.id })
      }
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move'
        e.dataTransfer.setData(ITEM_MIME, JSON.stringify({ kind, id: item.id }))
        // 끌기 시작 이벤트 안에서 목록 모양이 바뀌면(타이포마다 문구 자리가 생김) 크롬이 끌기를 바로 취소한다.
        // 그래서 한 박자 뒤에 알린다.
        dragStartTimer.current = window.setTimeout(() => {
          dragStartTimer.current = null
          onDragStart({ kind, id: item.id })
        }, 0)
      }}
      onDragEnd={() => {
        if (dragStartTimer.current !== null) window.clearTimeout(dragStartTimer.current)
        dragStartTimer.current = null
        onDragEnd()
      }}
      onDragOver={onDragOverRow}
    >
      {!isTypo && (
        <span className="w-4 shrink-0 text-[11px] tabular-nums text-faint">{number}</span>
      )}

      <div
        className="size-11 shrink-0 overflow-hidden rounded-md bg-surface-2"
        style={isTypo ? CHECKER : undefined}
      >
        {thumb ? (
          <img
            src={thumb}
            alt=""
            // 그림 자체는 끌리지 않게 하고 누름은 행으로 넘긴다 (draggable=false 는 행 끌기까지 막는다)
            className={cn(
              'pointer-events-none size-full',
              isTypo ? 'object-contain' : 'object-cover'
            )}
          />
        ) : (
          <div className="grid size-full place-items-center text-faint">
            {isTypo ? <Type size={16} /> : <ImagePlus size={16} />}
          </div>
        )}
      </div>

      <div className="flex min-w-0 flex-1 flex-col justify-center">
        <div className="flex min-w-0 items-center gap-1">
          {isTypo ? (
            <input
              value={item.name}
              spellCheck={false}
              aria-label="타이포 이름"
              onClick={(e) => {
                e.stopPropagation()
                useCoverStore.getState().select({ typoId: item.id })
              }}
              onChange={(e) =>
                useCoverStore.getState().renameItem('typos', item.id, e.target.value)
              }
              className={cn(
                'h-7 min-w-0 flex-1 truncate rounded border border-transparent bg-transparent px-0.5 text-[13px] outline-none',
                'hover:bg-surface focus:border-accent/50 focus:bg-surface',
                selected ? 'font-medium text-accent' : 'text-ink'
              )}
            />
          ) : (
            <span
              className={cn(
                'min-w-0 flex-1 truncate text-[13px]',
                selected ? 'font-medium text-accent' : 'text-ink'
              )}
            >
              {item.name || 'untitled'}
            </span>
          )}
          {duplicate && (
            <span title="출력 파일 이름이 겹쳐요" className="shrink-0 text-danger">
              <AlertTriangle size={12} />
            </span>
          )}
          {!isTypo && item.maskKey && (
            <span className="shrink-0 rounded bg-surface-2 px-1 py-px text-[11px] text-muted">
              검열
            </span>
          )}
        </div>
        <span className="px-0.5 text-[11px] tabular-nums text-faint">
          {item.width}×{item.height}
        </span>
      </div>

      <div
        className={cn(
          'pointer-events-none absolute right-1 top-1/2 z-10 flex -translate-y-1/2 items-center gap-0.5 rounded-md border border-line bg-surface p-0.5 opacity-0 shadow-sm transition-opacity',
          'group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100'
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <Button
          variant="ghost"
          size="icon-sm"
          title="위로"
          aria-label="위로"
          disabled={index === 0}
          onClick={() => useCoverStore.getState().moveItem(kind, item.id, -1)}
        >
          <ChevronUp size={14} />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          title="아래로"
          aria-label="아래로"
          disabled={index === count - 1}
          onClick={() => useCoverStore.getState().moveItem(kind, item.id, 1)}
        >
          <ChevronDown size={14} />
        </Button>
        <Button
          variant={confirmDelete ? 'danger' : 'ghost'}
          size={confirmDelete ? 'sm' : 'icon-sm'}
          title={confirmDelete ? '한 번 더 누르면 삭제해요' : '삭제'}
          aria-label={confirmDelete ? '삭제 확인' : '삭제'}
          className={confirmDelete ? 'px-2 text-[11px]' : undefined}
          onClick={askDelete}
        >
          {confirmDelete ? (
            <>
              <Trash2 size={12} />
              삭제
            </>
          ) : (
            <Trash2 size={14} />
          )}
        </Button>
      </div>
    </div>
  )
}

/**
 * 타이포에 딸린 문구 목록 (업데이트 이력 등 언어마다 다른 글귀 이미지).
 * 고른 타이포에서는 끝에 "문구 붙이기" 자리가 보이고, 여기로 끌어 놓거나 눌러서 고른다.
 */
function ExtraList({
  typo,
  open,
  layerId,
  draggingTypo,
  onSlotEnter
}: {
  typo: CoverItem
  open: boolean
  layerId: string | null
  /** 끌고 있는 타이포 (그 동안엔 다른 타이포마다 놓을 자리를 보여 준다) */
  draggingTypo: string | null
  onSlotEnter: () => void
}): React.JSX.Element | null {
  const fileRef = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  const extras = typo.extras ?? []
  const moving = !!draggingTypo && draggingTypo !== typo.id
  const showSlot = moving || (open && !draggingTypo)
  if (!extras.length && !showSlot) return null

  const accept = (e: React.DragEvent): boolean => {
    // 이미지 파일, 또는 다른 타이포 (끌어 오면 이 타이포의 문구가 된다)
    const item = e.dataTransfer.types.includes(ITEM_MIME)
    if (item ? !moving : !hasImageDrop(e)) return false
    e.preventDefault()
    e.stopPropagation()
    // 끄는 쪽이 허용한 동작과 같아야 브라우저가 놓기를 받아 준다 (타이포는 move, 이미지는 copy)
    e.dataTransfer.dropEffect = item ? 'move' : 'copy'
    return true
  }

  return (
    <div className="relative mb-1 ml-[22px] border-l border-line pl-2.5">
      {extras.map((x, i) => (
        <ExtraRow
          key={x.id}
          typoId={typo.id}
          item={x}
          index={i}
          count={extras.length}
          selected={open && layerId === x.id}
        />
      ))}
      {showSlot && (
        <button
          onClick={() => fileRef.current?.click()}
          onDragEnter={(e) => {
            if (!accept(e)) return
            setOver(true)
            onSlotEnter()
          }}
          onDragOver={(e) => {
            if (accept(e)) setOver(true)
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            if (!accept(e)) return
            setOver(false)
            const raw = e.dataTransfer.getData(ITEM_MIME)
            if (raw) {
              try {
                const moved = JSON.parse(raw) as DraggedItem
                if (moved.kind === 'typos' && moved.id !== typo.id)
                  useCoverStore.getState().typoToExtra(moved.id, typo.id)
              } catch {
                // 깨진 값은 무시
              }
              return
            }
            const archived = readArchiveDrag(e)
            if (archived) {
              void useCoverStore.getState().addFromArchive(archived, 'phrase', typo.id)
              return
            }
            const paths = droppedImagePaths(e)
            const files = Array.from(e.dataTransfer.files).filter((f) =>
              f.type.startsWith('image/')
            )
            if (paths.length) void useCoverStore.getState().addExtras(typo.id, paths)
            else if (files.length) void useCoverStore.getState().addExtras(typo.id, files)
          }}
          title="이 언어에만 들어갈 문구 이미지 (업데이트 이력 등) · 다른 타이포를 끌어 놓으면 문구로 옮겨요"
          className={cn(
            'mt-1 flex h-8 w-full items-center gap-1.5 rounded-md border border-dashed px-2 text-[12px] transition-colors',
            over
              ? 'border-accent bg-accent-soft text-accent'
              : 'border-line text-muted hover:border-accent/50 hover:text-ink'
          )}
        >
          <Plus size={13} />
          {over
            ? '여기에 놓으면 문구로 붙어요'
            : moving
              ? '이 타이포의 문구로 옮기기'
              : '문구 붙이기'}
        </button>
      )}
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? [])
          if (files.length) void useCoverStore.getState().addExtras(typo.id, files)
          e.target.value = ''
        }}
      />
    </div>
  )
}

function ExtraRow({
  typoId,
  item,
  index,
  count,
  selected
}: {
  typoId: string
  item: CoverItem
  index: number
  count: number
  selected: boolean
}): React.JSX.Element {
  const thumb = useBlobThumb(item.blobKey, 32)
  const [confirm, setConfirm] = useState(false)
  useEffect(() => {
    if (!confirm) return
    const t = window.setTimeout(() => setConfirm(false), 2500)
    return () => window.clearTimeout(t)
  }, [confirm])
  const st = (): ReturnType<typeof useCoverStore.getState> => useCoverStore.getState()
  return (
    <div
      className={cn(
        'group relative flex h-10 items-center gap-2 rounded-md pl-1 pr-1.5 transition-colors',
        selected ? 'bg-accent-soft' : 'hover:bg-surface'
      )}
      onClick={() => st().select({ typoId, layerId: item.id })}
    >
      <div className="size-8 shrink-0 overflow-hidden rounded bg-surface-2" style={CHECKER}>
        {thumb ? (
          <img src={thumb} alt="" className="pointer-events-none size-full object-contain" />
        ) : (
          <div className="grid size-full place-items-center text-faint">
            <TextQuote size={13} />
          </div>
        )}
      </div>
      <input
        value={item.name}
        spellCheck={false}
        aria-label="문구 이름"
        placeholder={'문구 ' + (index + 1)}
        onClick={(e) => {
          e.stopPropagation()
          st().select({ typoId, layerId: item.id })
        }}
        onChange={(e) => st().renameExtra(typoId, item.id, e.target.value)}
        className={cn(
          'h-7 min-w-0 flex-1 truncate rounded border border-transparent bg-transparent px-0.5 text-[12px] outline-none placeholder:text-faint',
          'hover:bg-surface focus:border-accent/50 focus:bg-surface',
          selected ? 'font-medium text-accent' : 'text-ink'
        )}
      />
      <div
        className={cn(
          'pointer-events-none absolute right-1 top-1/2 z-10 flex -translate-y-1/2 items-center gap-0.5 rounded-md border border-line bg-surface p-0.5 opacity-0 shadow-sm transition-opacity',
          'group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100'
        )}
        onClick={(e) => e.stopPropagation()}
      >
        <Button
          variant="ghost"
          size="icon-sm"
          title="앞으로 (먼저 그림)"
          aria-label="문구 위로"
          disabled={index === 0}
          onClick={() => st().moveExtra(typoId, item.id, -1)}
        >
          <ChevronUp size={14} />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          title="뒤로"
          aria-label="문구 아래로"
          disabled={index === count - 1}
          onClick={() => st().moveExtra(typoId, item.id, 1)}
        >
          <ChevronDown size={14} />
        </Button>
        <Button
          variant={confirm ? 'danger' : 'ghost'}
          size={confirm ? 'sm' : 'icon-sm'}
          title={confirm ? '한 번 더 누르면 빼요' : '문구 빼기'}
          aria-label={confirm ? '문구 빼기 확인' : '문구 빼기'}
          className={confirm ? 'px-2 text-[11px]' : undefined}
          onClick={() => {
            if (!confirm) return setConfirm(true)
            setConfirm(false)
            st().removeExtra(typoId, item.id)
          }}
        >
          <Trash2 size={confirm ? 12 : 14} />
          {confirm && '빼기'}
        </Button>
      </div>
    </div>
  )
}
