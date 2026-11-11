import { Coins } from 'lucide-react'
import { useEffect } from 'react'
import { estimateAnlas } from '@shared/anlas'
import type { V5UsageStatus } from '@shared/types'
import { estimateV5Images, V5_ESTIMATE_BASIS } from '@shared/v5-usage'
import { isMediumEffort, MEDIUM_EFFORT_STEPS } from '@shared/nai-models'
import { formatEta, useQueueRun } from '../lib/queue-run'
import { cn } from '../lib/utils'
import { useGenerationStore } from '../stores/generation-store'
import { useCharRefsStore, useVibesStore } from '../stores/refs-store'
import { useScenesStore } from '../stores/scenes-store'
import { PresetDropdown } from './scene-mode'

function formatDuration(seconds: number): string {
  const value = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(value / 3600)
  const minutes = Math.floor((value % 3600) / 60)
  const secs = value % 60
  if (hours > 0) return `${hours}시간 ${minutes}분 ${secs}초`
  if (minutes > 0) return `${minutes}분 ${secs}초`
  return `${secs}초`
}

/** 이름 + 값 한 칸 */
function Cell({
  label,
  children,
  title,
  className
}: {
  label: string
  children: React.ReactNode
  title?: string
  className?: string
}): React.JSX.Element {
  return (
    <span className="flex h-[60px] shrink-0 flex-col justify-center leading-tight" title={title}>
      <small className="text-[12px] text-faint">{label}</small>
      <b className={cn('text-[14px] font-semibold tabular-nums text-ink', className)}>{children}</b>
    </span>
  )
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
 * 머리줄 아래 요약 줄 (생성·씬·선별 탭). 지금 씬 프리셋, 이번 묶음 진행, Anlas·V5 잔량.
 * 값이 아직 없으면 그 칸은 그리지 않는다. 다른 탭에서는 숨기기만 해서 잔량 갱신 타이머는 계속 돈다.
 */
export function SummaryStrip({ visible }: { visible: boolean }): React.JSX.Element {
  const run = useQueueRun((s) => s.run)
  const presetsLoaded = useScenesStore((s) => s.presets.length > 0)
  const sceneCount = useScenesStore((s) => s.scenes.length)
  const anlasBalance = useGenerationStore((s) => s.anlasBalance)
  const v5Usage = useGenerationStore((s) => s.v5Usage)
  const refreshAnlas = useGenerationStore((s) => s.refreshAnlas)

  // 이번 생성에 소모될 Anlas 추정 (고해상도·캐릭터 레퍼런스·미인코딩 바이브 등)
  const request = useGenerationStore((s) => s.request)
  const batchCount = useGenerationStore((s) => s.batchCount)
  const tier = useGenerationStore((s) => s.subscriptionTier)
  const enabledCrefs = useCharRefsStore((s) => s.items.filter((c) => c.enabled).length)
  const unencodedVibes = useVibesStore(
    (s) => s.items.filter((v) => v.enabled && !v.encodedReady).length
  )
  const anlasCost = estimateAnlas({
    width: request.width,
    height: request.height,
    steps: isMediumEffort(request.model) ? MEDIUM_EFFORT_STEPS : request.steps,
    model: request.model,
    strength: request.source ? (request.i2iStrength ?? 0.7) : 1,
    charRefCount: enabledCrefs,
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

  // 씬 탭을 아직 안 열었으면 프리셋 이름이 비어 있다
  useEffect(() => {
    if (visible && !presetsLoaded) void useScenesStore.getState().loadPresets()
  }, [visible, presetsLoaded])

  const showRun = run !== null && run.total > 0
  const eta = showRun && run.perMinute ? formatEta(run.remaining / run.perMinute) : null

  return (
    <div
      className={cn(
        'flex h-[60px] shrink-0 items-center gap-7 overflow-hidden whitespace-nowrap bg-surface px-4',
        !visible && 'hidden'
      )}
    >
      {/* 왼쪽 칸들은 자리가 모자라면 다음 줄로 넘어가 가려진다 (오른쪽 Anlas·V5는 늘 보인다) */}
      <div className="flex h-[60px] min-w-0 flex-1 flex-wrap items-center gap-x-7 overflow-hidden">
        <span className="flex h-[60px] min-w-0 shrink items-center">
          <PresetDropdown triggerClassName="-ml-2 h-9 max-w-[360px] bg-transparent px-2 text-[15px] font-bold hover:bg-surface-2" />
        </span>
        {showRun && (
          <Cell label="진행" className="text-good">
            {run.done.toLocaleString()} / {run.total.toLocaleString()}장
          </Cell>
        )}
        {eta && <Cell label="남은 시간">{eta.replace(/^약 /, '')}</Cell>}
        {showRun && run.perMinute && (
          <Cell label="속도">분당 {Math.round(run.perMinute).toLocaleString()}장</Cell>
        )}
        {showRun && run.failed > 0 && (
          <Cell label="실패" className="text-bad">
            {run.failed.toLocaleString()}장
          </Cell>
        )}
        {presetsLoaded && <Cell label="씬">{sceneCount.toLocaleString()}개</Cell>}
      </div>
      {anlasBalance !== null && (
        <Cell
          label="Anlas"
          title={
            anlasCost > 0
              ? `Anlas 잔액 (생성할 때마다 갱신)\n이번 생성에 ${anlasCost}만큼 써요 (고해상도 · 캐릭터 레퍼런스 · 미인코딩 바이브 포함)`
              : 'Anlas 잔액 (생성할 때마다 갱신)'
          }
        >
          <span className="flex items-center gap-1.5">
            <Coins size={13} className="text-[#c9a34f]" aria-hidden />
            {anlasBalance.toLocaleString()}
            {anlasCost > 0 && (
              <span className="rounded-md bg-bad-soft px-1.5 text-[12px] font-semibold text-bad">
                -{anlasCost}
              </span>
            )}
          </span>
        </Cell>
      )}
      {v5Usage && (
        <Cell
          label="V5 잔량"
          title={v5Tooltip(v5Usage, request.model)}
          className={v5Usage.isNegative ? 'text-bad' : undefined}
        >
          <span className="flex items-center gap-1.5">
            <span>
              {v5Usage.isNegative ? '−' : ''}
              {v5Usage.percent}%
            </span>
            <span
              className="inline-block h-1 w-10 shrink-0 overflow-hidden bg-surface-3"
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
            <span className="text-[12px] font-normal text-muted">
              {v5Usage.isNegative
                ? '제한됨'
                : `약 ${estimateV5Images(v5Usage, request.model).toLocaleString()}장`}
            </span>
          </span>
        </Cell>
      )}
    </div>
  )
}
