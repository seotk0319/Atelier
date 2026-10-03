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
const accounts: GenerationAccount[] = [1, 2, 3].map((n) => ({
  id: 'a' + n,
  name: '계정 ' + n,
  token: 't' + n
}))
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

// 생성은 끝나지 않게 두고, 어느 계정이 일을 받았는지만 본다.
function setup(
  excluded: string[],
  accelerated = true
): { queue: GenerationQueue; used: string[]; excluded: string[] } {
  const used: string[] = []
  const queue = new GenerationQueue(
    (_r, _id, _signal, account) => {
      used.push(account.id)
      return new Promise<string>(() => undefined)
    },
    {
      getAccounts: () => accounts,
      accelerationAvailable: true,
      isAccelerationEnabled: () => accelerated,
      getAccelerationExcluded: () => excluded
    }
  )
  queue.setDelayMs(0)
  return { queue, used, excluded }
}

describe('acceleration account selection', () => {
  it('uses only the checked accounts in acceleration mode', async () => {
    const { queue, used } = setup(['a2'])
    queue.enqueue(request, 5)
    await tick()
    expect(used.sort()).toEqual(['a1', 'a3'])
    expect(queue.status().availableSlots).toBe(0)
  })

  it('stops handing pending work to an account unchecked mid-run', async () => {
    const excluded: string[] = []
    const used: string[] = []
    const finish: Record<string, () => void> = {}
    const queue = new GenerationQueue(
      (_r, id, _signal, account) => {
        used.push(account.id)
        return new Promise<string>((resolve) => {
          finish[account.id] = () => resolve('done-' + id)
        })
      },
      {
        getAccounts: () => accounts,
        accelerationAvailable: true,
        isAccelerationEnabled: () => true,
        getAccelerationExcluded: () => excluded
      }
    )
    queue.setDelayMs(0)
    queue.enqueue(request, 6)
    await tick()
    expect([...used].sort()).toEqual(['a1', 'a2', 'a3'])
    // 계정 3을 빼고 그 작업을 끝내면, 계정 3이 비어도 남은 작업을 가져가지 않는다.
    excluded.push('a3')
    queue.refreshConfiguration()
    finish.a3()
    for (let i = 0; i < 5; i++) await tick()
    expect(used.filter((id) => id === 'a3')).toHaveLength(1)
    // 계정 1이 끝나면 계정 1이 다음 작업을 가져간다.
    finish.a1()
    for (let i = 0; i < 5; i++) await tick()
    expect(used.filter((id) => id === 'a1')).toHaveLength(2)
  })

  it('falls back to the first account when every account is unchecked, and ignores checks outside acceleration', async () => {
    const all = setup(['a1', 'a2', 'a3'])
    all.queue.enqueue(request, 2)
    await tick()
    expect(all.used).toEqual(['a1'])
    const off = setup(['a1'], false)
    off.queue.enqueue(request, 2)
    await tick()
    expect(off.used).toEqual(['a1'])
  })

  // 메인 생성은 거절되면(모든 계정 생성 중) 바로 뽑기 줄로 넣는다. 그 줄이 받아서 순서대로 도는지 본다.
  it('queues extra main generations in click order while both checked accounts are busy', async () => {
    const used: string[] = []
    const seeds: number[] = []
    const finish: Record<string, () => void> = {}
    const queue = new GenerationQueue(
      (r, id, _signal, account) => {
        used.push(account.id)
        seeds.push(r.seed)
        return new Promise<string>((resolve) => {
          finish[account.id] = () => resolve('done-' + id)
        })
      },
      {
        getAccounts: () => accounts,
        accelerationAvailable: true,
        isAccelerationEnabled: () => true,
        getAccelerationExcluded: () => ['a3']
      }
    )
    queue.setDelayMs(0)
    queue.enqueue({ ...request, seed: 1 }, 1)
    queue.enqueue({ ...request, seed: 2 }, 1)
    await tick()
    expect(queue.tryEnqueue({ ...request, seed: 3 }, 1).blockedReason).toBe('busy')
    expect(queue.tryEnqueueQuick({ ...request, seed: 3 }).ids).toHaveLength(1)
    expect(queue.tryEnqueueQuick({ ...request, seed: 4 }).ids).toHaveLength(1)
    finish.a2()
    for (let i = 0; i < 5; i++) await tick()
    finish.a1()
    for (let i = 0; i < 5; i++) await tick()
    expect(seeds).toEqual([1, 2, 3, 4])
    expect(used).toEqual(['a1', 'a2', 'a2', 'a1'])
  })
})
