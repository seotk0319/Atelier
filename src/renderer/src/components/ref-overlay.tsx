import {
  CheckSquare,
  Copy,
  FolderPlus,
  ImagePlus,
  Pencil,
  Search,
  SlidersHorizontal,
  Trash2,
  X
} from 'lucide-react'
import { useCallback, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CharRefItem, CharRefType, VibeItem } from '@shared/types'
import {
  isRefSent,
  REF_PARTS,
  shownRefParts,
  refPartsHint,
  refShortLabel,
  refStrengthMax,
  REF_TYPE_CHOICES,
  showsFidelity,
  toggleRefPart
} from '@shared/char-refs'
import { isMediumEffort, isV5Model } from '@shared/nai-models'
import { cn } from '../lib/utils'
import { applyClickSelection, useSelectAllShortcut } from '../lib/edit-selection'
import { droppedImagePaths, hasImageDrop } from '../lib/image-drag'
import { isLeavingDropZone, useDragEndCleanup } from '../lib/drop-zone'
import { buildDisplayRows } from '../lib/folder-list'
import { refsStoreFor } from '../stores/refs-store'
import { useGenerationStore } from '../stores/generation-store'
import { askConfirm, askText } from '../stores/dialog-store'
import { toast } from '../stores/toast-store'
import { FolderListView } from './folder-list-view'
import { Button } from './ui/button'
import { ContextMenuItem, ContextMenuSeparator } from './ui/context-menu'
import { Dialog, DialogContent, DialogTitle } from './ui/dialog'
import { Input } from './ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'
import { Slider } from './ui/slider'
import { Switch } from './ui/switch'

/**
 * 바이브/캐릭레퍼 라이브러리 — 캐릭터 프롬프트와 동일한 얇은 카드 + 펼치기 방식.
 * 헤더: 토글 / 썸네일(호버 미리보기) / 이름. 펼치면 전체 이미지 + 파라미터.
 */
