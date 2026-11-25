import type { AnlasEstimateInput } from '@shared/anlas'
import { effortForRefs } from '@shared/char-refs'
import { isMediumEffort, isV5Model, MEDIUM_EFFORT_STEPS } from '@shared/nai-models'
import type { GenerationRequest } from '@shared/types'

/**
 * 메인 생성 한 번의 Anlas 추정 입력 — 실제로 보내는 값과 맞춘다 (제목줄·왼쪽 요약 공용).
 * - i2i·인페인트는 원본 그림 크기로, 강도(기본 0.7)를 곱해 보낸다
 * - V5 인페인트는 레퍼런스를 빼고 보낸다(실측 레퍼 사용료 0)
 * - V5는 바이브를 보내지 않는다(미인코딩 바이브 인코딩 비용 없음)
 */
export function mainCostInput(args: {
  request: GenerationRequest
  source: { maskBase64?: string; width: number; height: number } | null
  sentCrefs: number
  isOpus: boolean
  batchCount: number
  unencodedVibes: number
}): AnlasEstimateInput {
  const { request, source } = args
  const v5 = isV5Model(request.model)
  const refs = v5 && source?.maskBase64 ? 0 : args.sentCrefs
  const model = effortForRefs(request.model, refs)
  return {
    width: source?.width ?? request.width,
    height: source?.height ?? request.height,
    steps: isMediumEffort(model) ? MEDIUM_EFFORT_STEPS : request.steps,
    model,
    strength: source ? (request.i2iStrength ?? 0.7) : 1,
    charRefCount: refs,
    isOpus: args.isOpus,
    batchCount: args.batchCount,
    unencodedVibes: v5 ? 0 : args.unencodedVibes
  }
}
