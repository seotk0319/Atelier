import { INBOX_PLATFORMS, type InboxWork } from './inbox'

/** ISO 시각 → 한국 시각 MM/DD. 없으면 '--/--' */
export function workDate(iso: string | null): string {
  if (!iso) return '--/--'
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return '--/--'
  const kst = new Date(t + 9 * 60 * 60_000)
  const mm = String(kst.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(kst.getUTCDate()).padStart(2, '0')
  return mm + '/' + dd
}

/** ISO 시각 → 한국 시각 YYYY.MM.DD HH:mm (자세히 보기용) */
export function workDateTime(iso: string | null): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const k = new Date(t + 9 * 60 * 60_000)
  const p = (n: number): string => String(n).padStart(2, '0')
  return (
    k.getUTCFullYear() +
    '.' +
    p(k.getUTCMonth() + 1) +
    '.' +
    p(k.getUTCDate()) +
    ' ' +
    p(k.getUTCHours()) +
    ':' +
    p(k.getUTCMinutes())
  )
}

export function platformName(platform: string): string {
  return (INBOX_PLATFORMS as Record<string, string>)[platform] ?? platform
}

/**
 * 복사 문구 (플랫폼 하나):
 * 이식 플랫폼 : 에덴
 * 업로드(최초공개일) 일자 : 10/17
 *
 * 에덴: https://...
 */
export function workCopyText(work: InboxWork): string {
  const name = platformName(work.platform)
  return (
    '이식 플랫폼 : ' +
    name +
    '\n업로드(최초공개일) 일자 : ' +
    workDate(work.at) +
    '\n\n' +
    name +
    ': ' +
    work.url
  )
}

/** 작품 전체 복사: 플랫폼 블록을 빈 줄 하나로 잇는다 */
export function workGroupCopyText(works: InboxWork[]): string {
  return works.map(workCopyText).join('\n\n')
}
