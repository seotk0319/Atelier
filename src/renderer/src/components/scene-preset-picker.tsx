import {
  closestCenter,
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent
} from '@dnd-kit/core'
import { restrictToParentElement, restrictToVerticalAxis } from '@dnd-kit/modifiers'
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import {
  Check,
  ChevronDown,
  ChevronRight,
  CornerLeftUp,
  Folder,
  FolderInput,
  FolderPlus,
  ListChecks,
  Pencil,
  Plus,
  Search,
  Trash2,
  UserRound,
  UsersRound
} from 'lucide-react'
import { useMemo, useState } from 'react'
import type { ListFolder, ScenePreset } from '@shared/types'
import { DIVIDER_KEY } from '../lib/folder-list'
import { buildPresetRows, folderCounts, folderPath, type PresetTreeRow } from '../lib/preset-tree'
import { cn } from '../lib/utils'
import { askConfirm, askText } from '../stores/dialog-store'
import { useScenesStore } from '../stores/scenes-store'
import { toast } from '../stores/toast-store'
import { SortableRow } from './sortable-list'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'

const treeKey = (row: PresetTreeRow<ScenePreset>): string =>
  row.type === 'divider'
    ? DIVIDER_KEY
    : row.type === 'folder'
      ? 'f-' + row.folder.id
      : 'i-' + row.item.id

/**
 * 씬 프리셋 고르기. 작품 폴더 아래 캐릭터 폴더까지 2단계로 묶고, 검색은 폴더를 가리지 않는다.
 * 폴더는 앱 안 목록만 정리한다 — 디스크의 이미지 저장 폴더는 그대로.
 */