export function RefOverlay({ kind }: { kind: 'vibe' | 'charref' }): React.JSX.Element {
  const store = refsStoreFor(kind)
  const model = useGenerationStore((s) => s.request.model)
  const setOverlayOpen = store((s) => s.setOverlayOpen)
  const folders = store((s) => s.folders)
  const items = store((s) => s.items)
  const add = store((s) => s.add)
  const addPaths = store((s) => s.addPaths)
  const update = store((s) => s.update)
  const remove = store((s) => s.remove)
  const duplicate = store((s) => s.duplicate)
  const createFolder = store((s) => s.createFolder)
  const renameFolder = store((s) => s.renameFolder)
  const toggleCollapse = store((s) => s.toggleCollapse)
  const setFolderColor = store((s) => s.setFolderColor)
  const removeFolder = store((s) => s.removeFolder)
  const move = store((s) => s.move)

  const [search, setSearch] = useState('')
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [preview, setPreview] = useState<{ src: string; top: number; left: number } | null>(null)
  const [dropOver, setDropOver] = useState(false)
  const clearDrop = useCallback(() => setDropOver(false), [])
  useDragEndCleanup(clearDrop)

  const onDropImages = async (e: React.DragEvent): Promise<void> => {
    if (!hasImageDrop(e)) return
    e.preventDefault()
    e.stopPropagation()
    setDropOver(false)
    const paths = droppedImagePaths(e)
    const count = await addPaths(paths, null)
    if (count > 0) toast(`레퍼런스 ${count}장 추가됨`, 'success')
    else toast('추가할 수 있는 이미지가 없어요', 'info')
  }

  // 편집 모드 — 다중 선택 (일반 클릭=교체, Ctrl=토글, Shift=구간, Ctrl+A=전체)
  const [editMode, setEditMode] = useState(false)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [bulkParamsOpen, setBulkParamsOpen] = useState(false)
  const anchorRef = useRef<number | null>(null)
  const toggleEditMode = (): void => {
    setEditMode((v) => !v)
    setSelected(new Set())
    setExpandedId(null)
    anchorRef.current = null
  }

  const searching = search.trim().length > 0
  const rows = useMemo(() => {
    const all = buildDisplayRows(folders, items as { id: number; folderId: number | null }[])
    if (!searching) return all
    const q = search.trim().toLowerCase()
    return all.filter(
      (r) =>
        r.type === 'item' &&
        (items.find((i) => i.id === r.item.id)?.name ?? '').toLowerCase().includes(q)
    )
  }, [folders, items, searching, search])

  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items])
  const enabledCount = items.filter((i) => i.enabled).length
  // 이 모델로 실제로 보내는 레퍼런스 수 (V4.5는 의상을 뺀다)
  const sentCount =
    kind === 'charref'
      ? items.filter((i) => i.enabled && isRefSent((i as CharRefItem).refType, model)).length
      : enabledCount

  // 화면에 보이는 순서의 아이템 id들 (Shift 구간/Ctrl+A 기준)
  const visibleIds = useMemo(
    () => rows.flatMap((r) => (r.type === 'item' && !r.hidden ? [r.item.id] : [])),
    [rows]
  )
  useSelectAllShortcut(editMode, () => setSelected(new Set(visibleIds)))
  const selectItem = (id: number, e: React.MouseEvent): void =>
    setSelected((prev) => applyClickSelection(prev, visibleIds, id, e, anchorRef))
  // memo된 카드가 편집 모드/선택 변화에 리렌더되도록
  // 레퍼런스 카드는 모델(V4.5/V5)에 따라 보이는 칸이 달라서 모델이 바뀌어도 다시 그린다
  const renderKey = useMemo(
    () => ({ selected: editMode ? selected : null, model }),
    [editMode, selected, model]
  )

  const bulkDelete = async (): Promise<void> => {
    if (
      !(await askConfirm('선택 삭제', {
        message: `선택한 ${selected.size}개를 삭제해요.`,
        confirmLabel: '삭제',
        danger: true
      }))
    )
      return
    for (const id of selected) remove(id)
    setSelected(new Set())
  }
  const bulkDuplicate = async (): Promise<void> => {
    // 보이는 순서대로 복제
    for (const id of visibleIds.filter((id) => selected.has(id))) await duplicate(id)
    setSelected(new Set())
  }

  const showPreview = (e: React.MouseEvent, thumb: string): void => {
    const card = (e.currentTarget as HTMLElement).closest('[data-ref-card]')
    if (!card) return
    const rect = card.getBoundingClientRect()
    const size = 176
    const top = Math.max(
      8,
      Math.min(rect.top + rect.height / 2 - size / 2, window.innerHeight - size - 8)
    )
    setPreview({ src: thumb, top, left: rect.right + 10 })
  }

  const renderHeader = (row: { id: number }): React.ReactNode => {
    const item = byId.get(row.id)
    if (!item) return null
    if (editMode) {
      const checked = selected.has(item.id)
      return (
        <div
          className="flex h-10 cursor-pointer select-none items-center gap-2 px-2"
          onClick={(e) => selectItem(item.id, e)}
        >
          <span
            className={cn(
              'grid size-4 shrink-0 place-items-center rounded border-2',
              checked ? 'border-accent-fill bg-accent-fill text-on-accent' : 'border-line'
            )}
          >
            {checked && <span className="text-[11px] leading-none">✓</span>}
          </span>
          {item.thumbnail ? (
            <img
              src={`data:image/webp;base64,${item.thumbnail}`}
              className="size-7 shrink-0 rounded object-cover"
              alt=""
              draggable={false}
            />
          ) : (
            <span className="grid size-7 shrink-0 place-items-center rounded bg-surface-2 text-faint">
              <ImagePlus size={14} strokeWidth={1.5} />
            </span>
          )}
          <span className="min-w-0 flex-1 truncate text-[13px] text-ink">
            {item.name || <span className="text-faint">이름 없음</span>}
          </span>
          <span className="shrink-0 font-mono text-[11px] text-faint">
            {kind === 'vibe'
              ? `s${(item as VibeItem).strength.toFixed(2)}`
              : refShortLabel((item as CharRefItem).refType, model)}
          </span>
        </div>
      )
    }
    return (
      <div
        data-ref-card
        className={cn(
          'flex h-10 items-center gap-2 px-2',
          // 꺼졌거나, 켜져 있어도 이 모델에서는 빼고 보내는 레퍼런스(V4.5의 의상)는 흐리게
          (!item.enabled ||
            (kind === 'charref' && !isRefSent((item as CharRefItem).refType, model))) &&
            'opacity-55'
        )}
      >
        <Switch checked={item.enabled} onCheckedChange={(v) => update(item.id, { enabled: v })} />
        {item.thumbnail ? (
          <img
            src={`data:image/webp;base64,${item.thumbnail}`}
            className="size-7 shrink-0 rounded object-cover"
            alt=""
            onMouseEnter={(e) => showPreview(e, item.thumbnail)}
            onMouseLeave={() => setPreview(null)}
          />
        ) : (
          <div className="grid size-7 shrink-0 place-items-center rounded bg-surface-2 text-faint">
            <ImagePlus size={14} strokeWidth={1.5} />
          </div>
        )}
        <button
          className="min-w-0 flex-1 truncate text-left text-[13px] text-ink"
          onClick={() => setExpandedId((prev) => (prev === item.id ? null : item.id))}
        >
          {item.name || <span className="text-faint">이름 없음</span>}
        </button>
        {/* 바이브 인코딩 완료 표시 — 채워진 점=인코딩됨, 빈 점=생성 시 인코딩 예정 */}
        {kind === 'vibe' && (
          <span
            className={cn(
              'size-1.5 shrink-0 rounded-full',
              (item as VibeItem).encodedReady ? 'bg-emerald-500' : 'border border-faint'
            )}
            title={
              (item as VibeItem).encodedReady ? '인코딩됨' : '미인코딩 (생성 시 인코딩, 2 Anlas)'
            }
          />
        )}
        <span className="shrink-0 font-mono text-[11px] text-faint">
          {kind === 'vibe'
            ? `s${(item as VibeItem).strength.toFixed(2)}`
            : refShortLabel((item as CharRefItem).refType, model, (item as CharRefItem).strength)}
        </span>
      </div>
    )
  }

  const renderExpanded = (row: { id: number }): React.ReactNode => {
    const item = byId.get(row.id)
    if (!item) return null
    return (
      <div className="flex flex-col gap-2 px-2 pb-2">
        {item.thumbnail && (
          <img
            src={`data:image/webp;base64,${item.thumbnail}`}
            className="max-h-48 w-full rounded-md border border-line object-contain"
            alt=""
          />
        )}
        <div className="flex gap-1.5">
          <Input
            className="h-7 flex-1 text-[12px]"
            value={item.name}
            placeholder="이름 (선택)"
            onChange={(e) => update(item.id, { name: e.target.value })}
          />
          <Button
            size="sm"
            variant="ghost"
            className="h-7 w-7 p-0 hover:text-danger"
            title="삭제"
            onClick={() => remove(item.id)}
          >
            <Trash2 size={13} />
          </Button>
        </div>
        {kind === 'vibe' ? (
          <VibeParams item={item as VibeItem} update={update} />
        ) : (
          <CharRefParams item={item as CharRefItem} update={update} model={model} />
        )}
      </div>
    )
  }

  return (
    <div
      className={cn(
        'relative flex h-full flex-col gap-2 rounded-lg transition-shadow',
        dropOver && 'ring-2 ring-accent ring-inset'
      )}
      onDragEnter={(e) => {
        if (hasImageDrop(e)) {
          e.preventDefault()
          setDropOver(true)
        }
      }}
      onDragOver={(e) => {
        if (hasImageDrop(e)) {
          e.preventDefault()
          e.dataTransfer.dropEffect = 'copy'
          setDropOver(true)
        }
      }}
      onDragLeave={(e) => {
        if (isLeavingDropZone(e)) setDropOver(false)
      }}
      onDrop={(e) => void onDropImages(e)}
    >
      {dropOver && (
        <div className="pointer-events-none absolute inset-0 z-40 grid place-items-center rounded-lg bg-accent/10 backdrop-blur-[1px]">
          <div className="rounded-lg border border-accent bg-paper/95 px-4 py-2 text-[13px] font-medium text-accent shadow-lg">
            놓아서 레퍼런스에 추가
          </div>
        </div>
      )}
      <div className="flex items-center gap-2">
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          title="닫기"
          onClick={() => setOverlayOpen(false)}
        >
          <X size={15} />
        </Button>
        <span className="text-[13px] font-medium">
          {kind === 'vibe' ? '바이브 트랜스퍼' : '레퍼런스'}
        </span>
        {sentCount > 0 && (
          <span className="rounded-full bg-accent-soft px-1.5 font-mono text-[11px] text-accent">
            {sentCount}
          </span>
        )}
      </div>

      {/* V5에서 레퍼런스를 켜면 장당 5 Anlas가 붙고, 절약 모드는 일반으로 바뀐다 — 모델 줄이 이 창에 가려지므로 여기서 알린다 */}
      {kind === 'charref' && isV5Model(model) && sentCount > 0 && (
        <p className="rounded-lg bg-accent-soft px-2.5 py-1.5 text-[11px] leading-relaxed text-accent">
          {isMediumEffort(model) ? '절약 모드는 레퍼런스를 못 써서 V5 일반으로 생성돼요 · ' : ''}
          레퍼런스 1개당 그림 1장에 5 Anlas가 붙어요
        </p>
      )}

      <div className="flex items-center gap-1.5">
        <div className="relative flex-1">
          <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-faint" />
          <Input
            className="pl-7"
            value={search}
            placeholder="검색"
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Button
          size="sm"
          variant="ghost"
          title="폴더 추가"
          onClick={() => void createFolder('새 폴더')}
        >
          <FolderPlus size={14} />
        </Button>
        <Button
          size="sm"
          variant={editMode ? 'accent' : 'ghost'}
          title="편집 모드 (다중 선택 — 클릭 토글, Shift+클릭 구간, Ctrl+A 전체)"
          onClick={toggleEditMode}
        >
          <CheckSquare size={14} />
        </Button>
        <Button size="sm" variant="accent" className="gap-1" onClick={() => void add(null)}>
          <ImagePlus size={13} /> 추가
        </Button>
      </div>

      {/* 편집 모드 일괄 작업 바 — 검색 아래 */}
      {editMode && (
        <div className="flex flex-wrap items-center gap-1 border-b border-line pb-2 text-[12px]">
          <span className="text-muted">{selected.size}개</span>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set(visibleIds))}>
            전체
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={selected.size === 0}
            onClick={() => setSelected(new Set())}
          >
            해제
          </Button>
          <div className="flex-1" />
          <Button
            size="sm"
            variant="ghost"
            className="gap-1"
            disabled={selected.size === 0}
            onClick={() => void bulkDuplicate()}
          >
            <Copy size={12} /> 복제
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="gap-1"
            disabled={selected.size === 0}
            onClick={() => setBulkParamsOpen(true)}
          >
            <SlidersHorizontal size={12} /> 파라미터
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="gap-1 text-danger hover:text-danger"
            disabled={selected.size === 0}
            onClick={() => void bulkDelete()}
          >
            <Trash2 size={12} /> 삭제
          </Button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden no-scrollbar">
        <FolderListView
          rows={rows}
          searching={searching}
          expandedId={editMode ? null : expandedId}
          renderKey={renderKey}
          folderActions={{
            rename: renameFolder,
            toggleCollapse,
            setColor: setFolderColor,
            remove: removeFolder,
            addItem: (folderId) => void add(folderId)
          }}
          onMove={move}
          itemClassName={(row) =>
            cn(
              'transition-colors hover:border-muted/60', // F2
              editMode
                ? selected.has(row.id) && 'border-accent ring-1 ring-accent/40'
                : byId.get(row.id)?.enabled && 'border-accent/60 bg-accent-soft' // F3
            )
          }
          renderHeader={renderHeader}
          renderExpanded={renderExpanded}
          itemContextMenu={(row) => (
            <>
              <ContextMenuItem
                onSelect={async () => {
                  const name = await askText('이름 변경', byId.get(row.id)?.name ?? '')
                  if (name != null) update(row.id, { name })
                }}
              >
                <Pencil size={13} /> 이름 변경
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem danger onSelect={() => remove(row.id)}>
                <Trash2 size={13} /> 삭제
              </ContextMenuItem>
            </>
          )}
          emptyText={items.length === 0 ? '이미지를 추가해보세요' : '검색 결과 없음'}
        />
      </div>

      {bulkParamsOpen && (
        <BulkParamsDialog
          kind={kind}
          model={model}
          count={selected.size}
          onApply={(patch) => {
            for (const id of selected) update(id, patch)
            setBulkParamsOpen(false)
          }}
          onClose={() => setBulkParamsOpen(false)}
        />
      )}

      {preview &&
        createPortal(
          <img
            src={`data:image/webp;base64,${preview.src}`}
            className="pointer-events-none fixed z-50 size-44 rounded-lg border border-line object-cover shadow-2xl"
            style={{ top: preview.top, left: preview.left }}
            alt=""
          />,
          document.body
        )}
    </div>
  )
}

