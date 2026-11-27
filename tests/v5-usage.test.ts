import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchAnlasBalance } from '../src/main/nai/client'
import { checkFreeGeneration } from '../src/main/nai/spending-policy'
import { estimateV5Images, v5Extra, v5Remaining, v5UsageText } from '../src/shared/v5-usage'
import type { GenerationRequest, V5UsageStatus } from '../src/shared/types'

const usage = (patch: Partial<V5UsageStatus>): V5UsageStatus => ({
  isNegative: false,
  percent: 0,
  purchasedPercent: 0,
  timeUntilNextPercent: 6048,
  ...patch
})

const subscription = (body: unknown): void => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(body), { status: 200 })
  )
}

// NovelAI 웹: subscription.usage = { percent, purchasedPercent, isNegative, timeUntilNextPercent }.
// 부스터(Opus Usage Boost, perk usage_limit_add:100)는 percent가 아니라 purchasedPercent에 쌓인다.
describe('V5 사용량과 부스터 추가 사용량', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('구독 응답의 purchasedPercent를 읽는다', async () => {
    subscription({
      tier: 3,
      active: true,
      usage: { percent: 37, purchasedPercent: 100, isNegative: false, timeUntilNextPercent: 6048 }
    })
    const { v5Usage } = await fetchAnlasBalance('token')
    expect(v5Usage).toEqual({
      isNegative: false,
      percent: 37,
      purchasedPercent: 100,
      timeUntilNextPercent: 6048
    })
  })

  it('purchasedPercent 칸이 없는 응답은 0으로 둔다', async () => {
    subscription({
      tier: 3,
      active: true,
      usage: { percent: 37, isNegative: false, timeUntilNextPercent: 6048 }
    })
    const { v5Usage } = await fetchAnlasBalance('token')
    expect(v5Usage?.purchasedPercent).toBe(0)
  })

  it('남은 양은 기본 잔량 + 추가 사용량', () => {
    expect(v5Remaining(usage({ percent: 37, purchasedPercent: 100 }))).toBe(137)
    expect(v5Remaining(usage({ percent: 0, purchasedPercent: 100 }))).toBe(100)
    expect(v5Remaining(usage({ percent: 12, purchasedPercent: 100, isNegative: true }))).toBe(0)
    // 옛 값(칸 없음)이 들어와도 숫자가 깨지지 않는다
    expect(v5Extra({ isNegative: false, percent: 5, timeUntilNextPercent: 0 } as never)).toBe(0)
  })

  it('화면 글자: 추가 사용량이 있을 때만 덧붙인다', () => {
    expect(v5UsageText(usage({ percent: 85 }))).toBe('85%')
    expect(v5UsageText(usage({ percent: 85, purchasedPercent: 100 }))).toBe('85% +100%')
    expect(v5UsageText(usage({ percent: 12, isNegative: true }))).toBe('−12%')
  })

  it('예상 장수는 추가 사용량까지 센다 (웹과 같음)', () => {
    expect(estimateV5Images(usage({ percent: 50 }))).toBe(865)
    expect(estimateV5Images(usage({ percent: 50, purchasedPercent: 100 }))).toBe(2595)
  })

  it('Anlas 소모 OFF: 기본 잔량이 0이어도 추가 사용량이 있으면 통과한다', async () => {
    const request = {
      model: 'nai-diffusion-5-full',
      width: 832,
      height: 1216,
      steps: 23
    } as GenerationRequest
    const refs = { characterCount: 0, vibeCount: 0, unencodedVibes: 0 }
    subscription({
      tier: 3,
      active: true,
      usage: { percent: 0, purchasedPercent: 100, isNegative: false, timeUntilNextPercent: 6048 }
    })
    await expect(checkFreeGeneration('token', request, refs)).resolves.toBeUndefined()
    vi.restoreAllMocks()
    subscription({
      tier: 3,
      active: true,
      usage: { percent: 0, purchasedPercent: 0, isNegative: false, timeUntilNextPercent: 6048 }
    })
    await expect(checkFreeGeneration('token', request, refs)).rejects.toThrow('V5 잔량 부족')
  })
})