export function ScenePresetPicker({
  onManage,
  onBind,
  triggerClassName
}: {
  onManage: () => void
  onBind: (p: ScenePreset) => void
  /** 단추 모양 덧칠 */
  triggerClassName?: string
}): React.JSX.Element {
  const presets = useScenesStore((s) => s.presets)
  const folders = useScenesStore((s) => s.presetFolders)
  const activePresetId = useScenesStore((s) => s.activePresetId)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  // 지금 프리셋이 든 폴더는 열 때 접혀 있어도 펼쳐 보여 준다 (저장된 접힘 상태는 그대로)
  const [reveal, setReveal] = useState<number[]>([])

  const active = presets.find((p) => p.id === activePresetId)
  const activeFolder = folders.find((f) => f.id === active?.folderId)
  const activeParent = folders.find((f) => f.id === activeFolder?.parentId)
  const folderName = useMemo(
    () => new Map(folders.map((f) => [f.id, folderPath(folders, f.id)])),
    [folders]
  )
  const revealFor = (): number[] =>
    [activeFolder?.id, activeFolder?.parentId].filter((x): x is number => x != null)

  const onOpenChange = (next: boolean): void => {
    setOpen(next)
    if (next) {
      setQuery('')
      setReveal(revealFor())
    }
  }

  const choose = (id: number): void => {
    // 닫기를 먼저 (선택의 store 재렌더가 끼어들기 전에 확정) (B9)
    setOpen(false)
    void useScenesStore.getState().setActivePreset(id)
  }
  const later = (fn: () => void): void => {
    // 팝오버가 닫히는 클릭과 같은 틱에 다이얼로그를 열면 바로 닫히는 레이스 — 한 틱 미룸
    setOpen(false)
    setTimeout(fn, 0)
  }

  const collapsed = (f: ListFolder): boolean => f.collapsed && !reveal.includes(f.id)
  const toggle = (f: ListFolder): void => {
    const st = useScenesStore.getState()
    if (reveal.includes(f.id)) {
      setReveal(reveal.filter((id) => id !== f.id))
      if (!f.collapsed) void st.setPresetFolderCollapsed(f.id, true)
      return
    }
    void st.setPresetFolderCollapsed(f.id, !f.collapsed)
  }

  const rows = useMemo(
    () => buildPresetRows(folders, presets, (f) => f.collapsed && !reveal.includes(f.id)),
    [folders, presets, reveal]
  )
  const counts = useMemo(() => folderCounts(folders, presets), [folders, presets])
  const hasKids = useMemo(
    () => new Set(folders.map((f) => f.parentId).filter((x): x is number => x != null)),
    [folders]
  )

  const q = query.trim().toLowerCase()
  const matches = q
    ? presets.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          (p.folderId != null && (folderName.get(p.folderId) ?? '').toLowerCase().includes(q))
      )
    : []

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))
  const onDragEnd = (e: DragEndEvent): void => {
    const { active: a, over } = e
    if (!over || a.id === over.id) return
    const activeKey = String(a.id)
    const overKey = String(over.id)
    const st = useScenesStore.getState()
    // 프리셋을 폴더 머리에 놓으면 그 폴더로 (끝에 붙는다)
    if (activeKey.startsWith('i-') && overKey.startsWith('f-')) {
      const id = Number(activeKey.slice(2))
      const fid = Number(overKey.slice(2))
      if (presets.find((p) => p.id === id)?.folderId !== fid) void st.movePresetsToFolder([id], fid)
      return
    }
    void st.movePresetRow(activeKey, overKey)
  }

  const newFolder = (): void =>
    later(async () => {
      const name = await askText('새 폴더 이름 (작품 이름)', '새 작품')
      if (name) await useScenesStore.getState().createPresetFolder(name)
    })

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          className={cn(
            'flex h-9 min-w-0 max-w-[420px] items-center gap-1.5 rounded-lg bg-paper px-3 text-[13px] font-semibold text-ink outline-none hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-accent/40',
            triggerClassName
          )}
          title="씬 프리셋 고르기"
        >
          {activeParent && (
            <>
              <span className="min-w-0 max-w-[120px] shrink truncate font-medium text-muted">
                {activeParent.name}
              </span>
              <ChevronRight size={12} className="shrink-0 text-faint" />
            </>
          )}
          {activeFolder && (
            <>
              <span className="min-w-0 max-w-[160px] shrink truncate font-medium text-muted">
                {activeFolder.name}
              </span>
              <ChevronRight size={12} className="shrink-0 text-faint" />
            </>
          )}
          <span className="min-w-0 flex-1 truncate text-left">{active?.name ?? '프리셋'}</span>
          <ChevronDown size={14} className="shrink-0 text-muted" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[max(var(--radix-popover-trigger-width),26rem)] p-1"
      >
        <div className="relative px-1 pb-1 pt-0.5">
          <Search
            size={13}
            className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-faint"
          />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="프리셋·작품 이름으로 찾기"
            className="h-8 w-full rounded-md bg-surface-2 pl-8 pr-2.5 text-[13px] text-ink outline-none placeholder:text-faint focus:ring-2 focus:ring-accent/30"
          />
        </div>
        <div className="no-scrollbar max-h-[min(60vh,480px)] overflow-y-auto overflow-x-hidden">
          {q ? (
            matches.length === 0 ? (
              <p className="px-3 py-6 text-center text-[12px] text-faint">결과 없음</p>
            ) : (
              matches.map((p) => (
                <button
                  key={p.id}
                  onClick={() => choose(p.id)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-surface-2',
                    p.id === activePresetId && 'font-semibold text-accent'
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">{p.name}</span>
                  {p.folderId != null && (
                    <span className="max-w-[45%] shrink-0 truncate text-[11px] text-faint">
                      {folderName.get(p.folderId)}
                    </span>
                  )}
                </button>
              ))
            )
          ) : (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              modifiers={[restrictToVerticalAxis, restrictToParentElement]}
              onDragEnd={onDragEnd}
            >
              <SortableContext items={rows.map(treeKey)} strategy={verticalListSortingStrategy}>
                {rows.map((row) =>
                  row.type === 'folder' ? (
                    <FolderRow
                      key={treeKey(row)}
                      folder={row.folder}
                      depth={row.depth}
                      folders={folders}
                      hasKids={hasKids.has(row.folder.id)}
                      count={counts.get(row.folder.id) ?? 0}
                      collapsed={collapsed(row.folder)}
                      onToggle={() => toggle(row.folder)}
                      onAdd={() =>
                        later(async () => {
                          const name = await askText(row.folder.name + '에 새 프리셋', '새 프리셋')
                          if (name)
                            await useScenesStore.getState().createPreset(name, row.folder.id)
                        })
                      }
                      onAddSub={() =>
                        later(async () => {
                          const name = await askText(
                            row.folder.name + ' 아래 새 폴더 (캐릭터 등)',
                            '새 폴더'
                          )
                          if (name)
                            await useScenesStore.getState().createPresetFolder(name, row.folder.id)
                        })
                      }
                      onRename={() =>
                        later(async () => {
                          const name = await askText('폴더 이름', row.folder.name)
                          if (name)
                            await useScenesStore.getState().renamePresetFolder(row.folder.id, name)
                        })
                      }
                      onDelete={() =>
                        later(async () => {
                          const n = presets.filter((p) => p.folderId === row.folder.id).length
                          const kids = folders.filter((f) => f.parentId === row.folder.id).length
                          const ok = await askConfirm('폴더 삭제', {
                            message:
                              (n > 0
                                ? '"' +
                                  row.folder.name +
                                  '" 폴더만 지워요. 안의 프리셋 ' +
                                  n +
                                  '개와 씬·이미지는 그대로 "폴더 없음"으로 옮겨요.'
                                : '"' + row.folder.name + '" 폴더를 지워요.') +
                              (kids > 0
                                ? ' 하위 폴더 ' + kids + '개는 맨 위 단계로 올라와요.'
                                : ''),
                            confirmLabel: '폴더 삭제',
                            danger: true
                          })
                          if (ok) await useScenesStore.getState().deletePresetFolder(row.folder.id)
                        })
                      }
                    />
                  ) : row.type === 'divider' ? (
                    <DividerRow key={DIVIDER_KEY} />
                  ) : (
                    <PresetRow
                      key={treeKey(row)}
                      preset={row.item}
                      depth={row.depth}
                      active={row.item.id === activePresetId}
                      folders={folders}
                      canDelete={presets.length > 1}
                      onChoose={() => choose(row.item.id)}
                      onBind={() => later(() => onBind(row.item))}
                      onLater={later}
                    />
                  )
                )}
              </SortableContext>
            </DndContext>
          )}
        </div>
        <div className="my-1 h-px bg-line" />
        <div className="flex items-center gap-0.5">
          <MenuButton onClick={() => later(onManage)}>
            <ListChecks size={14} /> 프리셋 관리
          </MenuButton>
          <span className="flex-1" />
          <MenuButton onClick={newFolder}>
            <FolderPlus size={14} /> 새 폴더
          </MenuButton>
          <MenuButton
            accent
            onClick={() =>
              later(async () => {
                const name = await askText('새 프리셋 이름', '새 프리셋')
                if (name) await useScenesStore.getState().createPreset(name)
              })
            }
          >
            <Plus size={14} /> 새 프리셋
          </MenuButton>
        </div>
      </PopoverContent>
    </Popover>
  )
}

