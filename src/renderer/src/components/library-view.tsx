import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderOpen,
  FolderPlus,
  GalleryVertical,
  Images,
  Layers3,
  LayoutGrid,
  Loader2,
  Menu,
  Pencil,
  Trash2
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  HistoryItem,
  LibraryDateGroup,
  LibraryStackSummary,
  LibraryVirtualFolder
} from '@shared/types'
import { imageUrl } from '../lib/constants'
import { cn } from '../lib/utils'
import { olderWindow, recentWindowStart } from '../lib/library-window'
import {
  hasLibraryEntryDrag,
  LIBRARY_FOLDER_MIME,
  readLibraryEntry,
  setImagePathDrag,
  setLibraryEntryDrag
} from '../lib/image-drag'
import { useGenerationStore } from '../stores/generation-store'
import { useLayoutStore } from '../stores/layout-store'
import { useStorageSettingsStore } from '../stores/storage-settings-store'
import { askConfirm, askText } from '../stores/dialog-store'
import { toast } from '../stores/toast-store'
import { ImageContextMenu } from './image-context-menu'
import { Lightbox } from './lightbox'
import { Tooltip, TooltipContent, TooltipTrigger } from './ui/tooltip'
import { Segmented, SegmentedItem } from './ui/segmented'

const PAGE = 60
type Fit = 'square' | 'natural'
type LibraryMode = 'classic' | 'folders'
type FolderSelection = 'all' | 'unfiled' | number

interface FolderNode extends LibraryVirtualFolder {
  children: FolderNode[]
}

