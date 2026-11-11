import { Check, History, ImageIcon, TextQuote, Trash2, Type } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { CoverArchiveItem, CoverKind, CoverProject } from '@shared/cover'
import { cn } from '../../lib/utils'
import { useCoverStore } from '../../stores/cover-store'
import { askConfirm } from '../../stores/dialog-store'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '../ui/context-menu'
import { Segmented, SegmentedCount, SegmentedItem } from '../ui/segmented'
import { setArchiveDrag } from './archive-drag'

/**
 * 표지 탭 오른쪽 패널: 표지에 넣었던 그림·타이포·문구만 작품별로 모아 보여 준다.
 * 작품에서 빼도 남아 있어서, 업데이트·이식 때 이전 버전을 바로 다시 넣을 수 있다.
 */

type Filter = 'all' | 'background' | 'typo'

const CHECKER: React.CSSProperties = {
  backgroundImage:
    'repeating-conic-gradient(rgba(148, 163, 184, 0.28) 0% 25%, transparent 0% 25% 50%)',
  backgroundSize: '8px 8px'
}

const KIND_LABEL: Record<CoverArchiveItem['kind'], string> = {
  background: '배경',
  typo: '타이포',
  phrase: '문구'
}

function defaultTarget(kind: CoverArchiveItem['kind']): CoverKind | 'phrase' {
  return kind === 'background' ? 'backgrounds' : kind === 'typo' ? 'typos' : 'phrase'
}

function shortDate(t: number): string {
  if (!t) return ''
  const d = new Date(t)
  return d.getMonth() + 1 + '/' + d.getDate()
}

/** 지금 작품에 들어 있는 blob 키 (배경 / 타이포·문구) */
function projectKeys(p: CoverProject | null): { bg: Set<string>; typo: Set<string> } {
  const bg = new Set<string>()
  const typo = new Set<string>()
  if (!p) return { bg, typo }
  for (const b of p.backgrounds) bg.add(b.blobKey)
  for (const t of p.typos) {
    typo.add(t.blobKey)
    for (const x of t.extras ?? []) typo.add(x.blobKey)
  }
  return { bg, typo }
}

export function CoverArchivePanel(): React.JSX.Element {
  const rev = useCoverStore((s) => s.rev)
  const project = useCoverStore((s) => s.project)
  const archive = useCoverStore((s) => s.archive)
  const loadArchive = useCoverStore((s) => s.loadArchive)
  const [filter, setFilter] = useState<Filter>('all')

  useEffect(() => {
    void loadArchive()
  }, [loadArchive])

  // rev: 작품이 제자리에서 바뀌므로 바뀜 신호로 다시 계산
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const inProject = useMemo(() => projectKeys(project), [project, rev])

  const counts = useMemo(() => {
    let background = 0
    for (const a of archive) if (a.kind === 'background') background++
    return { all: archive.length, background, typo: archive.length - background }
  }, [archive])

  const groups = useMemo(() => {
    const shown = archive.filter((a) =>
      filter === 'all'
        ? true
        : filter === 'background'
          ? a.kind === 'background'
          : a.kind !== 'background'
    )
    const map = new Map<
      string,
      { id: string; name: string; items: CoverArchiveItem[]; latest: number }
    >()
    for (const a of shown) {
      const g = map.get(a.projectId)
      if (g) {
        g.items.push(a)
        g.latest = Math.max(g.latest, a.usedAt)
      } else {
        map.set(a.projectId, {
          id: a.projectId,
          name: a.projectName || '이름 없는 작품',
          items: [a],
          latest: a.usedAt
        })
      }
    }
    // 지금 작품을 맨 위로, 나머지는 최근에 쓴 순
    return [...map.values()].sort((a, b) => {
      if (a.id === project?.id) return -1
      if (b.id === project?.id) return 1
      return b.latest - a.latest
    })
  }, [archive, filter, project?.id])

  return (
    <aside className="flex h-full w-[240px] flex-col bg-surface">
      <div className="flex h-14 shrink-0 items-center gap-2 px-4">
        <History size={15} className="text-muted" />
        <span className="text-[15px] font-bold">표지 기록</span>
        <span className="text-[12px] tabular-nums text-faint">
          {archive.length.toLocaleString()}
        </span>
      </div>
      <div className="shrink-0 px-3 pb-2">
        <Segmented
          size="sm"
          value={filter}
          onValueChange={(v) => v && setFilter(v as Filter)}
          className="flex w-full"
        >
          <SegmentedItem value="all" className="flex-1">
            전체 <SegmentedCount>{counts.all}</SegmentedCount>
          </SegmentedItem>
          <SegmentedItem value="background" className="flex-1">
            배경 <SegmentedCount>{counts.background}</SegmentedCount>
          </SegmentedItem>
          <SegmentedItem value="typo" className="flex-1">
            타이포 <SegmentedCount>{counts.typo}</SegmentedCount>
          </SegmentedItem>
        </Segmented>
      </div>
      <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        {groups.length === 0 ? (
          <div className="mt-10 px-2 text-center">
            <p className="text-[12px] font-medium text-muted">
              {archive.length ? '없음' : '표지에 넣은 그림과 타이포가 여기에 모여요'}
            </p>
            {!archive.length && (
              <p className="mt-1.5 text-[11px] leading-relaxed text-faint">
                작품에서 빼도 남아 있어서, 이전 버전을 다시 꺼내 쓸 수 있어요
              </p>
            )}
          </div>
        ) : (
          groups.map((g) => (
            <section key={g.id} className="pt-3 first:pt-0">
              <div className="flex h-6 items-center gap-1.5 px-0.5">
                <span
                  className={cn(
                    'min-w-0 truncate text-[12px] font-semibold',
                    g.id === project?.id ? 'text-ink' : 'text-muted'
                  )}
                  title={g.name}
                >
                  {g.name}
                </span>
                {g.id === project?.id && (
                  <span className="shrink-0 rounded-full bg-accent-soft px-1.5 text-[10px] font-semibold leading-4 text-accent">
                    지금 작품
                  </span>
                )}
                <span className="flex-1" />
                <span className="shrink-0 text-[11px] tabular-nums text-faint">
                  {g.items.length}
                </span>
              </div>
              <div className="mt-1 grid grid-cols-2 gap-1.5">
                {g.items.map((a) => (
                  <ArchiveTile
                    key={a.id}
                    item={a}
                    used={a.blobKeys.some((k) =>
                      (a.kind === 'background' ? inProject.bg : inProject.typo).has(k)
                    )}
                    hasTypo={!!project?.selection.typoId}
                  />
                ))}
              </div>
            </section>
          ))
        )}
      </div>
      {archive.length > 0 && (
        <p className="shrink-0 px-4 pb-3 text-[11px] leading-snug text-faint">
          누르면 지금 작품에 넣어요 · 왼쪽 목록으로 끌어 놓아도 돼요
        </p>
      )}
    </aside>
  )
}

