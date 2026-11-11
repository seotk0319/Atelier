// 작품 묶음의 플랫폼별 「낡음」 판정. 화면(작품 탭)과 MCP works_status가 같이 쓴다.
// 시각은 두 곳에서 온다: 알림 수집기가 읽은 플랫폼 수정 시각(updatedAt)과,
// MCP 저장 도구가 성공할 때 남긴 기록(lastSavedAt). 둘 중 늦은 쪽을 그 플랫폼의 시각으로 본다.
import type { InboxWork } from './inbox'

/** MCP로 저장한 작품 하나의 기록 (<userData>/mcp/editions.json) */
export interface EditionRecord {
  site: string
  workId: string
  title: string | null
  lastSavedAt: string
  lastTool: string
}

export type FreshnessSource = 'mcp' | 'site'

export interface PlatformFreshness {
  /** 그 플랫폼의 마지막 변경 시각 (수집기·MCP 중 늦은 쪽). 모르면 null */
  at: string | null
  source: FreshnessSource | null
  /** 에덴이 그 뒤에 바뀌었는지. 어느 한쪽이라도 모르면 null. 에덴 자신은 늘 null */
  stale: boolean | null
}

export const EDEN = 'eden'

const time = (iso: string | null | undefined): number | null => {
  if (!iso) return null
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : null
}

/** 수집기 시각과 MCP 기록 시각 중 늦은 쪽과 그 출처 */
export function laterOf(
  site: string | null | undefined,
  mcp: string | null | undefined
): { at: string | null; source: FreshnessSource | null } {
  const a = time(site)
  const b = time(mcp)
  if (a === null && b === null) return { at: null, source: null }
  if (b === null || (a !== null && a >= b)) return { at: site!, source: 'site' }
  return { at: mcp!, source: 'mcp' }
}

/** 그 플랫폼·작품 번호의 MCP 저장 시각 */
export function savedAtOf(
  records: readonly EditionRecord[] | null | undefined,
  site: string,
  workId: string
): string | null {
  let best: string | null = null
  for (const r of records ?? [])
    if (
      r.site === site &&
      r.workId === workId &&
      (time(r.lastSavedAt) ?? -Infinity) > (time(best) ?? -Infinity)
    )
      best = r.lastSavedAt
  return best
}

/** 한 플랫폼의 작품이 언제 마지막으로 바뀌었는지 (수집기·MCP 중 늦은 쪽) */
export function changedAt(
  work: InboxWork | null | undefined,
  records: readonly EditionRecord[] | null | undefined
): { at: string | null; source: FreshnessSource | null } {
  if (!work) return { at: null, source: null }
  return laterOf(work.updatedAt ?? null, savedAtOf(records, work.platform, work.id))
}

/**
 * 묶음 안 플랫폼별 판정. 낡음은 두 시각을 다 알고 에덴 쪽이 더 늦을 때만 true,
 * 하나라도 모르면 null (표에는 표시하지 않는다).
 */
export function groupFreshness(
  works: readonly InboxWork[],
  records: readonly EditionRecord[] | null | undefined
): { edenChangedAt: string | null; platforms: Map<string, PlatformFreshness> } {
  const byPlatform = new Map<string, InboxWork>()
  for (const w of works) if (!byPlatform.has(w.platform)) byPlatform.set(w.platform, w)
  const eden = changedAt(byPlatform.get(EDEN), records)
  const edenTime = time(eden.at)
  const platforms = new Map<string, PlatformFreshness>()
  for (const [platform, work] of byPlatform) {
    const own = changedAt(work, records)
    const ownTime = time(own.at)
    const stale =
      platform === EDEN || edenTime === null || ownTime === null ? null : edenTime > ownTime
    platforms.set(platform, { at: own.at, source: own.source, stale })
  }
  return { edenChangedAt: eden.at, platforms }
}