export function LibraryView(): React.JSX.Element {
  const [items, setItems] = useState<HistoryItem[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  // 확대 보기는 위치가 아니라 파일로 기억한다 — 새 그림이 들어오거나 목록을 다시 읽으면 위치가 밀려
  // 다른 그림이 보이거나(앞에 새 그림), 목록이 줄어 닫힌 것처럼 숨어 있다가 화살표로 엉뚱하게 열렸다
  const [lightboxPath, setLightboxPath] = useState<string | null>(null)
  const [cols, setCols] = useState(() => Number(localStorage.getItem('library_cols')) || 4)
  const [fit, setFit] = useState<Fit>(
    () => (localStorage.getItem('library_fit') as Fit) || 'square'
  )
  const [mode, setMode] = useState<LibraryMode>('classic')
  const [panelOpen, setPanelOpen] = useState(
    () => localStorage.getItem('library_panel_open') !== '0'
  )
  const [dates, setDates] = useState<LibraryDateGroup[]>([])
  const [folders, setFolders] = useState<LibraryVirtualFolder[]>([])
  const [stacks, setStacks] = useState<LibraryStackSummary[]>([])
  const [selectedDate, setSelectedDate] = useState<string | null>(null)
  const [selectedFolder, setSelectedFolder] = useState<FolderSelection>('all')

  const historyTotal = useGenerationStore((s) => s.historyTotal)
  const historyDeleteFile = useStorageSettingsStore((s) => s.historyDeleteFile)
  const loadStorageSettings = useStorageSettingsStore((s) => s.load)
  const itemsRef = useRef<HistoryItem[]>([])
  const loadingRef = useRef(false)
  const requestSeq = useRef(0)
  const sentinelRef = useRef<HTMLDivElement>(null)
  const [since, setSince] = useState(() => recentWindowStart(new Date()))
  const sinceRef = useRef(since)
  const [hasMore, setHasMore] = useState(false)
  const hasMoreRef = useRef(false)
  const windowFilter = useRef<unknown>(null)

  useEffect(() => {
    itemsRef.current = items
  }, [items])

  const requestFilter = useMemo(() => {
    const filter: { date?: string; virtualFolderId?: number; unfiledOnly?: boolean } = {}
    if (selectedDate) filter.date = selectedDate
    if (mode === 'folders') {
      if (selectedFolder === 'unfiled') filter.unfiledOnly = true
      else if (typeof selectedFolder === 'number') filter.virtualFolderId = selectedFolder
    }
    return filter
  }, [mode, selectedDate, selectedFolder])

  // 날짜도 폴더도 고르지 않은 큰 목록은 최근 1주만 먼저 읽고, 그 전은 1주씩 넓힌다.
  // 날짜 하나나 가상 폴더 하나를 고른 목록은 이미 좁아서 창을 두지 않는다.
  const windowed = !selectedDate && !(mode === 'folders' && typeof selectedFolder === 'number')
  const applySince = useCallback((value: string): void => {
    sinceRef.current = value
    setSince(value)
  }, [])
  const applyHasMore = useCallback((value: boolean): void => {
    hasMoreRef.current = value
    setHasMore(value)
  }, [])

  const loadNavigation = useCallback(async (): Promise<void> => {
    const [dateRes, folderRes] = await Promise.all([
      window.nais.invoke('library:dates', undefined),
      window.nais.invoke('library:folders', undefined)
    ])
    setDates(dateRes.items)
    setFolders(folderRes.folders)
    setStacks(folderRes.stacks)
  }, [])

  const reload = useCallback(async (): Promise<void> => {
    const seq = ++requestSeq.current
    // 보는 목록이 바뀌면 창을 최근 1주로 되돌린다. 같은 목록을 다시 읽을 땐 넓힌 창을 유지한다
    if (windowFilter.current !== requestFilter) {
      windowFilter.current = requestFilter
      applySince(recentWindowStart(new Date()))
    }
    loadingRef.current = true
    setLoading(true)
    try {
      const fetchFirst = (): Promise<{ items: HistoryItem[]; total: number }> =>
        window.nais.invoke('images:list', {
          limit: PAGE,
          offset: 0,
          ...requestFilter,
          ...(windowed ? { since: sinceRef.current } : {})
        })
      let res = await fetchFirst()
      if (seq !== requestSeq.current) return
      if (windowed && res.items.length === 0 && res.total > 0) {
        // 최근 1주에 그림이 없으면 그림이 있는 가장 가까운 주부터 보여 준다
        const { items: dateItems } = await window.nais.invoke('library:dates', undefined)
        if (seq !== requestSeq.current) return
        const older = olderWindow(dateItems, sinceRef.current)
        if (older) {
          applySince(older.since)
          res = await fetchFirst()
          if (seq !== requestSeq.current) return
        }
      }
      itemsRef.current = res.items
      setItems(res.items)
      setTotal(res.total)
      applyHasMore(res.items.length === PAGE)
    } finally {
      if (seq === requestSeq.current) {
        loadingRef.current = false
        setLoading(false)
      }
    }
  }, [applyHasMore, applySince, requestFilter, windowed])

  const loadMore = useCallback(async (): Promise<void> => {
    const last = itemsRef.current[itemsRef.current.length - 1]
    if (loadingRef.current || !hasMoreRef.current || !last) return
    const seq = requestSeq.current
    loadingRef.current = true
    setLoading(true)
    try {
      // 건너뛰기(offset) 대신 마지막 번호부터 이어 읽는다 — 뒤쪽 장도 첫 장만큼 빠르다
      const res = await window.nais.invoke('images:list', {
        limit: PAGE,
        offset: 0,
        beforeId: last.id,
        ...requestFilter,
        ...(windowed ? { since: sinceRef.current } : {})
      })
      if (seq !== requestSeq.current) return
      setTotal(res.total)
      applyHasMore(res.items.length === PAGE)
      setItems((previous) => {
        const seen = new Set(previous.map((item) => item.id))
        const next = [...previous, ...res.items.filter((item) => !seen.has(item.id))]
        itemsRef.current = next
        return next
      })
    } finally {
      if (seq === requestSeq.current) {
        loadingRef.current = false
        setLoading(false)
      }
    }
  }, [applyHasMore, requestFilter, windowed])

  const older = windowed && !hasMore && !loading ? olderWindow(dates, since) : null
  const showOlder = (): void => {
    if (!older) return
    applySince(older.since)
    if (itemsRef.current.length === 0) {
      void reload()
      return
    }
    applyHasMore(true)
    void loadMore()
  }

  useEffect(() => {
    queueMicrotask(() => void loadStorageSettings())
    void window.nais.invoke('settings:get', { key: 'library_view_mode' }).then(({ value }) => {
      setMode(value === 'folders' ? 'folders' : 'classic')
    })
    const onMode = (event: Event): void => {
      const value = (event as CustomEvent<LibraryMode>).detail
      setMode(value === 'folders' ? 'folders' : 'classic')
      if (value !== 'folders') setSelectedFolder('all')
    }
    window.addEventListener('nais:library-view-mode', onMode)
    return () => window.removeEventListener('nais:library-view-mode', onMode)
  }, [loadStorageSettings])

  // 라이브러리는 미리 만들어 숨겨 두는 탭이다. 숨어 있는 동안 새 이미지마다 목록·날짜를 다시 읽으면
  // 씬 생성 중 본체가 계속 막혔다 — 숨어 있을 땐 미루고, 열 때 바뀐 게 있으면 한 번 읽는다.
  const visible = useLayoutStore((s) => s.centerMode === 'library')
  const lastLoad = useRef<{ total: number; reload: unknown } | null>(null)
  useEffect(() => {
    const prev = lastLoad.current
    if (prev && prev.total === historyTotal && prev.reload === reload) return
    if (prev && !visible) return
    lastLoad.current = { total: historyTotal, reload }
    queueMicrotask(() => {
      void reload()
      void loadNavigation()
    })
  }, [historyTotal, loadNavigation, reload, visible])

  useEffect(() => {
    const el = sentinelRef.current
    if (!el) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) void loadMore()
      },
      { rootMargin: '600px' }
    )
    observer.observe(el)
    return () => observer.disconnect()
    // 한 장을 읽고도 끝이 화면 안에 남아 있으면 다시 지켜봐야 다음 장을 읽는다
  }, [loadMore, items.length, hasMore])

  const setColsPersist = (value: number): void => {
    setCols(value)
    localStorage.setItem('library_cols', String(value))
  }
  const setFitPersist = (value: Fit): void => {
    setFit(value)
    localStorage.setItem('library_fit', value)
  }
  const togglePanel = (): void => {
    const next = !panelOpen
    setPanelOpen(next)
    localStorage.setItem('library_panel_open', next ? '1' : '0')
  }

  const onDelete = async (id: number): Promise<void> => {
    if (historyDeleteFile) {
      const ok = await askConfirm('파일까지 영구 삭제', {
        message: '라이브러리 기록과 저장한 이미지 파일을 함께 삭제해요.',
        confirmLabel: '영구 삭제',
        danger: true
      })
      if (!ok) return
    }
    await window.nais.invoke('images:delete', { id, deleteFile: historyDeleteFile })
    void useGenerationStore.getState().refreshHistory()
    await Promise.all([reload(), loadNavigation()])
  }

  const assignEntry = async (
    entry: { type: 'image' | 'stack'; id: number },
    folderId: number | null
  ): Promise<void> => {
    await window.nais.invoke('library:assign', {
      imageIds: entry.type === 'image' ? [entry.id] : undefined,
      stackIds: entry.type === 'stack' ? [entry.id] : undefined,
      folderId
    })
    await Promise.all([reload(), loadNavigation()])
  }

  const openStorageFolder = async (): Promise<void> => {
    const { ok } = await window.nais.invoke('library:openStorageFolder', undefined)
    if (!ok) toast('이미지 저장 폴더를 열지 못했어요', 'error')
  }

  const visibleStacks = useMemo(() => {
    if (mode !== 'folders' || selectedDate) return []
    if (selectedFolder === 'all') return stacks
    if (selectedFolder === 'unfiled') return stacks.filter((stack) => stack.virtualFolderId == null)
    return stacks.filter((stack) => stack.virtualFolderId === selectedFolder)
  }, [mode, selectedDate, selectedFolder, stacks])

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-surface">
      <div className="flex h-[60px] shrink-0 items-center gap-2.5 px-5">
        <h1 className="text-[20px] font-bold tracking-tight">라이브러리</h1>
        <span className="text-[13px] tabular-nums text-muted">{total.toLocaleString()}장</span>
        {selectedDate && (
          <span className="no-drag rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-muted">
            {selectedDate}
          </span>
        )}
        {mode === 'folders' && selectedFolder !== 'all' && (
          <span className="no-drag rounded-full bg-accent-soft px-2 py-0.5 text-[11px] text-accent">
            {selectedFolder === 'unfiled'
              ? '미분류'
              : (folders.find((folder) => folder.id === selectedFolder)?.name ?? '가상 폴더')}
          </span>
        )}

        <div className="flex-1" />

        <Segmented
          className="no-drag"
          value={fit}
          onValueChange={(v) => v && setFitPersist(v as typeof fit)}
          aria-label="그림 비율"
        >
          <SegmentedItem value="square" title="정사각 크롭" className="w-8 px-0">
            <LayoutGrid size={15} />
          </SegmentedItem>
          <SegmentedItem value="natural" title="원본 비율" className="w-8 px-0">
            <GalleryVertical size={15} />
          </SegmentedItem>
        </Segmented>
        <Segmented
          className="no-drag"
          value={String(cols)}
          onValueChange={(v) => v && setColsPersist(Number(v))}
          aria-label="열 개수"
        >
          {[2, 3, 4, 5, 6].map((value) => (
            <SegmentedItem key={value} value={String(value)} className="w-8 px-0">
              {value}
            </SegmentedItem>
          ))}
        </Segmented>
        <HeaderIconButton tip="실제 이미지 저장 폴더 열기" onClick={() => void openStorageFolder()}>
          <FolderOpen size={16} />
        </HeaderIconButton>
        <HeaderIconButton
          tip={panelOpen ? '탐색 패널 닫기' : '탐색 패널 열기'}
          active={panelOpen}
          onClick={togglePanel}
        >
          <Menu size={16} />
        </HeaderIconButton>
      </div>

      <div className="flex min-h-0 flex-1">
        {panelOpen && (
          <LibrarySidebar
            mode={mode}
            dates={dates}
            selectedDate={selectedDate}
            onSelectDate={setSelectedDate}
            folders={folders}
            selectedFolder={selectedFolder}
            onSelectFolder={setSelectedFolder}
            onAssign={assignEntry}
            onReload={async () => {
              await Promise.all([reload(), loadNavigation()])
            }}
          />
        )}

        <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto px-5 pb-5">
          {visibleStacks.length > 0 && (
            <div className="mb-3">
              <div className="mb-2 flex items-center gap-1.5 text-[12px] font-medium text-muted">
                <Layers3 size={13} /> 스택 {visibleStacks.length}
              </div>
              <div
                className="grid gap-2"
                style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
              >
                {visibleStacks.map((stack) => (
                  <StackCard key={stack.id} stack={stack} />
                ))}
              </div>
              <div className="my-3 h-px bg-line" />
            </div>
          )}

          {items.length === 0 && visibleStacks.length === 0 && !loading ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-faint">
              <Images size={40} strokeWidth={1.3} className="opacity-40" />
              <p className="text-[13px]">이미지 없음</p>
            </div>
          ) : fit === 'natural' ? (
            <div style={{ columnCount: cols, columnGap: '8px' }}>
              {items.map((item) => (
                <ImageCardNatural
                  key={item.id}
                  item={item}
                  onOpen={() => setLightboxPath(item.filePath)}
                  onDelete={() => void onDelete(item.id)}
                  deleteFile={historyDeleteFile}
                />
              ))}
            </div>
          ) : (
            <div
              className="grid gap-2"
              style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
            >
              {items.map((item) => (
                <ImageCardSquare
                  key={item.id}
                  item={item}
                  onOpen={() => setLightboxPath(item.filePath)}
                  onDelete={() => void onDelete(item.id)}
                  deleteFile={historyDeleteFile}
                />
              ))}
            </div>
          )}
          <div ref={sentinelRef} className="h-4" />
          {older && (
            <button
              className="mx-auto mb-14 mt-2 flex h-9 items-center gap-2 rounded-lg border border-line px-4 text-[13px] font-medium text-muted transition-colors hover:bg-surface-2 hover:text-ink"
              onClick={showOlder}
            >
              이전 1주 더 보기
              <span className="text-[12px] tabular-nums text-faint">
                {older.since} ~ {older.to}
                {!requestFilter.unfiledOnly && ` · ${older.count.toLocaleString()}장`}
              </span>
            </button>
          )}
          {loading && (
            <div className="flex items-center justify-center py-4 text-faint">
              <Loader2 size={18} className="animate-spin" />
            </div>
          )}
        </div>
      </div>

      {lightboxPath != null && items.some((item) => item.filePath === lightboxPath) && (
        <Lightbox
          filePaths={items.map((item) => item.filePath)}
          index={items.findIndex((item) => item.filePath === lightboxPath)}
          onIndex={(i) => setLightboxPath(items[i]?.filePath ?? null)}
          onClose={() => setLightboxPath(null)}
        />
      )}
    </div>
  )
}