/**
 * 선택 항목 파라미터 일괄 적용 — vibe: 강도/정보, charref: 따라 할 것/강도(+V4.5 충실도).
 * 레퍼런스는 기본이 「그대로 두기」라서 바꾸겠다고 고른 것만 덮어쓴다.
 */
function BulkParamsDialog({
  kind,
  model,
  count,
  onApply,
  onClose
}: {
  kind: 'vibe' | 'charref'
  model: string
  count: number
  onApply: (patch: Record<string, unknown>) => void
  onClose: () => void
}): React.JSX.Element {
  const [strength, setStrength] = useState(kind === 'vibe' ? 0.6 : 1)
  const [info, setInfo] = useState(0.7)
  const [fidelity, setFidelity] = useState(0.5)
  const [refTypeSel, setRefTypeSel] = useState<CharRefType | 'keep'>('keep')
  const [strengthOn, setStrengthOn] = useState(kind === 'vibe')
  const [fidelityOn, setFidelityOn] = useState(false)
  const v5 = isV5Model(model)
  const fidelityShown = showsFidelity(model)
  const strengthMax = kind === 'vibe' ? 1 : refStrengthMax(model)

  const refPatch = (): Record<string, unknown> => {
    const patch: Record<string, unknown> = {}
    if (refTypeSel !== 'keep') patch.refType = refTypeSel
    if (strengthOn) patch.strength = strength
    if (fidelityShown && fidelityOn) patch.fidelity = fidelity
    return patch
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm p-4">
        <DialogTitle className="mb-1">파라미터 일괄 적용</DialogTitle>
        <p className="mb-3 text-[12px] text-muted">
          선택한 {count}개에 아래 값을 적용해요.
          {kind === 'charref' && ' 「그대로 두기」와 체크하지 않은 칸은 바꾸지 않아요.'}
        </p>
        <div className="flex flex-col gap-2.5">
          {kind === 'charref' && (
            <ParamRow label="따라 할 것">
              <Select
                value={refTypeSel}
                onValueChange={(v) => setRefTypeSel(v as CharRefType | 'keep')}
              >
                <SelectTrigger className="h-7 flex-1 text-[12px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="keep">그대로 두기</SelectItem>
                  {REF_TYPE_CHOICES.filter((c) => v5 || !c.v5Only).map((c) => (
                    <SelectItem key={c.type} value={c.type}>
                      {c.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </ParamRow>
          )}
          <ParamRow
            label={
              kind === 'vibe'
                ? `강도 ${strength.toFixed(2)}`
                : `강도 ${strength.toFixed(2)} / ${strengthMax}`
            }
          >
            {kind === 'charref' && (
              <input
                type="checkbox"
                aria-label="강도 바꾸기"
                title="체크하면 강도를 바꿔요"
                checked={strengthOn}
                onChange={(e) => setStrengthOn(e.target.checked)}
                className="size-3.5 shrink-0"
              />
            )}
            <Slider
              min={0}
              max={strengthMax}
              step={0.05}
              value={[strength]}
              disabled={!strengthOn}
              onValueChange={([v]) => setStrength(Math.round(v * 100) / 100)}
            />
          </ParamRow>
          {kind === 'vibe' ? (
            <ParamRow label={`정보 ${info.toFixed(2)}`}>
              <Slider
                min={0}
                max={1}
                step={0.05}
                value={[info]}
                onValueChange={([v]) => setInfo(Math.round(v * 100) / 100)}
              />
            </ParamRow>
          ) : (
            fidelityShown && (
              <ParamRow label={`충실도 ${fidelity.toFixed(2)}`}>
                <input
                  type="checkbox"
                  aria-label="충실도 바꾸기"
                  title="체크하면 충실도를 바꿔요"
                  checked={fidelityOn}
                  onChange={(e) => setFidelityOn(e.target.checked)}
                  className="size-3.5 shrink-0"
                />
                <Slider
                  min={0}
                  max={1}
                  step={0.05}
                  value={[fidelity]}
                  disabled={!fidelityOn}
                  onValueChange={([v]) => setFidelity(Math.round(v * 100) / 100)}
                />
              </ParamRow>
            )
          )}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            닫기
          </Button>
          <Button
            variant="accent"
            onClick={() =>
              onApply(kind === 'vibe' ? { strength, infoExtracted: info } : refPatch())
            }
          >
            적용
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function ParamRow({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <span className="w-[84px] shrink-0 whitespace-nowrap text-[12px] text-muted">{label}</span>
      {children}
    </div>
  )
}

function VibeParams({
  item,
  update
}: {
  item: VibeItem
  update: (id: number, patch: Record<string, unknown>) => void
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      <ParamRow label={`강도 ${item.strength.toFixed(2)}`}>
        <Slider
          min={0}
          max={1}
          step={0.05}
          value={[item.strength]}
          onValueChange={([v]) => update(item.id, { strength: Math.round(v * 100) / 100 })}
        />
      </ParamRow>
      <ParamRow label={`정보 ${item.infoExtracted.toFixed(2)}`}>
        <Slider
          min={0}
          max={1}
          step={0.05}
          value={[item.infoExtracted]}
          onValueChange={([v]) => update(item.id, { infoExtracted: Math.round(v * 100) / 100 })}
        />
      </ParamRow>
      {!item.encodedReady && (
        <p className="text-[11px] text-faint">생성 시 인코딩 (2 Anlas, 이후 캐시)</p>
      )}
    </div>
  )
}

function CharRefParams({
  item,
  update,
  model
}: {
  item: CharRefItem
  update: (id: number, patch: Record<string, unknown>) => void
  model: string
}): React.JSX.Element {
  const modelMax = refStrengthMax(model)
  // 다른 모델에서 올려 둔 강도가 슬라이더 끝에 묻히지 않게 지금 값까지는 늘려 둔다 (값은 그대로 보낸다)
  const max = Math.max(modelMax, Math.ceil(item.strength))
  const sent = isRefSent(item.refType, model)
  return (
    <div className="flex flex-col gap-1.5">
      <RefTypeFields
        refType={item.refType}
        model={model}
        onChange={(refType) => update(item.id, { refType })}
      />
      {/* 이 모델에서 빼고 보내는 레퍼런스(V4.5의 의상)는 값 칸을 숨긴다 */}
      {sent && (
        <ParamRow label={`강도 ${item.strength.toFixed(2)} / ${modelMax}`}>
          <Slider
            min={0}
            max={max}
            step={0.05}
            value={[item.strength]}
            onValueChange={([v]) => update(item.id, { strength: Math.round(v * 100) / 100 })}
          />
        </ParamRow>
      )}
      {sent && showsFidelity(model) && (
        <ParamRow label={`충실도 ${item.fidelity.toFixed(2)}`}>
          <Slider
            min={0}
            max={1}
            step={0.05}
            value={[item.fidelity]}
            onValueChange={([v]) => update(item.id, { fidelity: Math.round(v * 100) / 100 })}
          />
        </ParamRow>
      )}
    </div>
  )
}

/**
 * 레퍼 그림에서 무엇을 따라 할지 — 얼굴·머리 / 옷 / 그림체를 켜고 끈다 (여러 개 고름).
 * 실제 저장값(description)은 켠 칸의 조합이다 (shared/char-refs.ts). NAI에 없는 조합은 못 누른다.
 */
function RefTypeFields({
  refType,
  model,
  onChange
}: {
  refType: CharRefType
  model: string
  onChange: (refType: CharRefType) => void
}): React.JSX.Element {
  const on = shownRefParts(refType, model)
  const sent = isRefSent(refType, model)
  return (
    <>
      <ParamRow label="따라 할 것">
        <span role="group" aria-label="따라 할 것" className="flex flex-1 gap-1">
          {REF_PARTS.map((p) => {
            const checked = on.includes(p.value)
            const result = toggleRefPart(refType, p.value, model)
            const blocked = 'blocked' in result ? result.blocked : null
            return (
              <button
                key={p.value}
                type="button"
                aria-pressed={checked}
                aria-disabled={blocked != null}
                title={
                  blocked ?? (checked ? `${p.label} 따라 하기 끄기` : `${p.label}도 따라 하기`)
                }
                onClick={() => {
                  if ('type' in result) onChange(result.type)
                  else toast(result.blocked, 'info')
                }}
                className={cn(
                  'flex h-7 flex-1 items-center justify-center gap-1 rounded-md border text-[12px] font-medium transition-colors',
                  checked
                    ? 'border-accent bg-accent-soft text-accent'
                    : 'border-line bg-surface-2 text-muted hover:text-ink',
                  blocked != null && !checked && 'opacity-45 hover:text-muted',
                  blocked != null && 'cursor-not-allowed'
                )}
              >
                <span
                  className={cn(
                    'grid size-3.5 shrink-0 place-items-center rounded-[4px] border text-[10px] leading-none',
                    checked ? 'border-accent bg-accent-fill text-on-accent' : 'border-line'
                  )}
                >
                  {checked && '✓'}
                </span>
                {p.label}
              </button>
            )
          })}
        </span>
      </ParamRow>
      <p
        className={cn(
          'pl-[92px] text-[11px] leading-snug',
          sent ? 'text-faint' : 'font-semibold text-accent'
        )}
      >
        {refPartsHint(refType, model)}
      </p>
    </>
  )
}
