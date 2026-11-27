import type { V5UsageStatus } from './types'
import { isMediumEffort, MEDIUM_EFFORT_USAGE_RATIO } from './nai-models'

// NovelAI 공식 FAQ 및 웹: 23 steps / 약 1MP 기준. 현재 설정으로 환산한 값이 아니다.
export const V5_ESTIMATE_BASIS =
  '23스텝 · 약 1MP 기준 예상치이며 현재 해상도·스텝에 따라 달라집니다'
/** 부스터로 쌓인 추가 사용량 (%). 옛 응답처럼 값이 없으면 0 */
export function v5Extra(usage: V5UsageStatus): number {
  const extra = Number(usage.purchasedPercent)
  return Number.isFinite(extra) && extra > 0 ? extra : 0
}

/** 지금 무료로 쓸 수 있는 양 (%) = 기본 잔량 + 추가 사용량. 한도를 넘겼으면(isNegative) 0 */
export function v5Remaining(usage: V5UsageStatus): number {
  if (usage.isNegative) return 0
  return Math.max(0, usage.percent) + v5Extra(usage)
}

/** 화면에 보이는 잔량 글자: 「85%」, 추가 사용량이 있으면 「85% +100%」, 한도를 넘겼으면 「−12%」 */
export function v5UsageText(usage: V5UsageStatus): string {
  if (usage.isNegative) return `−${usage.percent}%`
  const extra = v5Extra(usage)
  return extra > 0 ? `${usage.percent}% +${extra}%` : `${usage.percent}%`
}

/** model을 주면 V5 Full Medium(약 42% 덜 씀)으로 환산한다. 추가 사용량도 더해 센다 (NovelAI 웹과 같음) */
export function estimateV5Images(usage: V5UsageStatus, model?: string): number {
  if (usage.isNegative) return 0
  const perPercent = model && isMediumEffort(model) ? 17.3 / MEDIUM_EFFORT_USAGE_RATIO : 17.3
  return Math.floor(v5Remaining(usage) * perPercent)
}
