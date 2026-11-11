import { ChevronDown, ChevronUp } from 'lucide-react'
import { useEffect, useState } from 'react'
import { create } from 'zustand'
import type { McpActivity, McpStatus } from '@shared/types'
import { platformName } from '@shared/inbox-works'
import { groupQueue, trackTotals, type QueueGroup } from '../lib/queue-groups'
import { cn } from '../lib/utils'
import { useGenerationStore } from '../stores/generation-store'
import { presetIdOfScene, useScenesStore } from '../stores/scenes-store'
import { Button } from './ui/button'

type DockTab = 'queue' | 'ai'

function readLocal(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
function writeLocal(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // 저장 못 해도 화면은 그대로 쓴다
  }
}

/** 대기열 묶음과 묶음별 전체 장수. 아래 칸을 접어 둬도 계속 센다 */
const useQueueGroups = create<{ groups: QueueGroup[]; totals: Map<string, number> }>(() => ({
  groups: [],
  totals: new Map()
}))

function recomputeGroups(): void {
  const items = useGenerationStore.getState().queue?.items ?? []
  const presets = useScenesStore.getState().presets
  const groups = groupQueue(items, presetIdOfScene, (id) => presets.find((p) => p.id === id)?.name)
  useQueueGroups.setState((s) => ({ groups, totals: trackTotals(s.totals, groups) }))
}
recomputeGroups()
useGenerationStore.subscribe((s, prev) => {
  if (s.queue !== prev.queue) recomputeGroups()
})
useScenesStore.subscribe((s, prev) => {
  if (s.presets !== prev.presets || s.scenes !== prev.scenes) recomputeGroups()
})

function TabButton({
  active,
  onClick,
  children
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        'relative h-11 shrink-0 whitespace-nowrap px-2.5 text-[14px] font-semibold outline-none transition-colors focus-visible:bg-surface-2',
        active ? 'text-ink' : 'text-muted hover:text-ink'
      )}
    >
      {children}
      {active && <span aria-hidden className="absolute inset-x-2.5 -bottom-px h-0.5 bg-mark" />}
    </button>
  )
}

const TH =
  'sticky top-0 whitespace-nowrap bg-surface px-2 py-2.5 text-left text-[12px] font-normal text-faint first:pl-3 last:pr-3 last:text-right'
const TD =
  'whitespace-nowrap border-t border-line px-2 py-2.5 text-[13px] first:pl-3 last:pr-3 last:text-right'

