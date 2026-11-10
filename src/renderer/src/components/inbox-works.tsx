import { Check, ChevronDown, Copy, ExternalLink, RefreshCw } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { InboxWork, InboxWorkGroup, InboxWorksResult } from '@shared/inbox'
import {
  platformName,
  workCopyText,
  workDate,
  workDateTime,
  workGroupCopyText
} from '@shared/inbox-works'
import { PLATFORM_COLORS, platformTone } from '../lib/inbox-colors'
import { cn } from '../lib/utils'
import { toast } from '../stores/toast-store'
import { Button } from './ui/button'
import { Segmented, SegmentedCount, SegmentedItem } from './ui/segmented'

/** 원작은 에덴. 나머지는 이식 대상 (늘 이 순서로 보여 준다) */
const ORIGIN = 'eden'
const PORTS = [
  'babe',
  'luna',
  'elyn',
  'neko',
  'teapot',
  'crack',
  'genit',
  'rplay',
  'uumai',
  'chatple'
]

const norm = (s: string): string =>
  s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, '')

function ago(iso: string | null): string {
  if (!iso) return '아직 안 읽음'
  const d = Date.now() - Date.parse(iso)
  if (d < 60_000) return '방금'
  if (d < 3_600_000) return Math.floor(d / 60_000) + '분 전'
  if (d < 86_400_000) return Math.floor(d / 3_600_000) + '시간 전'
  return Math.floor(d / 86_400_000) + '일 전'
}

interface Row {
  group: InboxWorkGroup
  origin: InboxWork
  ports: Map<string, InboxWork>
}

/**
 * 알림 화면의 "내 작품". 에덴 작품마다 다른 플랫폼 이식 여부를 보여 주고,
 * 이식된 곳은 "이식 플랫폼 / 업로드(최초공개일) 일자 / 플랫폼: 링크" 문구로 복사한다.
 */
