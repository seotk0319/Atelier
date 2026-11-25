import { describe, expect, it } from 'vitest'
import { GenerationQueue, type GenerationAccount } from '../src/main/queue/generation-queue'
import type { GenerationRequest } from '../src/shared/types'

const request = {
  prompt: '1girl',
  negativePrompt: '',
  model: 'nai-diffusion-4-5-full',
  width: 832,
  height: 1216,
  steps: 28,
  cfgScale: 5,
  cfgRescale: 0,
  sampler: 'k_euler_ancestral',
  noiseSchedule: 'karras',
  seed: 1,
  variety: false,
  qualityToggle: true,
  ucPreset: 0,
  characterPrompts: [],
  useCoords: false
} as GenerationRequest
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('account blocked by an auth error', () => {
  it('accepts new work again after the token is replaced', async () => {
    // 토큰을 바꿔도 계정 id는 그대로다 (db/settings.ts setNaiToken)
    const account: GenerationAccount = { id: 'a1', name: '계정 1', token: 'bad' }
    const queue = new GenerationQueue(
      async (_r, _id, _signal, acc) => {
        if (acc.token === 'bad') throw Object.assign(new Error('생성 실패 401'), { status: 401 })
        return 'C:/out.png'
      },
      { getAccounts: () => [account] }
    )
    queue.setDelayMs(0)

    queue.enqueue(request, 1)
    await tick()
    expect(queue.status().counts.failed).toBe(1)
    expect(queue.tryEnqueue(request, 1).blockedReason).toBe('busy')

    account.token = 'good'
    queue.refreshConfiguration()
    const result = queue.tryEnqueue(request, 1)
    expect(result.blockedReason).toBeUndefined()
    await tick()
    expect(queue.status().counts.done).toBe(1)
  })

  it('hands the image to another account when one account gets 401 in acceleration', async () => {
    const accounts: GenerationAccount[] = [
      { id: 'a1', name: '계정 1', token: 'bad' },
      { id: 'a2', name: '계정 2', token: 'good' }
    ]
    const used: string[] = []
    const queue = new GenerationQueue(
      async (_r, _id, _signal, acc) => {
        used.push(acc.id)
        if (acc.token === 'bad') throw Object.assign(new Error('생성 실패 401'), { status: 401 })
        return 'C:/out.png'
      },
      {
        getAccounts: () => accounts,
        accelerationAvailable: true,
        isAccelerationEnabled: () => true
      }
    )
    queue.setDelayMs(0)
    queue.enqueue(request, 2)
    for (let i = 0; i < 10; i++) await tick()
    const { counts } = queue.status()
    expect(counts.done).toBe(2)
    expect(counts.failed).toBe(0)
    expect(used.filter((id) => id === 'a1')).toHaveLength(1)
  })

  it('treats a server error whose text mentions "aborted" as a failure, not a cancel', async () => {
    const queue = new GenerationQueue(async () => {
      throw Object.assign(new Error('생성 실패 400: upstream connection aborted'), { status: 400 })
    })
    queue.setDelayMs(0)
    queue.enqueue(request, 1)
    await tick()
    expect(queue.status().counts).toMatchObject({ failed: 1, cancelled: 0 })
  })
})
