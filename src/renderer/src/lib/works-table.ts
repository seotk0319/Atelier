// 작품 탭 표: 행 = 작품 묶음(inbox:works), 열 = 플랫폼. 데이터에 있는 것만으로 칸 상태를 정한다.
import type { InboxWork, InboxWorksResult } from '@shared/inbox'
import type { McpActivity } from '@shared/types'
import {
  changedAt,
  groupFreshness,
  type EditionRecord,
  type FreshnessSource
} from '@shared/work-freshness'

/** 원작은 에덴. 나머지는 이식 대상 (알림 「내 작품」과 같은 순서) */
export const ORIGIN = 'eden'
export const PORTS = [
  'babe',
  'luna',
  'elyn',
  'neko',
  'teapot',
  'crack',
  'genit',
  'rplay',
  'uumai',
  'chatple'
]
export const WORK_PLATFORMS = [ORIGIN, ...PORTS]

/**
 * absent: 연결돼 있고 목록을 읽었는데 그 작품이 없음
 * unknown: 연결 안 됨 등으로 목록을 못 읽어 있는지 모름 (화면에는 똑같이 —)
 * present: 올라가 있음 (그 밖에 아는 것 없음)
 * stale: 에덴 변경 시각이 이 플랫폼 변경 시각보다 뒤 (변경 시각 = 수집기 수정 시각과 MCP 저장 중 늦은 쪽)
 */
export type CellState = 'absent' | 'unknown' | 'present' | 'stale'

export interface WorkCell {
  platform: string
  state: CellState
  work: InboxWork | null
  /** 이 플랫폼의 마지막 변경 시각과 출처 (모르면 null) */
  changedAt: string | null
  source: FreshnessSource | null
}

export interface WorkTableRow {
  key: string
  title: string
  thumbnail: string | null
  /** 에덴 작품 (없으면 에덴에 없는 작품) */
  eden: InboxWork | null
  /** 에덴 쪽 마지막 변경 시각 (수집기·MCP 중 늦은 쪽, 모르면 null) */
  edenChangedAt: string | null
  cells: WorkCell[]
  /** 에덴을 뺀, 올라가 있는 이식본 (PORTS 순서) — 이식 문구 복사용 */
  ported: InboxWork[]
  /** 연결돼 있는데 안 올린 플랫폼 */
  missing: string[]
  staleCount: number
  unanswered: number
  activity: McpActivity | null
}

export type WorksFilter = 'all' | 'stale' | 'missing'

export const normWorkTitle = (s: string | null | undefined): string =>
  String(s ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, '')

const time = (iso: string | null | undefined): number | null => {
  if (!iso) return null
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : null
}

/**
 * 두 변경 시각이 다 있을 때만 판정한다. 하나라도 없으면 false (모름).
 * 변경 시각 = 수집기가 읽은 수정 시각과 MCP 저장 기록 중 늦은 쪽.
 */
export function isStale(
  eden: InboxWork | null,
  work: InboxWork | null,
  saved: readonly EditionRecord[] = []
): boolean {
  if (!eden || !work || work.platform === ORIGIN) return false
  const a = time(changedAt(eden, saved).at)
  const b = time(changedAt(work, saved).at)
  return a !== null && b !== null && a > b
}

/** 이 작품에 해당하는 가장 최근 MCP 기록 (작품 번호가 맞거나 제목이 같을 때) */
export function latestActivity(
  works: InboxWork[],
  title: string,
  items: McpActivity[]
): McpActivity | null {
  const titles = new Set([normWorkTitle(title), ...works.map((w) => normWorkTitle(w.title))])
  titles.delete('')
  let best: McpActivity | null = null
  for (const a of items) {
    const byId =
      !!a.workId && works.some((w) => w.id === a.workId && (!a.site || a.site === w.platform))
    const byTitle = !!a.workTitle && titles.has(normWorkTitle(a.workTitle))
    if (!byId && !byTitle) continue
    if (!best || (time(a.at) ?? 0) > (time(best.at) ?? 0)) best = a
  }
  return best
}

export function buildWorkRows(
  data: InboxWorksResult | null,
  activity: McpActivity[] = []
): WorkTableRow[] {
  if (!data) return []
  const supported = new Set(data.supported)
  const saved = data.saved ?? []
  const edenRows: { row: WorkTableRow; i: number }[] = []
  const others: WorkTableRow[] = []
  data.groups.forEach((g, i) => {
    const byPlatform = new Map<string, InboxWork>()
    for (const w of g.works) if (!byPlatform.has(w.platform)) byPlatform.set(w.platform, w)
    const eden = byPlatform.get(ORIGIN) ?? null
    const fresh = groupFreshness(g.works, saved)
    const cells: WorkCell[] = WORK_PLATFORMS.map((p) => {
      const work = byPlatform.get(p) ?? null
      const f = fresh.platforms.get(p)
      const state: CellState = work
        ? f?.stale === true
          ? 'stale'
          : 'present'
        : supported.has(p)
          ? 'absent'
          : 'unknown'
      return { platform: p, state, work, changedAt: f?.at ?? null, source: f?.source ?? null }
    })
    const row: WorkTableRow = {
      key: g.key,
      title: eden?.title ?? g.title,
      thumbnail: g.thumbnail,
      eden,
      edenChangedAt: fresh.edenChangedAt,
      cells,
      ported: PORTS.map((p) => byPlatform.get(p)).filter((w): w is InboxWork => !!w),
      missing: cells.filter((c) => c.state === 'absent').map((c) => c.platform),
      staleCount: cells.filter((c) => c.state === 'stale').length,
      unanswered: data.unanswered?.[g.key] ?? 0,
      activity: latestActivity(g.works, g.title, activity)
    }
    if (eden) edenRows.push({ row, i })
    else others.push(row)
  })
  // 에덴 작품은 에덴 목록 순서(최신 순)로, 그다음 에덴에 없는 작품은 받은 순서대로
  edenRows.sort(
    (a, b) => (time(b.row.eden!.at) ?? -Infinity) - (time(a.row.eden!.at) ?? -Infinity) || a.i - b.i
  )
  return [...edenRows.map((e) => e.row), ...others]
}

/** 비교할 수 있는 수정 시각이 한 쌍이라도 있는지 (없으면 「낡음」을 쓰지 않는다) */
export function hasFreshness(rows: WorkTableRow[]): boolean {
  return rows.some(
    (r) =>
      time(r.edenChangedAt) !== null &&
      r.cells.some((c) => c.platform !== ORIGIN && time(c.changedAt) !== null)
  )
}

export function filterWorkRows(rows: WorkTableRow[], filter: WorksFilter): WorkTableRow[] {
  if (filter === 'stale') return rows.filter((r) => r.staleCount > 0)
  if (filter === 'missing') return rows.filter((r) => r.missing.length > 0)
  return rows
}

/** ISO → "방금 / N분 전 / N시간 전 / N일 전" */
export function agoText(iso: string | null | undefined, now = Date.now()): string {
  const t = time(iso)
  if (t === null) return ''
  const d = Math.max(0, now - t)
  if (d < 60_000) return '방금'
  if (d < 3_600_000) return Math.floor(d / 60_000) + '분 전'
  if (d < 86_400_000) return Math.floor(d / 3_600_000) + '시간 전'
  return Math.floor(d / 86_400_000) + '일 전'
}