export function InboxWorks({
  platform,
  search
}: {
  /** 왼쪽에서 고른 플랫폼 ('' = 전체) */
  platform: string
  search: string
}): React.JSX.Element {
  const [data, setData] = useState<InboxWorksResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [filter, setFilter] = useState<'all' | 'missing'>('all')
  const [showOthers, setShowOthers] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)
  const copiedTimer = useRef(0)

  const load = async (refresh: boolean): Promise<void> => {
    setLoading(true)
    try {
      setData(await window.nais.invoke('inbox:works', { refresh }))
    } catch {
      toast('작품 목록을 읽지 못했어요', 'error')
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    void load(false)
    return () => window.clearTimeout(copiedTimer.current)
  }, [])

  const copy = (key: string, text: string, label: string): void => {
    void window.nais.invoke('app:copyText', { text }).then(
      ({ ok }) => {
        if (!ok) return toast('복사하지 못했어요', 'error')
        setCopied(key)
        window.clearTimeout(copiedTimer.current)
        copiedTimer.current = window.setTimeout(() => setCopied(null), 1600)
        toast(label + ' 복사했어요', 'success')
      },
      () => toast('복사하지 못했어요', 'error')
    )
  }

  const supported = useMemo(() => new Set(data?.supported ?? []), [data])
  // 확인할 수 있는 이식 플랫폼 (연결됐고 목록을 읽을 수 있는 곳)
  const checkable = PORTS.filter((p) => supported.has(p))
  const focus = platform && platform !== ORIGIN ? platform : ''

  const { rows, others } = useMemo(() => {
    const rows: Row[] = []
    const others: InboxWorkGroup[] = []
    for (const g of data?.groups ?? []) {
      const origin = g.works.find((w) => w.platform === ORIGIN)
      if (!origin) {
        others.push(g)
        continue
      }
      const ports = new Map<string, InboxWork>()
      for (const w of g.works)
        if (w.platform !== ORIGIN && !ports.has(w.platform)) ports.set(w.platform, w)
      rows.push({ group: g, origin, ports })
    }
    return { rows, others }
  }, [data])

  const q = norm(search)
  const missingOf = (r: Row): string[] =>
    (focus ? [focus] : checkable).filter((p) => supported.has(p) && !r.ports.has(p))
  const visible = rows.filter(
    (r) => (!q || norm(r.group.title).includes(q)) && (filter === 'all' || missingOf(r).length > 0)
  )
  const missingCount = rows.filter((r) => missingOf(r).length > 0).length
  const visibleOthers = others.filter(
    (g) =>
      (!q || norm(g.title).includes(q)) && (!focus || g.works.some((w) => w.platform === focus))
  )
  const errors = Object.entries(data?.errors ?? {})

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Segmented
          aria-label="작품 거르기"
          value={filter}
          onValueChange={(v) => v && setFilter(v as typeof filter)}
        >
          <SegmentedItem value="all" className="px-3 text-[13px]">
            에덴 작품
            <SegmentedCount>{rows.length}</SegmentedCount>
          </SegmentedItem>
          <SegmentedItem value="missing" className="px-3 text-[13px]">
            {focus ? platformName(focus) + ' 미이식' : '이식 남은 작품'}
            <SegmentedCount>{missingCount}</SegmentedCount>
          </SegmentedItem>
        </Segmented>
        <span className="text-[12px] text-faint">마지막 확인 {ago(data?.fetchedAt ?? null)}</span>
        {errors.map(([p, message]) => (
          <span
            key={p}
            className="rounded-md bg-danger/10 px-2 py-0.5 text-[11px] font-medium text-danger"
          >
            {platformName(p)} · {message}
          </span>
        ))}
        <div className="ml-auto">
          <span className="mr-3 text-[11px] text-faint">
            * 공개일을 따로 주지 않는 플랫폼은 등록일
          </span>
          <Button
            onClick={() => void load(true)}
            disabled={loading}
            title="플랫폼에서 내 작품을 다시 읽어요"
          >
            <RefreshCw size={14} className={cn(loading && 'animate-spin')} />
            {loading ? '읽는 중' : '새로 고침'}
          </Button>
        </div>
      </div>

      <div
        className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-line bg-paper"
        aria-label="에덴 작품 이식 현황"
      >
        {!data ? (
          <p className="p-10 text-center text-[13px] text-muted">
            플랫폼에서 내 작품을 읽고 있어요… 처음엔 몇 초 걸려요.
          </p>
        ) : !rows.length ? (
          <p className="p-10 text-center text-[13px] text-muted">
            {supported.has(ORIGIN)
              ? '에덴에서 찾은 작품이 없어요.'
              : '에덴을 연결하면 작품별 이식 현황을 볼 수 있어요.'}
          </p>
        ) : !visible.length ? (
          <p className="p-10 text-center text-[13px] text-muted">
            {filter === 'missing' ? '모두 이식했어요.' : '조건에 맞는 작품이 없어요.'}
          </p>
        ) : (
          visible.map((r) => (
            <WorkRow
              key={r.group.key}
              row={r}
              supported={supported}
              focus={focus}
              copied={copied}
              onCopy={copy}
            />
          ))
        )}

        {!!visibleOthers.length && (
          <section className="border-t border-line">
            <button
              onClick={() => setShowOthers((v) => !v)}
              className="flex h-10 w-full items-center gap-2 px-5 text-left text-[12px] font-semibold text-muted hover:text-ink"
              aria-expanded={showOthers}
            >
              <ChevronDown
                size={14}
                className={cn('transition-transform', !showOthers && '-rotate-90')}
              />
              에덴에 없는 작품
              <span className="font-normal tabular-nums text-faint">{visibleOthers.length}</span>
            </button>
            {showOthers &&
              visibleOthers.map((g) => (
                <div
                  key={g.key}
                  className="flex items-center gap-3 border-t border-line px-5 py-2.5"
                >
                  <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{g.title}</span>
                  <div className="flex flex-wrap justify-end gap-1.5">
                    {g.works.map((w) => (
                      <PortChip
                        key={w.platform + w.id}
                        platform={w.platform}
                        work={w}
                        state="ported"
                        focus={focus === w.platform}
                        copied={copied === w.platform + ':' + w.id}
                        onCopy={() =>
                          copy(
                            w.platform + ':' + w.id,
                            workCopyText(w),
                            platformName(w.platform) + ' 문구를'
                          )
                        }
                      />
                    ))}
                  </div>
                </div>
              ))}
          </section>
        )}
      </div>
    </div>
  )
}