function ArchiveTile({
  item,
  used,
  hasTypo
}: {
  item: CoverArchiveItem
  used: boolean
  hasTypo: boolean
}): React.JSX.Element {
  const add = (as: CoverKind | 'phrase'): void => {
    void useCoverStore.getState().addFromArchive(item.id, as)
  }
  const remove = async (): Promise<void> => {
    const ok = await askConfirm('표지 기록에서 빼기', {
      message: used
        ? '기록의 보관본만 지워요. 지금 작품에 들어 있는 그림은 그대로예요.'
        : '이 그림의 보관본을 지워요. 작품에서도 뺀 그림이면 다시 꺼낼 수 없어요.',
      confirmLabel: '기록에서 빼기',
      danger: true
    })
    if (ok) await useCoverStore.getState().removeArchive(item.id)
  }
  const isBg = item.kind === 'background'
  const target = defaultTarget(item.kind)
  const actionLabel =
    target === 'backgrounds'
      ? '배경으로 넣기'
      : target === 'typos'
        ? '타이포로 넣기'
        : '고른 타이포에 문구로 붙이기'

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          className="group relative aspect-square overflow-hidden rounded-lg bg-paper outline-none transition-shadow hover:ring-2 hover:ring-accent/40 focus-visible:ring-2 focus-visible:ring-accent"
          style={isBg ? undefined : CHECKER}
          title={
            item.name +
            '\n' +
            KIND_LABEL[item.kind] +
            ' · ' +
            item.width +
            '×' +
            item.height +
            ' · ' +
            shortDate(item.addedAt) +
            ' 처음 씀\n누르면 ' +
            actionLabel
          }
          draggable
          onDragStart={(e) => setArchiveDrag(e, item.id, item.path)}
          onClick={() => add(target)}
        >
          {item.thumb && (
            <img
              decoding="async"
              draggable={false}
              src={'data:image/webp;base64,' + item.thumb}
              className={cn(
                'pointer-events-none size-full',
                isBg ? 'object-cover' : 'object-contain p-1.5'
              )}
              alt=""
            />
          )}
          <span className="pointer-events-none absolute bottom-1 left-1 rounded bg-black/45 px-1 text-[10px] font-medium leading-4 text-white backdrop-blur">
            {item.kind === 'phrase' ? '문구 · ' : ''}
            {shortDate(item.addedAt)}
          </span>
          {used && (
            <span
              className="pointer-events-none absolute left-1 top-1 grid size-4 place-items-center rounded-full bg-accent-fill text-on-accent"
              title="지금 작품에 들어 있어요"
            >
              <Check size={10} strokeWidth={3} />
            </span>
          )}
          <span
            role="button"
            className="absolute right-1 top-1 grid size-6 place-items-center rounded-full bg-black/45 text-white opacity-0 backdrop-blur transition hover:bg-danger group-hover:opacity-100"
            title="기록에서 빼기"
            onClick={(e) => {
              e.stopPropagation()
              void remove()
            }}
          >
            <Trash2 size={12} />
          </span>
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => add('backgrounds')}>
          <ImageIcon size={13} className="text-muted" /> 배경으로 넣기
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => add('typos')}>
          <Type size={13} className="text-muted" /> 타이포로 넣기
        </ContextMenuItem>
        <ContextMenuItem disabled={!hasTypo} onSelect={() => add('phrase')}>
          <TextQuote size={13} className="text-muted" /> 고른 타이포에 문구로 붙이기
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem danger onSelect={() => void remove()}>
          <Trash2 size={13} /> 기록에서 빼기
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