function QueueTable(): React.JSX.Element {
  const groups = useQueueGroups((s) => s.groups)
  const totals = useQueueGroups((s) => s.totals)
  if (groups.length === 0)
    return <p className="px-3 py-6 text-center text-[13px] text-faint">기다리는 생성이 없어요</p>
  return (
    <table className="w-full border-collapse">
      <thead>
        <tr>
          <th className={TH}>묶음</th>
          <th className={TH}>상태</th>
          <th className={TH}>진행</th>
          <th className={TH}>모델</th>
          <th className={TH}>크기</th>
          <th className={TH}>
            <span className="sr-only">취소</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {groups.map((g) => {
          const total = Math.max(totals.get(g.key) ?? g.live, g.live)
          const done = total - g.live
          const pct = total > 0 ? (done / total) * 100 : 0
          return (
            <tr key={g.key} className="hover:bg-surface-2">
              <td className={cn(TD, 'max-w-[280px] truncate font-semibold')} title={g.label}>
                {g.label}
              </td>
              <td className={TD}>
                {g.state === 'generating' ? (
                  <span className="inline-flex h-5 items-center rounded-[3px] bg-accent-soft px-1.5 text-[12px] font-semibold text-accent">
                    생성 중
                  </span>
                ) : (
                  <span className="text-muted">대기</span>
                )}
              </td>
              <td className={cn(TD, 'tabular-nums')}>
                <span
                  className="mr-2 inline-block h-1 w-[120px] bg-surface-3 align-middle"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={total}
                  aria-valuenow={done}
                  aria-label={`${g.label} 진행`}
                >
                  <i className="block h-full bg-mark" style={{ width: `${pct}%` }} />
                </span>
                {done.toLocaleString()} / {total.toLocaleString()}
              </td>
              <td className={TD}>{g.model}</td>
              <td className={cn(TD, 'tabular-nums')}>{g.size}</td>
              <td className={TD}>
                <button
                  className="rounded px-1.5 py-0.5 text-[13px] text-muted outline-none hover:text-danger focus-visible:ring-2 focus-visible:ring-accent/40"
                  title={`${g.label}의 남은 ${g.live.toLocaleString()}장을 취소해요`}
                  onClick={() => void window.nais.invoke('queue:cancel', { ids: g.ids })}
                >
                  취소
                </button>
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

function formatWhen(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const now = new Date()
  const day = (x: Date): number => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diff = Math.round((day(now) - day(d)) / 86_400_000)
  if (diff === 0)
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  if (diff === 1) return '어제'
  return `${d.getMonth() + 1}월 ${d.getDate()}일`
}

function ActivityTable({ items }: { items: McpActivity[] }): React.JSX.Element {
  if (items.length === 0)
    return <p className="px-3 py-6 text-center text-[13px] text-faint">아직 기록이 없어요</p>
  return (
    <table className="w-full border-collapse">
      <thead>
        <tr>
          <th className={TH}>시각</th>
          <th className={TH}>플랫폼</th>
          <th className={TH}>작품</th>
          <th className={TH}>한 일</th>
          <th className={TH}>결과</th>
        </tr>
      </thead>
      <tbody>
        {items.map((a) => (
          <tr key={a.id} className="hover:bg-surface-2">
            <td className={cn(TD, 'tabular-nums text-faint')} title={a.at}>
              {formatWhen(a.at)}
            </td>
            <td className={TD}>{a.site ? platformName(a.site) : '—'}</td>
            <td className={cn(TD, 'max-w-[260px] truncate')} title={a.workTitle ?? undefined}>
              {a.workTitle ?? '—'}
            </td>
            <td className={cn(TD, 'max-w-[360px] truncate')} title={`${a.summary} (${a.tool})`}>
              {a.summary}
            </td>
            <td className={TD}>
              {!a.ok ? (
                <span className="font-semibold text-bad" title={a.error ?? undefined}>
                  실패
                </span>
              ) : a.verified === true ? (
                <span className="font-semibold text-good">저장 확인</span>
              ) : (
                <span className="text-faint">—</span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** 작품 MCP 기록과 상태. 본체 쪽 처리가 아직 없으면(호출 실패) 빈 목록으로 둔다 */
function useMcp(): { items: McpActivity[]; status: McpStatus | null; known: boolean } {
  const [items, setItems] = useState<McpActivity[]>([])
  const [status, setStatus] = useState<McpStatus | null>(null)
  const [known, setKnown] = useState(true)
  useEffect(() => {
    let alive = true
    window.nais
      .invoke('mcp:activity', { limit: 50 })
      .then((r) => {
        if (alive) setItems(r?.items ?? [])
      })
      .catch(() => {
        if (alive) setItems([])
      })
    window.nais
      .invoke('mcp:status', undefined)
      .then((s) => {
        if (alive) setStatus(s ?? null)
      })
      .catch(() => {
        if (alive) setKnown(false)
      })
    const off = window.nais.on('mcp:activityAdded', (a) => {
      setItems((list) => [a, ...list.filter((x) => x.id !== a.id)].slice(0, 50))
    })
    return () => {
      alive = false
      off()
    }
  }, [])
  return { items, status, known }
}

/**
 * 생성·씬 탭 아래 칸: 대기열 | AI가 한 일. 접으면 머리줄만 남고, 접힘과 고른 탭은 기억한다.
 * 다른 탭에서는 숨기기만 한다.
 */
export function BottomDock({ visible }: { visible: boolean }): React.JSX.Element {
  const [open, setOpen] = useState(() => readLocal('dock_open') !== '0')
  const [tab, setTab] = useState<DockTab>(() => (readLocal('dock_tab') === 'ai' ? 'ai' : 'queue'))
  const groups = useQueueGroups((s) => s.groups)
  const liveCount = groups.reduce((n, g) => n + g.live, 0)
  const cancelAll = useGenerationStore((s) => s.cancelAll)
  const mcp = useMcp()

  const toggle = (next: boolean): void => {
    setOpen(next)
    writeLocal('dock_open', next ? '1' : '0')
  }
  const pick = (next: DockTab): void => {
    setTab(next)
    writeLocal('dock_tab', next)
    if (!open) toggle(true)
  }

  return (
    <section
      aria-label="대기열과 AI가 한 일"
      className={cn('flex shrink-0 flex-col bg-surface', !visible && 'hidden')}
      style={{ height: open ? 250 : undefined }}
    >
      <div
        className={cn('flex h-11 shrink-0 items-center gap-1 px-2', open && 'border-b border-line')}
        role="tablist"
      >
        <TabButton active={open && tab === 'queue'} onClick={() => pick('queue')}>
          대기열{' '}
          <span className="text-[12px] font-normal tabular-nums text-faint">
            {liveCount.toLocaleString()}
          </span>
        </TabButton>
        <TabButton active={open && tab === 'ai'} onClick={() => pick('ai')}>
          AI가 한 일
        </TabButton>
        <span className="min-w-2 flex-1" />
        {tab === 'queue' ? (
          <Button
            size="sm"
            variant="danger"
            disabled={liveCount === 0}
            onClick={() => void cancelAll()}
            title="대기 중이거나 생성 중인 것을 모두 취소해요"
          >
            전부 취소
          </Button>
        ) : (
          <span
            className="px-2 text-[12px] tabular-nums text-muted"
            title={mcp.status?.error ?? mcp.status?.url}
          >
            {!mcp.known || !mcp.status ? (
              'MCP 상태 모름'
            ) : mcp.status.running ? (
              <>
                <span className="font-semibold text-good">MCP 켜짐</span> · 포트 {mcp.status.port}
              </>
            ) : (
              <>
                <span className="font-semibold text-muted">MCP 꺼짐</span>
                {mcp.status.error && <span className="text-bad"> · 시작 못 함</span>}
              </>
            )}
          </span>
        )}
        <Button
          size="icon-sm"
          variant="ghost"
          aria-expanded={open}
          aria-label={open ? '아래 칸 접기' : '아래 칸 펴기'}
          title={open ? '아래 칸 접기' : '아래 칸 펴기'}
          onClick={() => toggle(!open)}
        >
          {open ? <ChevronDown size={15} /> : <ChevronUp size={15} />}
        </Button>
      </div>
      {open && (
        <div className="min-h-0 flex-1 overflow-auto" role="tabpanel">
          {tab === 'queue' ? <QueueTable /> : <ActivityTable items={mcp.items} />}
        </div>
      )}
    </section>
  )
}
