import {
  Coins,
  Download,
  Loader2,
  Minus,
  PanelLeft,
  PanelRight,
  Settings,
  Square,
  X
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { estimateAnlas } from '@shared/anlas'
import { isMediumEffort, MEDIUM_EFFORT_STEPS } from '@shared/nai-models'
import { effortForRefs, sentRefCount } from '@shared/char-refs'
import type { V5UsageStatus } from '@shared/types'
import { estimateV5Images, V5_ESTIMATE_BASIS } from '@shared/v5-usage'
import { cn } from '../lib/utils'
import { useGenerationStore } from '../stores/generation-store'
import { useLayoutStore } from '../stores/layout-store'
import { useCharRefsStore, useVibesStore } from '../stores/refs-store'
import { useUpdateStore } from '../stores/update-store'
import { PageNav } from './page-nav'
import { ThemeToggle } from './theme-toggle'
import { Switch } from './ui/switch'

const isMac = typeof navigator !== 'undefined' && navigator.platform.toLowerCase().includes('mac')

function ctrl(action: 'minimize' | 'maximize' | 'close'): void {
  void window.nais.invoke('window:control', { action })
}

/** 업데이트 발견 시 나타나는 다운로드 버튼 (신호등·패널토글 옆). 클릭 시 자동 업데이트 진행 */
function UpdateButton(): React.JSX.Element | null {
  const status = useUpdateStore((s) => s.status)
  const percent = useUpdateStore((s) => s.percent)
  const version = useUpdateStore((s) => s.version)
  const start = useUpdateStore((s) => s.start)
  const install = useUpdateStore((s) => s.install)

  if (status === 'available') {
    return (
      <BarButton
        onClick={start}
        className="text-accent hover:text-accent"
        title={`업데이트 ${version ?? ''} 다운로드 후 자동 설치`}
      >
        <Download size={15} />
      </BarButton>
    )
  }
  if (status === 'downloading') {
    return (
      <BarButton className="text-accent" title={`업데이트 다운로드 중 ${percent}%`} disabled>
        <Loader2 size={15} className="animate-spin" />
      </BarButton>
    )
  }
  if (status === 'downloaded') {
    return (
      <BarButton
        onClick={install}
        className="text-accent hover:text-accent"
        title={`업데이트 ${version ?? ''} 설치 준비됨 — 누르면 재시작해서 설치`}
      >
        <Download size={15} />
      </BarButton>
    )
  }
  return null
}

function formatDuration(seconds: number): string {
  const value = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(value / 3600)
  const minutes = Math.floor((value % 3600) / 60)
  const secs = value % 60
  if (hours > 0) return `${hours}시간 ${minutes}분 ${secs}초`
  if (minutes > 0) return `${minutes}분 ${secs}초`
  return `${secs}초`
}

function v5Tooltip(usage: V5UsageStatus, model: string): string {
  const medium = isMediumEffort(model)
  const images = estimateV5Images(usage, model)
  const secondsPerPercent = usage.timeUntilNextPercent
  const refillRate = secondsPerPercent > 0 ? Math.round((3600 / secondsPerPercent) * 10) / 10 : 0
  const percentToFull = usage.isNegative ? usage.percent + 100 : 100 - usage.percent
  const fullIn = percentToFull * secondsPerPercent
  return `V5 생성 한도 잔량 ${usage.percent}%\n${
    usage.percent >= 100
      ? '충전 완료'
      : `충전 속도 ${refillRate}%/시간 · 1%당 ${formatDuration(secondsPerPercent)}\n100%까지 약 ${formatDuration(fullIn)}`
  }\n약 ${images.toLocaleString()}장: ${medium ? '절약 모드 기준(일반보다 약 42% 적게 씀) · ' : ''}${V5_ESTIMATE_BASIS}`
}

/**
 * 머리줄 오른쪽 Anlas 잔액(-N 예상 소모)과 V5 잔량. 값이 없으면 그 칸은 그리지 않는다.
 * 창이 좁아지면 「약 N장」→ 막대 순으로 숨기고 숫자는 늘 남긴다.
 */
/** Anlas 소모 스위치 — 여러 계정(가속)을 쓸 수 있을 때만. 끄면 무료 여부를 확인하고 생성한다 */
function AnlasSpendSwitch(): React.JSX.Element | null {
  const queue = useGenerationStore((s) => s.queue)
  if (!queue?.accelerationAvailable) return null
  const on = queue.anlasSpendingEnabled !== false
  return (
    <label
      className="no-drag mr-1 flex shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap text-[12px] font-medium text-muted"
      title="ON: 기존처럼 유료 생성 허용. OFF: 메인·씬 생성 전 무료 여부 확인, 1% 미만/확인 실패 계정 대기. 이미 전송한 요청은 소급 적용하지 않으며 다른 앱과 같은 계정을 동시에 쓰면 과금 방지를 보장할 수 없어요."
    >
      Anlas 소모
      <Switch
        aria-label={`Anlas 소모 ${on ? 'ON' : 'OFF'}`}
        checked={on}
        onCheckedChange={(enabled) =>
          void window.nais
            .invoke('anlasSpending:set', { enabled })
            .then((status) => useGenerationStore.setState({ queue: status }))
        }
      />
    </label>
  )
}

function HeaderMeters(): React.JSX.Element | null {
  const anlasBalance = useGenerationStore((s) => s.anlasBalance)
  const v5Usage = useGenerationStore((s) => s.v5Usage)
  const refreshAnlas = useGenerationStore((s) => s.refreshAnlas)
  const request = useGenerationStore((s) => s.request)
  const batchCount = useGenerationStore((s) => s.batchCount)
  const tier = useGenerationStore((s) => s.subscriptionTier)
  // 실제로 보내는 레퍼런스 수와 모델 (V4.5는 의상 레퍼런스를 빼고, V5 절약은 레퍼런스가 있으면 일반으로)
  const sentCrefs = useCharRefsStore((s) =>
    sentRefCount(
      s.items.filter((c) => c.enabled).map((c) => c.refType),
      request.model
    )
  )
  const sendModel = effortForRefs(request.model, sentCrefs)
  const unencodedVibes = useVibesStore(
    (s) => s.items.filter((v) => v.enabled && !v.encodedReady).length
  )
  // 이번 생성에 소모될 Anlas 추정 (고해상도·캐릭터 레퍼런스·미인코딩 바이브 등)
  const anlasCost = estimateAnlas({
    width: request.width,
    height: request.height,
    steps: isMediumEffort(sendModel) ? MEDIUM_EFFORT_STEPS : request.steps,
    model: sendModel,
    strength: request.source ? (request.i2iStrength ?? 0.7) : 1,
    charRefCount: sentCrefs,
    isOpus: tier === 'opus',
    batchCount,
    unencodedVibes
  }).total

  useEffect(() => {
    if (!v5Usage || v5Usage.percent >= 100) return
    // timeUntilNextPercent는 카운트다운이 아니라 1%당 초다. 한 주기마다 서버 비율만 새로 읽는다.
    const refreshInMs = Math.max(60_000, v5Usage.timeUntilNextPercent * 1000)
    const timer = window.setTimeout(() => void refreshAnlas(), refreshInMs)
    return () => window.clearTimeout(timer)
  }, [v5Usage, refreshAnlas])

  if (anlasBalance === null && !v5Usage) return null
  return (
    <div className="no-drag mr-1 flex shrink-0 items-center gap-2 whitespace-nowrap text-[13px] min-[1240px]:gap-3">
      {anlasBalance !== null && (
        <span
          className="flex items-center gap-1.5"
          title={
            anlasCost > 0
              ? `Anlas 잔액 (생성할 때마다 갱신)\n이번 생성에 ${anlasCost}만큼 써요 (고해상도 · 캐릭터 레퍼런스 · 미인코딩 바이브 포함)`
              : 'Anlas 잔액 (생성할 때마다 갱신)'
          }
        >
          <Coins size={13} className="text-[#c9a34f]" aria-label="Anlas" />
          <b className="font-semibold tabular-nums text-ink">{anlasBalance.toLocaleString()}</b>
          {anlasCost > 0 && (
            <span className="rounded-md bg-bad-soft px-1.5 text-[12px] font-semibold tabular-nums text-bad">
              -{anlasCost}
            </span>
          )}
        </span>
      )}
      {anlasBalance !== null && v5Usage && (
        <span className="hidden h-3.5 w-px shrink-0 bg-line min-[1240px]:block" />
      )}
      {v5Usage && (
        <span className="flex items-center gap-1.5" title={v5Tooltip(v5Usage, request.model)}>
          <span className="font-medium text-muted">V5</span>
          <b
            className={cn(
              'font-semibold tabular-nums',
              v5Usage.isNegative ? 'text-bad' : 'text-ink'
            )}
          >
            {v5Usage.isNegative ? '−' : ''}
            {v5Usage.percent}%
          </b>
          <span
            className="hidden h-1 w-10 shrink-0 overflow-hidden bg-surface-3 min-[1240px]:inline-block"
            role="meter"
            aria-label="V5 잔량"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={v5Usage.isNegative ? 0 : Math.min(100, v5Usage.percent)}
          >
            <i
              className="block h-full bg-mark"
              style={{
                width: `${v5Usage.isNegative ? 0 : Math.max(0, Math.min(100, v5Usage.percent))}%`
              }}
            />
          </span>
          <span className="hidden text-[12px] tabular-nums text-muted min-[1360px]:inline">
            {v5Usage.isNegative
              ? '제한됨'
              : `약 ${estimateV5Images(v5Usage, request.model).toLocaleString()}장`}
          </span>
        </span>
      )}
    </div>
  )
}

function BarButton({
  className,
  active,
  ...props
}: React.ComponentProps<'button'> & { active?: boolean }): React.JSX.Element {
  return (
    <button
      className={cn(
        'no-drag grid h-8 w-8 place-items-center rounded-md text-muted outline-none transition-colors hover:bg-surface-2 hover:text-ink focus-visible:ring-2 focus-visible:ring-accent/40 disabled:pointer-events-none',
        active && 'text-ink',
        className
      )}
      {...props}
    />
  )
}

export function Titlebar(): React.JSX.Element {
  const leftOpen = useLayoutStore((s) => s.leftOpen)
  const rightOpen = useLayoutStore((s) => s.rightOpen)
  const toggleLeft = useLayoutStore((s) => s.toggleLeft)
  const toggleRight = useLayoutStore((s) => s.toggleRight)
  const setSettingsOpen = useLayoutStore((s) => s.setSettingsOpen)
  const [profileTitle, setProfileTitle] = useState<string | null>(null)

  useEffect(() => {
    void window.nais.invoke('app:profile', undefined).then(({ profile, title }) => {
      if (profile > 0) {
        setProfileTitle(title)
        document.title = title
      }
    })
  }, [])

  return (
    <header
      className="drag relative flex h-14 shrink-0 select-none items-stretch gap-1.5 bg-surface pl-4 pr-2"
      style={{ paddingLeft: isMac ? 90 : undefined }}
    >
      {/* 왼쪽: 로고 · 이름 · 탭. 탭 사이 빈 곳과 오른쪽 빈 곳은 창을 끄는 자리 */}
      <span className="mr-3 flex shrink-0 items-center gap-2 whitespace-nowrap text-[15px] font-extrabold tracking-tight text-ink">
        <i aria-hidden className="block size-3.5 rotate-45 rounded-[2px] bg-mark" />
        {profileTitle ?? 'Atelier'}
      </span>
      <PageNav />
      <div className="min-w-4 flex-1" />

      {/* 오른쪽: Anlas · V5 · Anlas 소모 · 업데이트 · 테마 · 패널 · 설정 · 창 컨트롤 */}
      <div className="flex shrink-0 items-center gap-1">
        <HeaderMeters />
        <AnlasSpendSwitch />
        <UpdateButton />
        <div className="no-drag mx-0.5 shrink-0">
          <ThemeToggle />
        </div>
        <BarButton
          onClick={toggleLeft}
          active={leftOpen}
          title="생성 패널 접기/펴기"
          aria-label="생성 패널 접기/펴기"
          aria-pressed={leftOpen}
        >
          <PanelLeft size={16} />
        </BarButton>
        <BarButton
          onClick={toggleRight}
          active={rightOpen}
          title="히스토리 패널 접기/펴기"
          aria-label="히스토리 패널 접기/펴기"
          aria-pressed={rightOpen}
        >
          <PanelRight size={16} />
        </BarButton>
        <BarButton onClick={() => setSettingsOpen(true)} title="설정" aria-label="설정">
          <Settings size={16} />
        </BarButton>
        {!isMac && (
          <div className="no-drag ml-1 flex shrink-0 items-center">
            <BarButton className="w-10" onClick={() => ctrl('minimize')} aria-label="최소화">
              <Minus size={15} />
            </BarButton>
            <BarButton className="w-10" onClick={() => ctrl('maximize')} aria-label="최대화">
              <Square size={12} />
            </BarButton>
            <BarButton
              className="w-10 hover:bg-bad-fill hover:text-white"
              onClick={() => ctrl('close')}
              aria-label="닫기"
            >
              <X size={15} />
            </BarButton>
          </div>
        )}
      </div>
    </header>
  )
}
