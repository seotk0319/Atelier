// works_status: 저장해 둔 작품 목록(알림 수집기)과 MCP 저장 기록만으로 작품별 플랫폼 현황을 돌려준다.
// 플랫폼에는 묻지 않는다. 판정 규칙은 작품 탭과 같다 (shared/work-freshness.ts).
import type { InboxWorksResult } from '../../shared/inbox'
import { EDEN, groupFreshness, type EditionRecord } from '../../shared/work-freshness'
import type { ToolDef } from './tools'

export interface WorksStatusSource {
  /** 저장해 둔 작품 목록 (사이트에 묻지 않은 것) */
  works: InboxWorksResult | null
  /** MCP 저장 기록 */
  saved: EditionRecord[]
}

export const WORKS_STATUS_NOTE =
  '저장해 둔 목록과 MCP 저장 기록만 읽은 결과예요 (이 호출은 플랫폼에 묻지 않아요). ' +
  'registered는 마지막으로 읽은 작품 목록 기준이고, fetched_at 이후 바뀐 것은 반영되지 않았을 수 있어요. ' +
  'synced_at은 그 플랫폼의 마지막 변경 시각으로, 알림 수집기가 읽은 수정 시각(source=site)과 ' +
  'MCP 저장 도구가 성공한 시각(source=mcp) 중 늦은 쪽이에요. eden_changed_at도 같은 방식이에요. ' +
  'stale은 두 시각을 다 알 때만 true/false(에덴이 더 늦으면 true)이고, 하나라도 모르면 null이에요.'

export function worksStatusResult(src: WorksStatusSource): Record<string, unknown> {
  const data = src.works
  const supported = data?.supported ?? []
  const groups = (data?.groups ?? []).map((g) => {
    const { edenChangedAt, platforms } = groupFreshness(g.works, src.saved)
    const names = [...new Set([...supported, ...g.works.map((w) => w.platform)])]
    const byPlatform: Record<string, unknown> = {}
    for (const p of names) {
      const work = g.works.find((w) => w.platform === p) ?? null
      const f = platforms.get(p)
      byPlatform[p] = {
        registered: !!work,
        work_id: work?.id ?? null,
        stale: p === EDEN ? null : (f?.stale ?? null),
        synced_at: f?.at ?? null,
        source: f?.source ?? null
      }
    }
    const eden = g.works.find((w) => w.platform === EDEN)
    return {
      title: eden?.title ?? g.title,
      eden_changed_at: edenChangedAt,
      platforms: byPlatform
    }
  })
  return {
    fetched_at: data?.fetchedAt ?? null,
    connected: supported,
    login_lost: data?.loginLost ?? [],
    count: groups.length,
    groups,
    note: WORKS_STATUS_NOTE
  }
}

export function createStatusTool(load?: () => Promise<WorksStatusSource>): ToolDef {
  return {
    name: 'works_status',
    description:
      '내 작품별로 어느 플랫폼에 올라가 있는지와 에덴보다 낡았는지를 저장된 자료만으로 돌려준다 ' +
      '(플랫폼에 묻지 않음). stale은 수정 시각을 양쪽 다 알 때만 true/false, 모르면 null. ' +
      '최신 목록이 필요하면 works_list로 그 플랫폼을 직접 읽는다.',
    inputSchema: { type: 'object', properties: {} },
    async run() {
      const src = load ? await load() : { works: null, saved: [] }
      return worksStatusResult(src)
    }
  }
}