function MenuButton({
  accent,
  onClick,
  children
}: {
  accent?: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[13px] hover:bg-surface-2',
        accent ? 'font-medium text-accent' : 'text-ink'
      )}
    >
      {children}
    </button>
  )
}

const ICON_BTN =
  'shrink-0 rounded p-1 text-faint opacity-0 outline-none hover:text-fg group-hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-accent/40'

function FolderRow({
  folder,
  depth,
  folders,
  hasKids,
  count,
  collapsed,
  onToggle,
  onAdd,
  onAddSub,
  onRename,
  onDelete
}: {
  folder: ListFolder
  depth: 0 | 1
  folders: ListFolder[]
  hasKids: boolean
  count: number
  collapsed: boolean
  onToggle: () => void
  onAdd: () => void
  onAddSub: () => void
  onRename: () => void
  onDelete: () => void
}): React.JSX.Element {
  const [moveOpen, setMoveOpen] = useState(false)
  const tops = folders.filter((f) => f.parentId == null && f.id !== folder.id)
  const moveTo = (parentId: number | null): void => {
    setMoveOpen(false)
    if (parentId === (folder.parentId ?? null)) return
    void useScenesStore
      .getState()
      .setPresetFolderParent(folder.id, parentId)
      .then((r) => {
        if (!r.ok) toast(r.message, 'error')
      })
  }
  return (
    <SortableRow
      id={'f-' + folder.id}
      className={cn('group mt-0.5 gap-0.5', depth === 1 && 'pl-5')}
      onTap={onToggle}
    >
      <div
        className={cn(
          'flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1.5 text-[13px] text-ink hover:bg-surface-2',
          depth === 0 ? 'font-semibold' : 'font-medium'
        )}
        title={collapsed ? '펼치기' : '접기'}
      >
        {collapsed ? (
          <ChevronRight size={14} className="shrink-0 text-faint" />
        ) : (
          <ChevronDown size={14} className="shrink-0 text-faint" />
        )}
        <Folder size={13} className="shrink-0 text-muted" />
        <span className="min-w-0 truncate">{folder.name}</span>
        <span className="shrink-0 text-[11px] font-medium tabular-nums text-faint">{count}</span>
      </div>
      <button className={ICON_BTN} onClick={onAdd} title="이 폴더에 새 프리셋">
        <Plus size={12} />
      </button>
      {depth === 0 && (
        <button className={ICON_BTN} onClick={onAddSub} title="하위 폴더 만들기 (캐릭터별 등)">
          <FolderPlus size={12} />
        </button>
      )}
      <Popover open={moveOpen} onOpenChange={setMoveOpen}>
        <PopoverTrigger asChild>
          <button
            className={cn(ICON_BTN, moveOpen && 'opacity-100')}
            title="다른 폴더 아래로 옮기기"
          >
            <FolderInput size={12} />
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" side="right" className="w-56 p-1">
          <p className="px-2 pb-1 pt-0.5 text-[11px] font-medium text-faint">
            이 폴더를 어디 아래로
          </p>
          {hasKids ? (
            <p className="px-2 py-1.5 text-[12px] leading-relaxed text-muted">
              하위 폴더가 있는 폴더는 다른 폴더 아래로 넣을 수 없어요 (2단계까지)
            </p>
          ) : (
            <div className="no-scrollbar max-h-64 overflow-y-auto">
              {tops.map((f) => (
                <MoveItem
                  key={f.id}
                  current={folder.parentId === f.id}
                  onClick={() => moveTo(f.id)}
                >
                  <Folder size={12} className="shrink-0 text-muted" />
                  <span className="min-w-0 flex-1 truncate">{f.name}</span>
                </MoveItem>
              ))}
              {tops.length === 0 && <p className="px-2 py-1.5 text-[12px] text-faint">폴더 없음</p>}
            </div>
          )}
          {depth === 1 && (
            <>
              <div className="my-1 h-px bg-line" />
              <MoveItem current={false} onClick={() => moveTo(null)}>
                <CornerLeftUp size={12} className="shrink-0 text-muted" />
                <span className="min-w-0 flex-1 truncate">맨 위 단계로 꺼내기</span>
              </MoveItem>
            </>
          )}
        </PopoverContent>
      </Popover>
      <button className={ICON_BTN} onClick={onRename} title="폴더 이름 변경">
        <Pencil size={12} />
      </button>
      <button
        className={cn(ICON_BTN, 'hover:text-danger')}
        onClick={onDelete}
        title="폴더 삭제 (프리셋은 남아요)"
      >
        <Trash2 size={12} />
      </button>
    </SortableRow>
  )
}

