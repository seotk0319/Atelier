import { RefreshCw } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { InboxWorksResult } from '@shared/inbox'
import type { McpActivity, McpStatus } from '@shared/types'
import { platformName, workDateTime, workGroupCopyText } from '@shared/inbox-works'
import {
  ORIGIN,
  WORK_PLATFORMS,
  agoText,
  buildWorkRows,
  filterWorkRows,
  hasFreshness,
  type WorkCell,
  type WorkTableRow,
  type WorksFilter
} from '../lib/works-table'
import { cn } from '../lib/utils'
import { useLayoutStore } from '../stores/layout-store'
import { toast } from '../stores/toast-store'
import { Button } from './ui/button'
import { Segmented, SegmentedCount, SegmentedItem } from './ui/segmented'

const FOCUS =
  'outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/50'
const TH =
  'sticky top-0 z-10 h-10 whitespace-nowrap border-b border-line bg-surface px-2 text-center text-[12px] font-normal text-faint'
const TD = 'h-11 whitespace-nowrap border-b border-line p-0 text-center text-[13px]'

/**
 * 작품 MCP 기록과 상태. 기록은 표의 "마지막 AI 작업"을 찾으려고 넉넉히(500개) 읽고,
 * 아래 「AI가 한 일」에는 최근 50개만 보인다. 본체가 기록을 못 주면 빈 목록.
 */
