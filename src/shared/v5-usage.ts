import type { V5UsageStatus } from './types'
import { isMediumEffort, MEDIUM_EFFORT_USAGE_RATIO } from './nai-models'

// NovelAI 공식 FAQ 및 웹: 23 steps / 약 1MP 기준. 현재 설정으로 환산한 값이 아니다.
export const V5_ESTIMATE_BASIS =
  '23스텝 · 약 1MP 기준 예상치이며 현재 해상도·스텝에 따라 달라집니다'
/** model을 주면 V5 Full Medium(약 42% 덜 씀)으로 환산한다 */
export function estimateV5Images(usage: V5UsageStatus, model?: string): number {
  if (usage.isNegative) return 0
  const perPercent = model && isMediumEffort(model) ? 17.3 / MEDIUM_EFFORT_USAGE_RATIO : 17.3
  return Math.floor(Math.max(0, usage.percent) * perPercent)
}
