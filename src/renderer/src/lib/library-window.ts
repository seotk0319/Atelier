// 라이브러리의 "최근 1주 먼저, 그 전은 1주씩" 창 계산. 날짜는 모두 로컬 날짜 문자열(YYYY-MM-DD).
import type { LibraryDateGroup } from '@shared/types'

export const WINDOW_DAYS = 7

/** 로컬 날짜에 날 수를 더한다 */
export function shiftDate(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number)
  const next = new Date(y, m - 1, d + days)
  return (
    next.getFullYear() +
    '-' +
    String(next.getMonth() + 1).padStart(2, '0') +
    '-' +
    String(next.getDate()).padStart(2, '0')
  )
}

/** 오늘을 끝으로 하는 1주 창의 첫날 */
export function recentWindowStart(now: Date): string {
  const today =
    now.getFullYear() +
    '-' +
    String(now.getMonth() + 1).padStart(2, '0') +
    '-' +
    String(now.getDate()).padStart(2, '0')
  return shiftDate(today, -(WINDOW_DAYS - 1))
}

export interface OlderWindow {
  /** 넓힌 창의 첫날 */
  since: string
  /** 새로 들어오는 구간에서 그림이 있는 마지막 날 */
  to: string
  /** 새로 들어오는 구간의 그림 수 (날짜 목록 기준) */
  count: number
}

/**
 * 지금 창(since부터)보다 오래된 쪽으로 1주 넓힌 창. 그림이 없는 주는 건너뛰어,
 * since 앞에서 그림이 있는 가장 가까운 날을 끝으로 하는 1주를 잡는다. 더 없으면 null.
 * dates는 최신 날짜가 앞에 오는 목록.
 */
export function olderWindow(dates: LibraryDateGroup[], since: string): OlderWindow | null {
  const to = dates.find((d) => d.date < since)?.date
  if (!to) return null
  const next = shiftDate(to, -(WINDOW_DAYS - 1))
  let count = 0
  for (const d of dates) if (d.date >= next && d.date < since) count += d.count
  return { since: next, to, count }
}