function LibrarySidebar({
  mode,
  dates,
  selectedDate,
  onSelectDate,
  folders,
  selectedFolder,
  onSelectFolder,
  onAssign,
  onReload
}: {
  mode: LibraryMode
  dates: LibraryDateGroup[]
  selectedDate: string | null
  onSelectDate: (date: string | null) => void
  folders: LibraryVirtualFolder[]
  selectedFolder: FolderSelection
  onSelectFolder: (folder: FolderSelection) => void
  onAssign: (
    entry: { type: 'image' | 'stack'; id: number },
    folderId: number | null
  ) => Promise<void>
  onReload: () => Promise<void>
}): React.JSX.Element {
  const tree = useMemo(() => buildFolderTree(folders), [folders])
  // 날짜는 최근 것만 먼저 보여주고 나머지는 접는다. 선택한 날짜가 접힌 쪽이면 펼친 채로 둔다.
  const [showAllDates, setShowAllDates] = useState(false)
  const RECENT_DATES = 7
  const selectedIndex = selectedDate ? dates.findIndex((d) => d.date === selectedDate) : -1
  const expanded = showAllDates || selectedIndex >= RECENT_DATES
  const shownDates = expanded ? dates : dates.slice(0, RECENT_DATES)

  const createFolder = async (parentId: number | null): Promise<void> => {
    const name = await askText(parentId == null ? '새 가상 폴더' : '새 하위 폴더', '새 폴더')
    if (!name) return
    await window.nais.invoke('library:folderCreate', { name, parentId })
    await onReload()
  }
  const renameFolder = async (folder: LibraryVirtualFolder): Promise<void> => {
    const name = await askText('가상 폴더 이름 변경', folder.name)
    if (!name) return
    await window.nais.invoke('library:folderRename', { id: folder.id, name })
    await onReload()
  }
  const deleteFolder = async (folder: LibraryVirtualFolder): Promise<void> => {
    const ok = await askConfirm('가상 폴더 삭제', {
      message: `"${folder.name}" 폴더를 삭제해요. 이미지·스택과 하위 폴더는 상위 폴더로 옮겨요.`,
      confirmLabel: '폴더 삭제',
      danger: true
    })
    if (!ok) return
    await window.nais.invoke('library:folderDelete', { id: folder.id })
    if (selectedFolder === folder.id) onSelectFolder(folder.parentId ?? 'unfiled')
    await onReload()
  }
  const toggleFolder = async (folder: LibraryVirtualFolder): Promise<void> => {
    await window.nais.invoke('library:folderCollapse', {
      id: folder.id,
      collapsed: !folder.collapsed
    })
    await onReload()
  }
  const moveFolder = async (id: number, parentId: number | null): Promise<void> => {
    const { moved } = await window.nais.invoke('library:folderMove', { id, parentId })
    if (!moved) toast('폴더를 자기 하위로 옮길 수 없어요', 'error')
    await onReload()
  }

  const rootDrop = (e: React.DragEvent): void => {
    e.preventDefault()
    const entry = readLibraryEntry(e)
    if (entry) {
      void onAssign(entry, null)
      return
    }
    const folderId = Number(e.dataTransfer.getData(LIBRARY_FOLDER_MIME))
    if (Number.isInteger(folderId) && folderId > 0) void moveFolder(folderId, null)
  }

  return (
    <aside className="no-scrollbar w-56 shrink-0 overflow-y-auto px-3 pb-3">
      <SectionTitle label="날짜" />
      <SideRow active={selectedDate == null} onClick={() => onSelectDate(null)}>
        <Images size={14} /> 전체 날짜
      </SideRow>
      {shownDates.map((group) => (
        <SideRow
          key={group.date}
          active={selectedDate === group.date}
          onClick={() => onSelectDate(group.date)}
          count={group.count}
        >
          <Folder size={14} /> {group.date}
        </SideRow>
      ))}
      {dates.length > RECENT_DATES && (
        <button
          className="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[12px] font-medium text-faint transition-colors hover:bg-paper hover:text-ink"
          onClick={() => setShowAllDates(!expanded)}
        >
          {expanded ? '최근 날짜만 보기' : `이전 날짜 ${dates.length - RECENT_DATES}개 더 보기`}
        </button>
      )}

      {mode === 'folders' && (
        <>
          <div className="my-3 h-px bg-line" />
          <SectionTitle
            label="가상 폴더"
            action={
              <button
                className="grid size-6 place-items-center rounded text-muted hover:bg-surface-2 hover:text-ink"
                title="루트 폴더 생성"
                onClick={() => void createFolder(null)}
              >
                <FolderPlus size={14} />
              </button>
            }
          />
          <SideRow active={selectedFolder === 'all'} onClick={() => onSelectFolder('all')}>
            <Images size={14} /> 전체 보기
          </SideRow>
          <div
            onDragOver={(e) => {
              if (hasLibraryEntryDrag(e) || e.dataTransfer.types.includes(LIBRARY_FOLDER_MIME)) {
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
              }
            }}
            onDrop={rootDrop}
          >
            <SideRow
              active={selectedFolder === 'unfiled'}
              onClick={() => onSelectFolder('unfiled')}
            >
              <FolderOpen size={14} /> 미분류
            </SideRow>
          </div>
          <div className="mt-1">
            {tree.map((node) => (
              <VirtualFolderRow
                key={node.id}
                node={node}
                depth={0}
                selected={selectedFolder}
                onSelect={onSelectFolder}
                onCreate={createFolder}
                onRename={renameFolder}
                onDelete={deleteFolder}
                onToggle={toggleFolder}
                onMove={moveFolder}
                onAssign={onAssign}
              />
            ))}
          </div>
        </>
      )}
    </aside>
  )
}