/** 폴더 섹션과 폴더 없는 프리셋의 경계. 여기 아래로 끌어 놓으면 폴더에서 빠진다 */
function DividerRow(): React.JSX.Element {
  const { setNodeRef, transform, transition } = useSortable({ id: DIVIDER_KEY })
  return (
    <div
      ref={setNodeRef}
      style={{
        transform: transform ? 'translate3d(0, ' + Math.round(transform.y) + 'px, 0)' : undefined,
        transition
      }}
      className="mt-1.5 flex items-center gap-2 px-2 pb-0.5 pt-1"
    >
      <span className="text-[11px] font-medium text-faint">폴더 없음</span>
      <span className="h-px flex-1 bg-line" />
    </div>
  )
}

function PresetRow({
  preset: p,
  depth,
  active,
  folders,
  canDelete,
  onChoose,
  onBind,
  onLater
}: {
  preset: ScenePreset
  depth: 0 | 1 | 2
  active: boolean
  folders: ListFolder[]
  canDelete: boolean
  onChoose: () => void
  onBind: () => void
  onLater: (fn: () => void) => void
}): React.JSX.Element {
  const [moveOpen, setMoveOpen] = useState(false)
  const bound = (p.characterIds?.length ?? 0) > 0
  const moveTo = (folderId: number | null): void => {
    setMoveOpen(false)
    if (folderId !== p.folderId)
      void useScenesStore.getState().movePresetsToFolder([p.id], folderId)
  }
  return (
    <SortableRow
      id={'i-' + p.id}
      className={cn('group gap-0.5', depth === 1 && 'pl-5', depth === 2 && 'pl-10')}
      onTap={onChoose}
    >
      <div
        className={cn(
          'flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-surface-2',
          active && 'font-semibold text-accent'
        )}
      >
        <span className="truncate">{p.name}</span>
        {bound && (
          // 반드시 <button> — SortableRow의 onTap은 button/input에서 시작한 클릭을 제외한다
          <button
            className="flex shrink-0 cursor-pointer items-center gap-0.5 rounded-full bg-accent/12 px-1.5 py-0.5 text-[11px] font-medium text-accent hover:bg-accent/25"
            title="캐릭터 바인드됨 — 클릭해서 편집"
            onClick={(e) => {
              e.stopPropagation()
              onBind()
            }}
          >
            <UserRound size={9} /> {p.characterIds!.length}
          </button>
        )}
      </div>
      {!bound && (
        <button
          className={ICON_BTN}
          onClick={onBind}
          title="캐릭터 바인드 — 이 프리셋 생성 시 사이드바 대신 지정 캐릭터 사용"
        >
          <UsersRound size={12} />
        </button>
      )}
      <Popover open={moveOpen} onOpenChange={setMoveOpen}>
        <PopoverTrigger asChild>
          <button className={cn(ICON_BTN, moveOpen && 'opacity-100')} title="폴더로 이동">
            <FolderInput size={12} />
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" side="right" className="w-52 p-1">
          <p className="px-2 pb-1 pt-0.5 text-[11px] font-medium text-faint">폴더로 이동</p>
          <div className="no-scrollbar max-h-64 overflow-y-auto">
            {folders.map((f) => (
              <MoveItem key={f.id} current={p.folderId === f.id} onClick={() => moveTo(f.id)}>
                <Folder
                  size={12}
                  className={cn('shrink-0 text-muted', f.parentId != null && 'ml-4')}
                />
                <span className="min-w-0 flex-1 truncate">{f.name}</span>
              </MoveItem>
            ))}
            <MoveItem current={p.folderId == null} onClick={() => moveTo(null)}>
              <span className="min-w-0 flex-1 truncate text-muted">폴더 없음</span>
            </MoveItem>
          </div>
          <div className="my-1 h-px bg-line" />
          <MoveItem
            current={false}
            onClick={() => {
              setMoveOpen(false)
              onLater(async () => {
                const name = await askText('새 폴더 이름 (작품 이름)', '새 작품')
                if (!name) return
                const st = useScenesStore.getState()
                const id = await st.createPresetFolder(name)
                await st.movePresetsToFolder([p.id], id)
              })
            }}
          >
            <FolderPlus size={12} className="shrink-0 text-accent" />
            <span className="min-w-0 flex-1 truncate text-accent">새 폴더 만들어 옮기기</span>
          </MoveItem>
        </PopoverContent>
      </Popover>
      <button
        className={ICON_BTN}
        onClick={() =>
          onLater(async () => {
            const name = await askText('프리셋 이름', p.name)
            if (name) await useScenesStore.getState().renamePreset(p.id, name)
          })
        }
        title="이름 변경"
      >
        <Pencil size={12} />
      </button>
      {canDelete && (
        <button
          className={cn(ICON_BTN, 'hover:text-danger')}
          onClick={() =>
            onLater(async () => {
              if (
                await askConfirm('프리셋 삭제', {
                  message: '"' + p.name + '" 프리셋과 그 안의 씬을 모두 삭제해요.',
                  confirmLabel: '삭제',
                  danger: true
                })
              )
                await useScenesStore.getState().deletePreset(p.id)
            })
          }
          title="삭제"
        >
          <Trash2 size={12} />
        </button>
      )}
    </SortableRow>
  )
}

function MoveItem({
  current,
  onClick,
  children
}: {
  current: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-ink hover:bg-surface-2"
    >
      {children}
      {current && <Check size={12} className="shrink-0 text-accent" />}
    </button>
  )
}
