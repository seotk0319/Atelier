// 플랫폼별 내 작품을 같은 제목끼리 묶는다 (이식본 한 줄로 보기).
import type { InboxWork, InboxWorkGroup } from '../../shared/inbox'
import { normTitle, safeImage, thumbUrl } from './work-images'

// 썸네일은 1:1 베이비챗 이미지를 먼저 쓴다 (알림 썸네일과 같은 기준)
const THUMB_ORDER = ['babe', 'eden', 'genit', 'crack', 'elyn', 'neko', 'teapot', 'luna']

/**
 * 끝 글자가 잘린 제목(티팟 「과외생 길들이」 ↔ 「과외생 길들이기」)을 같은 작품으로 본다.
 * 다섯 글자 이상이고 1~2글자만 짧으며, 앞부분이 같은 후보가 하나뿐일 때만 잇는다.
 */
function mergeTruncated(groups: Map<string, InboxWork[]>): void {
  const keys = [...groups.keys()].filter((k) => !k.includes(':'))
  for (const short of keys) {
    if (short.length < 5 || !groups.has(short)) continue
    const longer = keys.filter(
      (k) => k !== short && groups.has(k) && k.startsWith(short) && k.length - short.length <= 2
    )
    if (longer.length !== 1) continue
    const target = groups.get(longer[0])!
    const moving = groups.get(short)!
    // 같은 플랫폼 작품이 이미 있으면 다른 작품일 수 있으니 잇지 않는다
    if (moving.some((w) => target.some((t) => t.platform === w.platform))) continue
    target.push(...moving)
    groups.delete(short)
  }
}

export function groupWorks(
  works: InboxWork[],
  catalogByName: Record<string, string> = {}
): InboxWorkGroup[] {
  const groups = new Map<string, InboxWork[]>()
  for (const w of works) {
    const key = normTitle(w.title) || w.platform + ':' + w.id
    const list = groups.get(key)
    if (list) list.push(w)
    else groups.set(key, [w])
  }
  mergeTruncated(groups)
  const latest = (list: InboxWork[]): string =>
    list.reduce((m, w) => ((w.at ?? '') > m ? (w.at ?? '') : m), '')
  return [...groups]
    .map(([key, list]) => {
      // 먼저 올린 곳부터 (원작 → 이식)
      const sorted = [...list].sort((a, b) => (a.at ?? '9').localeCompare(b.at ?? '9'))
      const babe = sorted.find((w) => w.platform === 'babe')
      let image: string | null = catalogByName[key] ?? null
      for (const p of THUMB_ORDER) {
        if (image) break
        image = sorted.find((w) => w.platform === p && w.image)?.image ?? null
      }
      const safe = image ? safeImage(image) : null
      // 이름은 베이비챗 → 가장 긴 제목 (잘린 제목을 대표로 쓰지 않게)
      const title =
        babe?.title ?? [...sorted].sort((a, b) => b.title.length - a.title.length)[0].title
      return { key, title, thumbnail: safe ? thumbUrl(safe) : null, works: sorted }
    })
    .sort((a, b) => latest(b.works).localeCompare(latest(a.works)))
}