function VirtualFolderRow({
  node,
  depth,
  selected,
  onSelect,
  onCreate,
  onRename,
  onDelete,
  onToggle,
  onMove,
  onAssign
}: {
  node: FolderNode
  depth: number
  selected: FolderSelection
  onSelect: (folder: FolderSelection) => void
  onCreate: (parentId: number | null) => Promise<void>
  onRename: (folder: LibraryVirtualFolder) => Promise<void>
  onDelete: (folder: LibraryVirtualFolder) => Promise<void>
  onToggle: (folder: LibraryVirtualFolder) => Promise<void>
  onMove: (id: number, parentId: number | null) => Promise<void>
  onAssign: (
    entry: { type: 'image' | 'stack'; id: number },
    folderId: number | null
  ) => Promise<void>
}): React.JSX.Element {
  const hasChildren = node.children.length > 0
  const onDrop = (e: React.DragEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    const entry = readLibraryEntry(e)
    if (entry) {
      void onAssign(entry, node.id)
      return
    }
    const folderId = Number(e.dataTransfer.getData(LIBRARY_FOLDER_MIME))
    if (Number.isInteger(folderId) && folderId > 0) void onMove(folderId, node.id)
  }

  return (
    <>
      <div
        draggable
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = 'move'
          e.dataTransfer.setData(LIBRARY_FOLDER_MIME, String(node.id))
        }}
        onDragOver={(e) => {
          if (hasLibraryEntryDrag(e) || e.dataTransfer.types.includes(LIBRARY_FOLDER_MIME)) {
            e.preventDefault()
            e.dataTransfer.dropEffect = 'move'
          }
        }}
        onDrop={onDrop}
        onClick={() => onSelect(node.id)}
        onDoubleClick={() => void onRename(node)}
        className={cn(
          'group flex h-8 cursor-pointer items-center gap-1 rounded-md pr-1 text-[12px] transition-colors',
          selected === node.id
            ? 'bg-accent-soft text-accent'
            : 'text-muted hover:bg-surface-2 hover:text-ink'
        )}
        style={{ paddingLeft: 4 + depth * 14 }}
        title="드래그로 폴더 이동 · 이미지/스택을 놓아 분류"
      >
        <button
          className="grid size-5 shrink-0 place-items-center rounded hover:bg-paper/70"
          onClick={(e) => {
            e.stopPropagation()
            if (hasChildren) void onToggle(node)
          }}
          aria-label={node.collapsed ? '펼치기' : '접기'}
        >
          {hasChildren ? (
            node.collapsed ? (
              <ChevronRight size={13} />
            ) : (
              <ChevronDown size={13} />
            )
          ) : (
            <span className="size-3" />
          )}
        </button>
        <Folder size={14} className="shrink-0 text-amber-400" />
        <span className="min-w-0 flex-1 truncate">{node.name}</span>
        <FolderAction title="하위 폴더 생성" onClick={() => void onCreate(node.id)}>
          <FolderPlus size={12} />
        </FolderAction>
        <FolderAction title="이름 변경" onClick={() => void onRename(node)}>
          <Pencil size={11} />
        </FolderAction>
        <FolderAction danger title="삭제" onClick={() => void onDelete(node)}>
          <Trash2 size={11} />
        </FolderAction>
      </div>
      {!node.collapsed &&
        node.children.map((child) => (
          <VirtualFolderRow
            key={child.id}
            node={child}
            depth={depth + 1}
            selected={selected}
            onSelect={onSelect}
            onCreate={onCreate}
            onRename={onRename}
            onDelete={onDelete}
            onToggle={onToggle}
            onMove={onMove}
            onAssign={onAssign}
          />
        ))}
    </>
  )
}