function WorkRow({
  row,
  supported,
  focus,
  copied,
  onCopy
}: {
  row: Row
  supported: Set<string>
  focus: string
  copied: string | null
  onCopy: (key: string, text: string, label: string) => void
}): React.JSX.Element {
  const { group, origin, ports } = row
  const ported = PORTS.map((p) => ports.get(p)).filter((w): w is InboxWork => !!w)
  const checkableCount = PORTS.filter((p) => supported.has(p)).length
  const allKey = 'all:' + group.key
  return (
    <section
      className="flex gap-4 border-b border-line px-5 py-4 [contain-intrinsic-size:auto_132px] [content-visibility:auto] last:border-b-0"
      aria-label={group.title}
    >
      <div className="size-14 shrink-0 overflow-hidden rounded-lg bg-surface-2">
        {group.thumbnail ? (
          <img src={group.thumbnail} alt="" loading="lazy" className="size-full object-cover" />
        ) : (
          <div className="grid size-full place-items-center text-[18px] font-bold text-faint">
            {group.title.slice(0, 1)}
          </div>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-[14px] font-semibold text-ink">{origin.title}</h3>
            <p className="mt-0.5 flex items-center gap-1.5 text-[12px] text-muted">
              <span style={{ color: platformTone(ORIGIN) }} className="font-semibold">
                에덴
              </span>
              <span className="tabular-nums" title={'최초 공개 ' + workDateTime(origin.at)}>
                {workDate(origin.at)} 공개
              </span>
              <span className="text-faint">·</span>
              <span className="tabular-nums">
                {ported.length}/{checkableCount} 이식
              </span>
              {!origin.isPublic && (
                <span className="rounded bg-surface-2 px-1.5 text-[11px] text-muted">비공개</span>
              )}
              <a
                href={origin.url}
                target="_blank"
                rel="noreferrer"
                title={'에덴에서 열기 · ' + origin.url}
                aria-label="에덴에서 열기"
                className="grid size-6 place-items-center rounded text-faint hover:bg-surface-2 hover:text-ink"
              >
                <ExternalLink size={12} />
              </a>
            </p>
          </div>
          <Button
            variant="tint"
            size="sm"
            disabled={!ported.length}
            onClick={() =>
              onCopy(allKey, workGroupCopyText(ported), '이식 문구 ' + ported.length + '개를')
            }
            title="이식된 플랫폼 문구를 한 번에 복사"
          >
            {copied === allKey ? <Check size={13} /> : <Copy size={13} />}
            이식 문구 복사
            <span className="tabular-nums opacity-70">{ported.length}</span>
          </Button>
        </div>
        <div className="mt-2.5 grid grid-cols-2 gap-1.5 sm:grid-cols-4">
          {PORTS.map((p) => {
            const w = ports.get(p)
            const key = w ? p + ':' + w.id : p
            return (
              <PortChip
                key={p}
                platform={p}
                work={w ?? null}
                state={w ? 'ported' : supported.has(p) ? 'missing' : 'unknown'}
                focus={focus === p}
                copied={copied === key}
                onCopy={() => w && onCopy(key, workCopyText(w), platformName(p) + ' 이식 문구를')}
              />
            )
          })}
        </div>
      </div>
    </section>
  )
}

/** 플랫폼 한 칸: 이식됨(누르면 문구 복사) · 미이식 · 확인 불가 */
function PortChip({
  platform,
  work,
  state,
  focus,
  copied,
  onCopy
}: {
  platform: string
  work: InboxWork | null
  state: 'ported' | 'missing' | 'unknown'
  focus: boolean
  copied: boolean
  onCopy: () => void
}): React.JSX.Element {
  const name = platformName(platform)
  if (state !== 'ported' || !work) {
    return (
      <div
        className={cn(
          'flex h-8 items-center gap-2 rounded-md border border-dashed px-2.5 text-[12px]',
          focus ? 'border-accent/60 bg-accent-soft/50' : 'border-line'
        )}
        title={
          state === 'missing'
            ? name + '에 같은 제목 작품이 없어요'
            : name + '은(는) 연결되지 않았거나 작품 목록을 아직 읽지 못해요'
        }
      >
        <span className="font-medium text-faint">{name}</span>
        <span className="ml-auto text-[11px] text-faint">
          {state === 'missing' ? '미이식' : '확인 불가'}
        </span>
      </div>
    )
  }
  return (
    <div
      className={cn(
        'group flex h-8 items-center rounded-md bg-surface-2 text-[12px] transition-colors',
        focus && 'ring-1 ring-accent'
      )}
    >
      <button
        onClick={onCopy}
        className="flex h-full min-w-0 flex-1 items-center gap-2 rounded-l-md pl-2.5 pr-1 text-left hover:brightness-[0.97] dark:hover:brightness-110"
        title={
          '누르면 이식 문구 복사 · ' +
          (work.atKind === 'published' ? '최초 공개 ' : '등록 ') +
          workDateTime(work.at) +
          (work.atKind === 'created' ? ' (이 플랫폼은 공개일을 따로 주지 않아요)' : '')
        }
        aria-label={name + ' 이식 문구 복사'}
      >
        <i
          aria-hidden
          className="h-3.5 w-1 shrink-0 rounded-full"
          style={{ backgroundColor: PLATFORM_COLORS[platform] }}
        />
        <span className="truncate font-semibold" style={{ color: platformTone(platform) }}>
          {name}
        </span>
        <span className="ml-auto shrink-0 tabular-nums text-muted">
          {workDate(work.at)}
          {work.atKind === 'created' && <span className="text-faint">*</span>}
        </span>
        <span
          className={cn('shrink-0', copied ? 'text-accent' : 'text-faint group-hover:text-ink')}
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
        </span>
      </button>
      <a
        href={work.url}
        target="_blank"
        rel="noreferrer"
        aria-label={name + '에서 열기'}
        title={name + '에서 열기 · ' + work.url}
        className="grid h-full w-7 shrink-0 place-items-center rounded-r-md text-faint hover:text-ink"
      >
        <ExternalLink size={12} />
      </a>
    </div>
  )
}