function useMcp(): { items: McpActivity[]; status: McpStatus | null; known: boolean } {
  const [items, setItems] = useState<McpActivity[]>([])
  const [status, setStatus] = useState<McpStatus | null>(null)
  const [known, setKnown] = useState(true)
  useEffect(() => {
    let alive = true
    window.nais
      .invoke('mcp:activity', { limit: 500 })
      .then((r) => {
        if (alive) setItems(r?.items ?? [])
      })
      .catch(() => undefined)
    window.nais
      .invoke('mcp:status', undefined)
      .then((v) => {
        if (alive) setStatus(v ?? null)
      })
      .catch(() => {
        if (alive) setKnown(false)
      })
    const off = window.nais.on('mcp:activityAdded', (a) => {
      setItems((list) => [a, ...list.filter((x) => x.id !== a.id)].slice(0, 500))
    })
    return () => {
      alive = false
      off()
    }
  }, [])
  return { items, status, known }
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

const ATH =
  'sticky top-0 whitespace-nowrap bg-surface px-2 py-2 text-left text-[12px] font-normal text-faint first:pl-4 last:pr-4 last:text-right'
const ATD =
  'whitespace-nowrap border-t border-line px-2 py-2 text-[13px] first:pl-4 last:pr-4 last:text-right'

/** 작품 탭 아래: AI가 한 일 (작품 MCP 기록, 최근 50개) */
function ActivitySection({
  items,
  status,
  known
}: {
  items: McpActivity[]
  status: McpStatus | null
  known: boolean
}): React.JSX.Element {
  const recent = [...items].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 50)
  return (
    <section
      aria-label="AI가 한 일"
      className="flex h-[220px] shrink-0 flex-col border-t border-line"
    >
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-4">
        <h3 className="text-[14px] font-semibold text-ink">AI가 한 일</h3>
        <span className="flex-1" />
        <span className="text-[12px] tabular-nums text-muted" title={status?.error ?? status?.url}>
          {!known || !status ? (
            'MCP 상태 모름'
          ) : status.running ? (
            <>
              <span className="font-semibold text-good">MCP 켜짐</span> · 포트 {status.port}
            </>
          ) : (
            <>
              <span className="font-semibold text-muted">MCP 꺼짐</span>
              {status.error && <span className="text-bad"> · 시작 못 함</span>}
            </>
          )}
        </span>
      </div>
      {/* 아래 가운데 떠 있는 AI 비서·대기열 단추에 마지막 줄이 가리지 않게 아래를 띄운다 */}
      <div className="min-h-0 flex-1 overflow-auto pb-12">
        {recent.length === 0 ? (
          <p className="px-4 py-6 text-center text-[13px] text-faint">아직 기록이 없어요</p>
        ) : (
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className={ATH}>시각</th>
                <th className={ATH}>플랫폼</th>
                <th className={ATH}>작품</th>
                <th className={ATH}>한 일</th>
                <th className={ATH}>결과</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((a) => (
                <tr key={a.id}>
                  <td className={cn(ATD, 'tabular-nums text-faint')} title={a.at}>
                    {formatWhen(a.at)}
                  </td>
                  <td className={ATD}>{a.site ? platformName(a.site) : '—'}</td>
                  <td
                    className={cn(ATD, 'max-w-[260px] truncate')}
                    title={a.workTitle ?? undefined}
                  >
                    {a.workTitle ?? '—'}
                  </td>
                  <td
                    className={cn(ATD, 'max-w-[360px] truncate')}
                    title={`${a.summary} (${a.tool})`}
                  >
                    {a.summary}
                  </td>
                  <td className={ATD}>
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
        )}
      </div>
    </section>
  )
}

/**
 * 작품 탭: 행 = 내 작품, 열 = 플랫폼. 탭을 열면 저장된 목록만 읽고,
 * 플랫폼에 다시 묻는 것은 「새로 읽기」를 누를 때뿐이다.
 */
export function WorksView(): React.JSX.Element {
  const [data, setData] = useState<InboxWorksResult | null>(null)
  const [failed, setFailed] = useState(false)
  const [loading, setLoading] = useState(false)
  const [filter, setFilter] = useState<WorksFilter>('all')
  const [now, setNow] = useState(0)
  const mcp = useMcp()
  const activity = mcp.items
  const active = useLayoutStore((s) => s.centerMode === 'works')

  // 「새로 읽기」: 연결된 플랫폼에 다시 묻는다. 누를 때만 부른다.
  const refresh = async (): Promise<void> => {
    setLoading(true)
    try {
      setData(await window.nais.invoke('inbox:works', { refresh: true }))
      setFailed(false)
    } catch {
      toast('작품 목록을 읽지 못했어요', 'error')
    } finally {
      setNow(Date.now())
      setLoading(false)
    }
  }
  // 탭을 열 때마다 저장된 목록·댓글 수만 다시 읽는다 (사이트에는 묻지 않는다)
  useEffect(() => {
    if (!active) return
    let alive = true
    window.nais.invoke('inbox:works', { cached: true }).then(
      (result) => {
        if (!alive) return
        setData(result)
        setFailed(false)
        setNow(Date.now())
      },
      () => {
        if (!alive) return
        setFailed(true)
        setNow(Date.now())
      }
    )
    return () => {
      alive = false
    }
  }, [active])

  const rows = useMemo(() => buildWorkRows(data, activity), [data, activity])
  const freshness = useMemo(() => hasFreshness(rows), [rows])
  const shownFilter: WorksFilter = filter === 'stale' && !freshness ? 'all' : filter
  const visible = filterWorkRows(rows, shownFilter)
  const staleRows = rows.filter((r) => r.staleCount > 0).length
  const missingRows = rows.filter((r) => r.missing.length > 0).length
  const lost = new Set(data?.loginLost ?? [])
  const supported = new Set(data?.supported ?? [])
  const errors = Object.entries(data?.errors ?? {})

  const copyPorts = (row: WorkTableRow): void => {
    if (!row.ported.length) {
      toast('복사할 이식 문구가 없어요. 아직 다른 곳에 올린 적이 없어요.')
      return
    }
    const label = '이식 문구 ' + row.ported.length + '개를'
    void window.nais.invoke('app:copyText', { text: workGroupCopyText(row.ported) }).then(
      ({ ok }) =>
        ok ? toast(label + ' 복사했어요', 'success') : toast('복사하지 못했어요', 'error'),
      () => toast('복사하지 못했어요', 'error')
    )
  }

  const empty = !data
    ? failed
      ? '작품 목록을 읽지 못했어요. 잠시 뒤 「새로 읽기」를 눌러 주세요.'
      : '저장된 작품 목록을 읽고 있어요…'
    : !rows.length
      ? !data.supported.length
        ? '연결된 플랫폼이 없어요. 알림 탭 설정에서 플랫폼에 로그인하면 작품을 읽을 수 있어요.'
        : !data.fetchedAt
          ? '아직 읽어 온 작품 목록이 없어요. 「새로 읽기」를 누르면 연결된 플랫폼에서 읽어 와요.'
          : '찾은 작품이 없어요.'
      : !visible.length
        ? shownFilter === 'stale'
          ? '낡은 작품이 없어요.'
          : '모든 연결된 플랫폼에 올라가 있어요.'
        : null

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-surface">
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-line px-4">
        <h2 className="text-[15px] font-semibold text-ink">작품</h2>
        <span className="text-[13px] tabular-nums text-faint">
          {rows.length.toLocaleString()}개
        </span>
        <Segmented
          aria-label="작품 거르기"
          value={shownFilter}
          onValueChange={(v) => v && setFilter(v as WorksFilter)}
        >
          <SegmentedItem value="all" className="px-3 text-[13px]">
            전체
            <SegmentedCount>{rows.length}</SegmentedCount>
          </SegmentedItem>
          {freshness && (
            <SegmentedItem value="stale" className="px-3 text-[13px]">
              낡은 것<SegmentedCount>{staleRows}</SegmentedCount>
            </SegmentedItem>
          )}
          <SegmentedItem value="missing" className="px-3 text-[13px]">
            안 올린 곳 있음
            <SegmentedCount>{missingRows}</SegmentedCount>
          </SegmentedItem>
        </Segmented>
        <span className="min-w-2 flex-1" />
        <span
          className="text-[12px] tabular-nums text-faint"
          title={data?.fetchedAt ? workDateTime(data.fetchedAt) : undefined}
        >
          {data?.fetchedAt ? '마지막으로 읽음 ' + agoText(data.fetchedAt, now) : '아직 안 읽음'}
        </span>
        <Button
          onClick={() => void refresh()}
          disabled={loading}
          title="연결된 플랫폼에서 내 작품 목록을 다시 읽어요"
        >
          <RefreshCw size={14} className={cn(loading && 'animate-spin')} />
          {loading ? '읽는 중' : '새로 읽기'}
        </Button>
      </div>
      {!!errors.length && (
        <p className="shrink-0 border-b border-line px-4 py-1.5 text-[12px] text-muted">
          지난번에 못 읽은 곳:{' '}
          {errors.map(([p, message], i) => (
            <span key={p}>
              {i > 0 && ' · '}
              <span className="font-semibold text-bad">{platformName(p)}</span> {message}
            </span>
          ))}
        </p>
      )}

      {empty ? (
        <p className="flex flex-1 items-center justify-center p-10 text-center text-[13px] text-muted">
          {empty}
        </p>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto" aria-label="작품별 플랫폼 현황">
          <table className="w-max min-w-full border-separate border-spacing-0">
            <thead>
              <tr>
                <th className={cn(TH, 'left-0 z-20 min-w-[260px] pl-4 text-left')}>작품</th>
                {WORK_PLATFORMS.map((p) => (
                  <th key={p} className={cn(TH, 'min-w-[68px]')} scope="col">
                    <span className="block leading-tight">{platformName(p)}</span>
                    {lost.has(p) ? (
                      <span
                        className="mt-0.5 inline-block rounded-[3px] bg-bad-soft px-1 text-[11px] font-semibold leading-4 text-bad"
                        title={platformName(p) + ' 로그인이 풀렸거나 연결이 끊겼어요'}
                      >
                        로그인 풀림
                      </span>
                    ) : (
                      !supported.has(p) && (
                        <span className="mt-0.5 block text-[11px] leading-4 text-faint">
                          연결 안 됨
                        </span>
                      )
                    )}
                  </th>
                ))}
                <th className={cn(TH, 'min-w-[56px]')} scope="col">
                  댓글
                </th>
                <th className={cn(TH, 'min-w-[260px] pr-4 text-left')} scope="col">
                  마지막 AI 작업
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => (
                <tr key={row.key}>
                  <th
                    scope="row"
                    className={cn(
                      TD,
                      'sticky left-0 z-[5] max-w-[320px] bg-surface pl-4 pr-3 text-left font-semibold text-ink'
                    )}
                  >
                    <span className="flex items-center gap-2.5">
                      <span className="grid size-7 shrink-0 place-items-center overflow-hidden rounded bg-surface-2 text-[12px] font-bold text-faint">
                        {row.thumbnail ? (
                          <img
                            src={row.thumbnail}
                            alt=""
                            loading="lazy"
                            className="size-full object-cover"
                          />
                        ) : (
                          row.title.slice(0, 1)
                        )}
                      </span>
                      <span className="truncate" title={row.title}>
                        {row.title}
                      </span>
                    </span>
                  </th>
                  {row.cells.map((c) => (
                    <td key={c.platform} className={TD}>
                      <Cell row={row} cell={c} onCopy={() => copyPorts(row)} />
                    </td>
                  ))}
                  <td className={cn(TD, 'tabular-nums')}>
                    {row.unanswered > 0 ? (
                      <span
                        className="font-semibold text-bad"
                        title={'답글 안 단 댓글 ' + row.unanswered + '개'}
                      >
                        {row.unanswered.toLocaleString()}
                      </span>
                    ) : (
                      <span className="text-faint">—</span>
                    )}
                  </td>
                  <td className={cn(TD, 'max-w-[360px] pr-4 text-left')}>
                    {row.activity ? (
                      <span
                        className="flex min-w-0 items-center gap-2"
                        title={
                          row.activity.summary +
                          ' (' +
                          row.activity.tool +
                          ') · ' +
                          workDateTime(row.activity.at)
                        }
                      >
                        {!row.activity.ok && (
                          <span className="shrink-0 font-semibold text-bad">실패</span>
                        )}
                        <span className="truncate text-ink">{row.activity.summary}</span>
                        <span className="shrink-0 tabular-nums text-faint">
                          {agoText(row.activity.at, now)}
                        </span>
                      </span>
                    ) : (
                      <span className="text-faint">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="shrink-0 border-t border-line px-4 py-2 text-[12px] text-faint">
        ✓ 올라가 있음 (누르면 사이트에서 열어요)
        {freshness && ' · 낡음 = 에덴이 그 뒤에 바뀜'} · — 안 올림 (에덴 작품은 누르면 이식 문구
        복사) · 로그인 풀림 = 다시 로그인해야 목록을 새로 읽어요 · 댓글 = 답글 안 단 댓글
      </p>
      <ActivitySection items={mcp.items} status={mcp.status} known={mcp.known} />
    </div>
  )
}

function Cell({
  row,
  cell,
  onCopy
}: {
  row: WorkTableRow
  cell: WorkCell
  onCopy: () => void
}): React.JSX.Element {
  const name = platformName(cell.platform)
  const base = 'flex h-11 w-full items-center justify-center'
  const box = cn(base, FOCUS)
  if (cell.work) {
    const w = cell.work
    return (
      <a
        href={w.url}
        target="_blank"
        rel="noreferrer"
        className={cn(box, 'hover:bg-surface-2')}
        title={
          cell.state === 'stale'
            ? '에덴이 그 뒤에 바뀌었어요 · 에덴 수정 ' +
              workDateTime(row.eden?.updatedAt ?? null) +
              ' / ' +
              name +
              ' 수정 ' +
              workDateTime(w.updatedAt ?? null)
            : '올라가 있어요'
        }
        aria-label={row.title + ' · ' + name + '에서 열기'}
      >
        {cell.state === 'stale' ? (
          <span className="rounded-[3px] bg-warn-soft px-1.5 text-[12px] font-semibold leading-5 text-warn">
            낡음
          </span>
        ) : (
          <span className="text-faint">✓</span>
        )}
      </a>
    )
  }
  const reason =
    cell.state === 'unknown'
      ? name + '은(는) 연결되지 않아 있는지 확인할 수 없어요'
      : name + '에 같은 제목 작품이 없어요'
  if (row.eden && cell.platform !== ORIGIN)
    return (
      <button
        type="button"
        onClick={onCopy}
        className={cn(box, 'text-faint hover:bg-surface-2')}
        title={reason + ' · 누르면 이식 문구를 복사해요'}
        aria-label={row.title + ' · ' + name + ' 안 올림 · 이식 문구 복사'}
      >
        —
      </button>
    )
  return (
    <span className={cn(base, 'text-faint')} title={reason}>
      —
    </span>
  )
}