function StackCard({ stack }: { stack: LibraryStackSummary }): React.JSX.Element {
  return (
    <div
      draggable
      onDragStart={(e) => setLibraryEntryDrag(e, { type: 'stack', id: stack.id })}
      className="group relative aspect-square cursor-grab overflow-hidden rounded-lg border border-line bg-paper active:cursor-grabbing"
      title="가상 폴더로 드래그해 스택 분류"
    >
      {stack.thumbnail ? (
        <img
          decoding="async"
          src={`data:image/webp;base64,${stack.thumbnail}`}
          className="size-full object-cover opacity-80"
          draggable={false}
          alt=""
        />
      ) : (
        <div className="grid size-full place-items-center text-faint">
          <Layers3 size={30} strokeWidth={1.3} />
        </div>
      )}
      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent px-2 pb-2 pt-6 text-white">
        <p className="truncate text-[12px] font-medium">{stack.name}</p>
        <p className="text-[11px] text-white/70">{stack.imageCount}장</p>
      </div>
    </div>
  )
}

function ImageCardSquare({
  item,
  onOpen,
  onDelete,
  deleteFile
}: {
  item: HistoryItem
  onOpen: () => void
  onDelete: () => void
  deleteFile: boolean
}): React.JSX.Element {
  const revision = useGenerationStore((s) => s.imageRevisions[item.filePath])
  const src = revision
    ? imageUrl(item.filePath, revision)
    : item.thumbnail
      ? `data:image/webp;base64,${item.thumbnail}`
      : null
  return (
    <ImageContextMenu
      filePath={item.filePath}
      onDelete={onDelete}
      deleteLabel={deleteFile ? '파일까지 영구 삭제' : '기록에서 제거'}
    >
      <button
        draggable
        onDragStart={(e) => {
          setImagePathDrag(e, item.filePath, { type: 'image', id: item.id })
        }}
        className="relative aspect-square overflow-hidden rounded-lg border border-line bg-paper transition-all hover:ring-2 hover:ring-accent/60"
        title={`seed ${item.seed ?? '?'} · 레퍼런스/가상 폴더로 드래그 가능`}
        onClick={onOpen}
      >
        {src && (
          <img
            decoding="async"
            src={src}
            className="size-full object-cover"
            loading="lazy"
            draggable={false}
            alt=""
          />
        )}
      </button>
    </ImageContextMenu>
  )
}

