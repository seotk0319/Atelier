import { describe, expect, it } from 'vitest'
import type { GenerationRequest, QueueItem } from '@shared/types'
import { groupQueue, modelLabel, trackTotals } from '../src/renderer/src/lib/queue-groups'

function item(
  id: string,
  state: QueueItem['state'],
  req: Partial<GenerationRequest> = {},
  priority?: boolean
): QueueItem {
  return {
    id,
    state,
    priority,
    request: {
      model: 'nai-diffusion-5-full',
      width: 1024,
      height: 1024,
      ...req
    } as GenerationRequest
  }
}

const presetOf = (sceneId: number): number | undefined =>
  sceneId < 100 ? 1 : sceneId < 200 ? 2 : undefined
const presetName = (id: number): string | undefined => ({ 1: '은비', 2: '유라' })[id]

describe('groupQueue', () => {
  it('groups live items by preset, quick picks and main batches; generating first', () => {
    const groups = groupQueue(
      [
        item('a', 'done', { sceneId: 1 }),
        item('b', 'pending', { sceneId: 1 }),
        item('c', 'pending', { sceneId: 150, width: 832, height: 1216 }),
        item('d', 'generating', { sceneId: 151 }),
        item('e', 'pending', { sceneId: 2 }, true),
        item('f', 'pending', {}),
        item('g', 'pending', { sceneId: 999 }),
        item('h', 'cancelled', { sceneId: 150 })
      ],
      presetOf,
      presetName
    )
    expect(groups.map((g) => [g.key, g.label, g.state, g.live])).toEqual([
      ['p2', '유라', 'generating', 2],
      ['p1', '은비', 'pending', 1],
      ['quick', '바로 뽑기', 'pending', 1],
      ['main', '생성 탭', 'pending', 1],
      ['scene', '씬 (프리셋 모름)', 'pending', 1]
    ])
    expect(groups[0].ids).toEqual(['c', 'd'])
    expect(groups[0].size).toBe('832 × 1216 외 1개')
    expect(groups[0].model).toBe('V5')
  })

  it('keeps the largest live count seen as the total and drops finished groups', () => {
    const first = groupQueue(
      [item('a', 'pending', { sceneId: 1 }), item('b', 'pending', { sceneId: 1 })],
      presetOf,
      presetName
    )
    let totals = trackTotals(new Map(), first)
    const later = groupQueue([item('b', 'generating', { sceneId: 1 })], presetOf, presetName)
    totals = trackTotals(totals, later)
    expect(totals.get('p1')).toBe(2)
    expect(trackTotals(totals, []).size).toBe(0)
  })

  it('labels models', () => {
    expect(modelLabel('nai-diffusion-4-5-full')).toBe('V4.5')
    expect(modelLabel('nai-diffusion-5-full-medium')).toBe('V5 절약')
  })
})
