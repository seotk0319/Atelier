import type { QueueItem } from '@shared/types'
import { isMediumEffort, isV5Model } from '@shared/nai-models'

/** 대기열 표의 한 줄: 같은 씬 프리셋(또는 바로 뽑기·생성 탭)에서 들어온 남은 장들 */
export interface QueueGroup {
  key: string
  label: string
  /** 한 장이라도 생성 중이면 'generating' */
  state: 'generating' | 'pending'
  /** 대기 + 생성 중 장수 */
  live: number
  /** 취소할 때 넘길 큐 항목 id (대기 + 생성 중) */
  ids: string[]
  model: string
  size: string
}

export function modelLabel(model: string): string {
  if (!isV5Model(model)) return 'V4.5'
  return isMediumEffort(model) ? 'V5 절약' : 'V5'
}

function summarize(values: string[]): string {
  const unique = [...new Set(values)]
  if (unique.length <= 1) return unique[0] ?? '—'
  return `${unique[0]} 외 ${unique.length - 1}개`
}

/**
 * 남은 큐 항목을 묶는다. 바로 뽑기(+1장)는 한 줄, 씬이 없는 요청(생성 탭)은 한 줄,
 * 씬 요청은 그 씬의 프리셋별로. 프리셋을 모르는 씬은 따로 한 줄.
 * 순서는 큐에서 처음 보인 순서이고, 생성 중인 줄을 맨 위에 둔다.
 */
export function groupQueue(
  items: QueueItem[],
  presetOf: (sceneId: number) => number | undefined,
  presetName: (presetId: number) => string | undefined
): QueueGroup[] {
  const groups = new Map<
    string,
    { label: string; generating: boolean; ids: string[]; models: string[]; sizes: string[] }
  >()
  for (const it of items) {
    if (it.state !== 'pending' && it.state !== 'generating') continue
    const sceneId = it.request.sceneId
    let key: string
    let label: string
    if (it.priority) {
      key = 'quick'
      label = '바로 뽑기'
    } else if (sceneId == null) {
      key = 'main'
      label = '생성 탭'
    } else {
      const presetId = presetOf(sceneId)
      if (presetId === undefined) {
        key = 'scene'
        label = '씬 (프리셋 모름)'
      } else {
        key = `p${presetId}`
        label = presetName(presetId) ?? `프리셋 ${presetId}`
      }
    }
    let g = groups.get(key)
    if (!g) {
      g = { label, generating: false, ids: [], models: [], sizes: [] }
      groups.set(key, g)
    }
    g.ids.push(it.id)
    if (it.state === 'generating') g.generating = true
    g.models.push(modelLabel(it.request.model))
    g.sizes.push(`${it.request.width} × ${it.request.height}`)
  }
  const list: QueueGroup[] = [...groups].map(([key, g]) => ({
    key,
    label: g.label,
    state: g.generating ? 'generating' : 'pending',
    live: g.ids.length,
    ids: g.ids,
    model: summarize(g.models),
    size: summarize(g.sizes)
  }))
  return [
    ...list.filter((g) => g.state === 'generating'),
    ...list.filter((g) => g.state === 'pending')
  ]
}

/**
 * 줄마다 "이번에 몇 장이었는지"를 센다. 큐는 끝난 항목을 오래 들고 있지 않으므로
 * 그 줄에서 본 가장 많은 남은 장수를 전체로 잡는다. 남은 장이 없어진 줄은 지운다.
 */
export function trackTotals(prev: Map<string, number>, groups: QueueGroup[]): Map<string, number> {
  const next = new Map<string, number>()
  for (const g of groups) next.set(g.key, Math.max(prev.get(g.key) ?? 0, g.live))
  return next
}