function ImageCardNatural({
  item,
  onOpen,
  onDelete,
  deleteFile
}: {
  item: HistoryItem
  onOpen: () => void
  onDelete: () => void
  deleteFile: boolean
}): React.JSX.Element {
  const revision = useGenerationStore((s) => s.imageRevisions[item.filePath])
  const src = revision
    ? imageUrl(item.filePath, revision)
    : item.thumbnail
      ? `data:image/webp;base64,${item.thumbnail}`
      : null
  return (
    <ImageContextMenu
      filePath={item.filePath}
      onDelete={onDelete}
      deleteLabel={deleteFile ? '파일까지 영구 삭제' : '기록에서 제거'}
    >
      <button
        draggable
        onDragStart={(e) => {
          setImagePathDrag(e, item.filePath, { type: 'image', id: item.id })
        }}
        className="mb-2 block w-full overflow-hidden rounded-lg border border-line bg-paper transition-all [break-inside:avoid] hover:ring-2 hover:ring-accent/60"
        title={`seed ${item.seed ?? '?'} · 레퍼런스/가상 폴더로 드래그 가능`}
        onClick={onOpen}
      >
        {src && (
          <img
            decoding="async"
            src={src}
            className="w-full"
            loading="lazy"
            draggable={false}
            alt=""
          />
        )}
      </button>
    </ImageContextMenu>
  )
}

