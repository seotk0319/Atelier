import { beforeAll, describe, expect, it } from 'vitest'

beforeAll(() => {
  const store = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
      removeItem: (key: string) => store.delete(key)
    },
    configurable: true
  })
})

type Helpers = typeof import('../src/renderer/src/stores/scenes-store')
async function helpers(): Promise<Helpers> {
  return await import('../src/renderer/src/stores/scenes-store')
}

describe('예약을 큐에 넘긴 뒤 넘긴 장수만 뺀다', () => {
  it('넘기는 사이에 누른 +1은 남는다', async () => {
    const { subtractSentReserves } = await helpers()
    // 넘길 때 3장 → 그사이 +1 눌러 4장
    const scenes = [
      { id: 1, reserveCount: 4 },
      { id: 2, reserveCount: 2 },
      { id: 3, reserveCount: 5 }
    ]
    const sent = [
      { id: 1, count: 3 },
      { id: 2, count: 2 }
    ]
    expect(subtractSentReserves(scenes, sent)).toEqual([
      { id: 1, reserveCount: 1 },
      { id: 2, reserveCount: 0 },
      { id: 3, reserveCount: 5 }
    ])
  })

  it('그사이 -1로 줄였으면 0 아래로 내려가지 않는다', async () => {
    const { subtractSentReserves } = await helpers()
    expect(subtractSentReserves([{ id: 1, reserveCount: 1 }], [{ id: 1, count: 3 }])).toEqual([
      { id: 1, reserveCount: 0 }
    ])
  })

  it('같은 장수끼리 묶어 본체에 한 번씩 보낸다', async () => {
    const { groupSentByCount } = await helpers()
    expect([
      ...groupSentByCount([
        { id: 1, count: 3 },
        { id: 2, count: 1 },
        { id: 3, count: 3 },
        { id: 4, count: 0 }
      ])
    ]).toEqual([
      [3, [1, 3]],
      [1, [2]]
    ])
  })
})
