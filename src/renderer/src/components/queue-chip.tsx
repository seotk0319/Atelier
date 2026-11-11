import { useEffect, useRef, useState } from 'react'
import { create } from 'zustand'
import { groupQueue, trackTotals, type QueueGroup } from '../lib/queue-groups'
import { formatEta, useQueueRun } from '../lib/queue-run'
import { cn } from '../lib/utils'
import { useGenerationStore } from '../stores/generation-store'
import { presetIdOfScene, useScenesStore } from '../stores/scenes-store'
import { Button } from './ui/button'

/** 대기열 묶음과 묶음별 전체 장수. 창을 닫아 둬도 계속 센다 */
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

const TH =
  'sticky top-0 whitespace-nowrap bg-surface px-2 py-2 text-left text-[12px] font-normal text-faint first:pl-3 last:pr-3'
const TD = 'whitespace-nowrap border-t border-line px-2 py-2 text-[13px] first:pl-3 last:pr-3'

function GroupRows({ groups }: { groups: QueueGroup[] }): React.JSX.Element {
  const totals = useQueueGroups((s) => s.totals)
  return (
    <table className="w-full border-collapse">
      <thead>
        <tr>
          <th className={TH}>묶음</th>
          <th className={TH}>상태</th>
          <th className={TH}>진행</th>
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
            <tr key={g.key}>
              <td className={cn(TD, 'max-w-[150px] truncate font-semibold')} title={g.label}>
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
                  className="mr-2 inline-block h-1 w-[56px] bg-surface-3 align-middle"
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
              <td className={cn(TD, 'text-right')}>
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

/**
 * 떠 있는 대기열 단추. 대기·생성 중인 장이 있을 때만 보인다 (어느 탭이든).
 * 누르면 위로 작은 창이 열려 묶음별 진행과 취소를 한다. Esc나 바깥을 누르면 닫힌다.
 */
export function QueueChip(): React.JSX.Element | null {
  const groups = useQueueGroups((s) => s.groups)
  const run = useQueueRun((s) => s.run)
  const cancelAll = useGenerationStore((s) => s.cancelAll)
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const chipRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const live = groups.reduce((n, g) => n + g.live, 0)
  const showing = live > 0 && open
  // 대기열이 비면 창도 닫아 둔다 (다음 생성 때 저절로 열리지 않게)
  if (live === 0 && open) setOpen(false)
  // 묶음 이름(씬 프리셋)은 프리셋 목록이 있어야 나온다. 씬 탭을 안 열었어도 읽어 둔다
  const presetsLoaded = useScenesStore((s) => s.presets.length > 0)
  const hasLive = live > 0
  useEffect(() => {
    if (hasLive && !presetsLoaded) void useScenesStore.getState().loadPresets()
  }, [hasLive, presetsLoaded])

  useEffect(() => {
    if (!showing) return
    popRef.current?.focus()
    const down = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const key = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      setOpen(false)
      chipRef.current?.focus()
    }
    document.addEventListener('mousedown', down)
    document.addEventListener('keydown', key, true)
    return () => {
      document.removeEventListener('mousedown', down)
      document.removeEventListener('keydown', key, true)
    }
  }, [showing])

  if (live === 0) return null
  const total = run && run.total > 0 ? run.total : live
  const done = run && run.total > 0 ? run.done : 0
  const pct = total > 0 ? (done / total) * 100 : 0
  const eta = run?.perMinute ? formatEta(run.remaining / run.perMinute).replace(/^약 /, '') : null

  return (
    <div ref={rootRef} className="pointer-events-auto relative">
      {showing && (
        <div
          ref={popRef}
          tabIndex={-1}
          role="dialog"
          aria-label="대기열"
          className="absolute bottom-full left-0 mb-2 flex max-h-[320px] w-[420px] max-w-[calc(100vw-32px)] flex-col overflow-hidden rounded-xl border border-line bg-surface shadow-xl outline-none"
        >
          <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line pl-3 pr-2">
            <b className="text-[13px] font-semibold text-ink">대기열</b>
            <span className="text-[12px] tabular-nums text-faint">{live.toLocaleString()}장</span>
            {run?.perMinute && (
              <span className="text-[12px] tabular-nums text-muted" title="최근 완료 속도">
                분당 {Math.round(run.perMinute).toLocaleString()}장
              </span>
            )}
            {run && run.failed > 0 && (
              <span className="text-[12px] font-semibold tabular-nums text-bad">
                실패 {run.failed.toLocaleString()}장
              </span>
            )}
            <span className="flex-1" />
            <Button
              size="sm"
              variant="danger"
              onClick={() => void cancelAll()}
              title="대기 중이거나 생성 중인 것을 모두 취소해요"
            >
              전부 취소
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <GroupRows groups={groups} />
          </div>
        </div>
      )}
      <button
        ref={chipRef}
        type="button"
        aria-expanded={showing}
        aria-haspopup="dialog"
        onClick={() => setOpen((v) => !v)}
        title="대기열 보기"
        className="inline-flex h-9 items-center gap-2 whitespace-nowrap rounded-full border border-line bg-surface px-3.5 text-[12.5px] font-semibold tabular-nums text-muted shadow-sm outline-none transition-colors hover:text-ink focus-visible:ring-2 focus-visible:ring-accent/40"
      >
        <span
          className="inline-block h-1 w-12 bg-surface-3"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={done}
          aria-label="생성 진행"
        >
          <i className="block h-full bg-mark" style={{ width: `${pct}%` }} />
        </span>
        <span className="text-ink">
          {done.toLocaleString()} / {total.toLocaleString()}장
        </span>
        {eta && <span className="text-faint">· {eta}</span>}
      </button>
    </div>
  )
}