function buildFolderTree(folders: LibraryVirtualFolder[]): FolderNode[] {
  const map = new Map<number, FolderNode>()
  for (const folder of folders) map.set(folder.id, { ...folder, children: [] })
  const roots: FolderNode[] = []
  for (const folder of folders) {
    const node = map.get(folder.id)!
    const parent = folder.parentId == null ? null : map.get(folder.parentId)
    if (parent && parent.id !== node.id) parent.children.push(node)
    else roots.push(node)
  }
  const sort = (nodes: FolderNode[]): void => {
    nodes.sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id)
    nodes.forEach((node) => sort(node.children))
  }
  sort(roots)
  return roots
}

function SectionTitle({
  label,
  action
}: {
  label: string
  action?: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="mb-1 flex h-7 items-center px-1 text-[11px] font-semibold uppercase tracking-wide text-faint">
      {label}
      <div className="flex-1" />
      {action}
    </div>
  )
}

function SideRow({
  active,
  onClick,
  count,
  children
}: {
  active: boolean
  onClick: () => void
  count?: number
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex h-9 w-full items-center gap-2 rounded-lg px-2.5 text-left text-[13px] font-medium transition-colors',
        active
          ? 'bg-accent-soft font-semibold text-accent'
          : 'text-muted hover:bg-paper hover:text-ink'
      )}
    >
      {children}
      {count != null && (
        <span className="ml-auto text-[11px] tabular-nums text-faint">
          {count.toLocaleString()}
        </span>
      )}
    </button>
  )
}

function FolderAction({
  title,
  danger,
  onClick,
  children
}: {
  title: string
  danger?: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      title={title}
      className={cn(
        'grid size-5 shrink-0 place-items-center rounded opacity-0 transition-opacity group-hover:opacity-100',
        danger ? 'hover:bg-danger/10 hover:text-danger' : 'hover:bg-paper/80'
      )}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
    >
      {children}
    </button>
  )
}

function HeaderIconButton({
  tip,
  active,
  onClick,
  children
}: {
  tip: string
  active?: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          className={cn(
            'no-drag grid size-7 place-items-center rounded transition-colors',
            active ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-surface-2 hover:text-ink'
          )}
          onClick={onClick}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent>{tip}</TooltipContent>
    </Tooltip>
  )
}
