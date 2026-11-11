import { describe, expect, it } from 'vitest'
import type { InboxWork, InboxWorksResult } from '@shared/inbox'
import type { McpActivity } from '@shared/types'
import {
  agoText,
  buildWorkRows,
  filterWorkRows,
  hasFreshness,
  isStale,
  latestActivity,
  WORK_PLATFORMS
} from '../src/renderer/src/lib/works-table'
import { countByGroup } from '../src/main/notifications/work-groups'
import { worksStatusResult } from '../src/main/works/status-tool'
import type { EditionRecord } from '../src/shared/work-freshness'

function w(platform: string, id: string, title: string, extra: Partial<InboxWork> = {}): InboxWork {
  return {
    platform,
    id,
    title,
    url: 'https://example.com/' + platform + '/' + id,
    at: '2026-10-01T00:00:00.000Z',
    atKind: 'published',
    isPublic: true,
    image: null,
    ...extra
  }
}

function act(extra: Partial<McpActivity>): McpActivity {
  return {
    id: Math.random().toString(36),
    at: '2026-11-01T00:00:00.000Z',
    tool: 'work_save',
    kind: 'save',
    site: null,
    workId: null,
    workTitle: null,
    ok: true,
    verified: null,
    summary: '저장',
    error: null,
    ...extra
  }
}

const data = (
  groups: InboxWorksResult['groups'],
  extra: Partial<InboxWorksResult> = {}
): InboxWorksResult =>
  ({
    fetchedAt: '2026-11-10T00:00:00.000Z',
    groups,
    errors: {},
    supported: ['eden', 'babe', 'crack'],
    ...extra
  }) as InboxWorksResult

describe('작품 표 행 만들기', () => {
  it('에덴 작품을 에덴 공개일 최신 순으로 먼저, 에덴에 없는 작품은 받은 순서로 뒤에 둔다', () => {
    const rows = buildWorkRows(
      data([
        { key: 'x', title: 'X', thumbnail: null, works: [w('crack', 'c1', 'X')] },
        {
          key: 'a',
          title: 'A',
          thumbnail: null,
          works: [w('eden', 'e1', 'A', { at: '2026-09-01T00:00:00.000Z' })]
        },
        {
          key: 'b',
          title: 'B',
          thumbnail: null,
          works: [w('eden', 'e2', 'B', { at: '2026-10-05T00:00:00.000Z' })]
        },
        { key: 'y', title: 'Y', thumbnail: null, works: [w('babe', 'b9', 'Y')] }
      ])
    )
    expect(rows.map((r) => r.key)).toEqual(['b', 'a', 'x', 'y'])
    expect(rows[0].cells.map((c) => c.platform)).toEqual(WORK_PLATFORMS)
  })

  it('칸 상태: 있음 / 없음(연결됨) / 모름(연결 안 됨), 안 올린 곳과 이식본', () => {
    const [row] = buildWorkRows(
      data([
        {
          key: 'a',
          title: 'A',
          thumbnail: null,
          works: [w('eden', 'e1', 'A'), w('crack', 'c1', 'A')]
        }
      ])
    )
    const state = Object.fromEntries(row.cells.map((c) => [c.platform, c.state]))
    expect(state.eden).toBe('present')
    expect(state.crack).toBe('present')
    expect(state.babe).toBe('absent')
    expect(state.luna).toBe('unknown')
    expect(row.missing).toEqual(['babe'])
    expect(row.ported.map((p) => p.platform)).toEqual(['crack'])
  })

  it('낡음은 두 수정 시각이 다 있고 에덴이 뒤일 때만', () => {
    const eden = w('eden', 'e', 'A', { updatedAt: '2026-11-05T00:00:00.000Z' })
    expect(isStale(eden, w('crack', 'c', 'A', { updatedAt: '2026-11-01T00:00:00.000Z' }))).toBe(
      true
    )
    expect(isStale(eden, w('crack', 'c', 'A', { updatedAt: '2026-11-06T00:00:00.000Z' }))).toBe(
      false
    )
    expect(isStale(eden, w('babe', 'b', 'A', { updatedAt: null }))).toBe(false)
    expect(isStale(w('eden', 'e', 'A'), w('crack', 'c', 'A', { updatedAt: '2026-01-01' }))).toBe(
      false
    )
  })

  it('비교할 시각이 없으면 freshness 없음, 있으면 낡은 것 거르기가 된다', () => {
    const plain = buildWorkRows(
      data([
        {
          key: 'a',
          title: 'A',
          thumbnail: null,
          works: [w('eden', 'e', 'A'), w('crack', 'c', 'A')]
        }
      ])
    )
    expect(hasFreshness(plain)).toBe(false)
    const rows = buildWorkRows(
      data([
        {
          key: 'a',
          title: 'A',
          thumbnail: null,
          works: [
            w('eden', 'e', 'A', { updatedAt: '2026-11-05T00:00:00.000Z' }),
            w('crack', 'c', 'A', { updatedAt: '2026-11-01T00:00:00.000Z' })
          ]
        },
        { key: 'b', title: 'B', thumbnail: null, works: [w('eden', 'e2', 'B')] }
      ])
    )
    expect(hasFreshness(rows)).toBe(true)
    expect(filterWorkRows(rows, 'stale').map((r) => r.key)).toEqual(['a'])
    expect(filterWorkRows(rows, 'missing').map((r) => r.key)).toEqual(['a', 'b'])
    expect(filterWorkRows(rows, 'all')).toHaveLength(2)
  })

  it('댓글 수는 inbox:works가 준 묶음별 값', () => {
    const [row] = buildWorkRows(
      data([{ key: 'a', title: 'A', thumbnail: null, works: [w('eden', 'e', 'A')] }], {
        unanswered: { a: 3 }
      })
    )
    expect(row.unanswered).toBe(3)
  })
})

describe('낡음: 수집기 시각과 MCP 저장 기록', () => {
  const rec = (site: string, workId: string, lastSavedAt: string): EditionRecord => ({
    site,
    workId,
    title: 'A',
    lastSavedAt,
    lastTool: 'work_save'
  })
  const row = (works: InboxWork[], saved?: EditionRecord[]): ReturnType<typeof buildWorkRows>[0] =>
    buildWorkRows(data([{ key: 'a', title: 'A', thumbnail: null, works }], { saved }))[0]
  const cell = (r: ReturnType<typeof row>, p: string): ReturnType<typeof row>['cells'][0] =>
    r.cells.find((c) => c.platform === p)!

  it('수집기 시각만 있을 때', () => {
    const r = row([
      w('eden', 'e', 'A', { updatedAt: '2026-11-05T00:00:00.000Z' }),
      w('crack', 'c', 'A', { updatedAt: '2026-11-01T00:00:00.000Z' }),
      w('babe', 'b', 'A', { updatedAt: '2026-11-06T00:00:00.000Z' })
    ])
    expect(r.edenChangedAt).toBe('2026-11-05T00:00:00.000Z')
    expect(cell(r, 'crack')).toMatchObject({ state: 'stale', source: 'site' })
    expect(cell(r, 'babe')).toMatchObject({ state: 'present', source: 'site' })
  })

  it('MCP 기록만 있을 때', () => {
    const r = row(
      [w('eden', 'e', 'A'), w('crack', 'c', 'A'), w('babe', 'b', 'A')],
      [
        rec('eden', 'e', '2026-11-05T00:00:00.000Z'),
        rec('crack', 'c', '2026-11-01T00:00:00.000Z'),
        rec('babe', 'b', '2026-11-06T00:00:00.000Z')
      ]
    )
    expect(r.edenChangedAt).toBe('2026-11-05T00:00:00.000Z')
    expect(cell(r, 'crack')).toMatchObject({
      state: 'stale',
      source: 'mcp',
      changedAt: '2026-11-01T00:00:00.000Z'
    })
    expect(cell(r, 'babe').state).toBe('present')
    expect(hasFreshness([r])).toBe(true)
  })

  it('섞여 있으면 각 쪽에서 늦은 시각을 쓴다', () => {
    const r = row(
      [
        w('eden', 'e', 'A', { updatedAt: '2026-11-01T00:00:00.000Z' }),
        w('crack', 'c', 'A', { updatedAt: '2026-11-03T00:00:00.000Z' }),
        w('babe', 'b', 'A', { updatedAt: '2026-11-02T00:00:00.000Z' })
      ],
      [
        // 에덴은 MCP로 11-04에 저장 → 크랙(11-03, 사이트)보다 늦다
        rec('eden', 'e', '2026-11-04T00:00:00.000Z'),
        // 베이비챗은 MCP로 11-05에 저장 → 에덴보다 늦다
        rec('babe', 'b', '2026-11-05T00:00:00.000Z'),
        // 다른 작품 번호의 기록은 쓰지 않는다
        rec('crack', 'zz', '2026-11-09T00:00:00.000Z')
      ]
    )
    expect(r.edenChangedAt).toBe('2026-11-04T00:00:00.000Z')
    expect(cell(r, 'eden')).toMatchObject({ state: 'present', source: 'mcp' })
    expect(cell(r, 'crack')).toMatchObject({ state: 'stale', source: 'site' })
    expect(cell(r, 'babe')).toMatchObject({ state: 'present', source: 'mcp' })
    expect(isStale(r.eden, cell(r, 'crack').work, [rec('eden', 'e', '2026-11-04T00:00:00Z')])).toBe(
      true
    )
  })

  it('한쪽이라도 모르면 낡음으로 보지 않는다', () => {
    const noEden = row(
      [w('eden', 'e', 'A'), w('crack', 'c', 'A', { updatedAt: '2026-11-01T00:00:00.000Z' })],
      [rec('crack', 'c', '2026-10-01T00:00:00.000Z')]
    )
    expect(noEden.edenChangedAt).toBeNull()
    expect(cell(noEden, 'crack').state).toBe('present')
    const noPort = row(
      [w('eden', 'e', 'A', { updatedAt: '2026-11-05T00:00:00.000Z' }), w('crack', 'c', 'A')],
      [rec('eden', 'e', '2026-11-06T00:00:00.000Z')]
    )
    expect(cell(noPort, 'crack')).toMatchObject({ state: 'present', changedAt: null, source: null })
    expect(hasFreshness([noEden, noPort])).toBe(false)
  })
})

describe('works_status 결과', () => {
  it('플랫폼별 등록·낡음·시각·출처를 저장된 자료만으로 만든다', () => {
    const out = worksStatusResult({
      works: data([
        {
          key: 'a',
          title: 'A',
          thumbnail: null,
          works: [
            w('eden', 'e', 'A', { updatedAt: '2026-11-05T00:00:00.000Z' }),
            w('crack', 'c', 'A')
          ]
        }
      ]),
      saved: [
        {
          site: 'crack',
          workId: 'c',
          title: 'A',
          lastSavedAt: '2026-11-01T00:00:00.000Z',
          lastTool: 'work_save'
        }
      ]
    }) as { count: number; groups: Record<string, unknown>[]; note: string }
    expect(out.count).toBe(1)
    expect(out.groups[0]).toEqual({
      title: 'A',
      eden_changed_at: '2026-11-05T00:00:00.000Z',
      platforms: {
        eden: {
          registered: true,
          work_id: 'e',
          stale: null,
          synced_at: '2026-11-05T00:00:00.000Z',
          source: 'site'
        },
        babe: { registered: false, work_id: null, stale: null, synced_at: null, source: null },
        crack: {
          registered: true,
          work_id: 'c',
          stale: true,
          synced_at: '2026-11-01T00:00:00.000Z',
          source: 'mcp'
        }
      }
    })
    expect(out.note).toContain('플랫폼에 묻지 않아요')
  })
  it('자료가 없으면 빈 목록', () => {
    expect(worksStatusResult({ works: null, saved: [] })).toMatchObject({ count: 0, groups: [] })
  })
})

describe('최근 작업', () => {
  const works = [w('eden', 'e1', '비 오는 날'), w('crack', 'c1', '비 오는 날')]
  it('작품 번호(같은 플랫폼) 또는 제목이 맞는 것 중 가장 최근', () => {
    const items = [
      act({ id: '1', at: '2026-11-01T00:00:00Z', workId: 'c1', site: 'crack' }),
      act({ id: '2', at: '2026-11-03T00:00:00Z', workTitle: '비 오는 날!' }),
      act({ id: '3', at: '2026-11-09T00:00:00Z', workId: 'c1', site: 'babe' }),
      act({ id: '4', at: '2026-11-10T00:00:00Z', workTitle: '다른 작품' })
    ]
    expect(latestActivity(works, '비 오는 날', items)?.id).toBe('2')
  })
  it('맞는 기록이 없으면 null', () => {
    expect(latestActivity(works, '비 오는 날', [act({ workTitle: '없음' })])).toBeNull()
  })
})

describe('상대 시각', () => {
  const now = Date.parse('2026-11-10T12:00:00Z')
  it('분·시간·일', () => {
    expect(agoText('2026-11-10T11:59:30Z', now)).toBe('방금')
    expect(agoText('2026-11-10T11:30:00Z', now)).toBe('30분 전')
    expect(agoText('2026-11-10T09:00:00Z', now)).toBe('3시간 전')
    expect(agoText('2026-11-08T12:00:00Z', now)).toBe('2일 전')
    expect(agoText(null, now)).toBe('')
  })
})

describe('묶음별 댓글 세기', () => {
  const groups = [
    {
      key: 'a',
      title: '비 오는 날',
      thumbnail: null,
      works: [w('eden', 'e1', '비 오는 날'), w('babe', 'b1', '비 오는 날.')]
    },
    { key: 'b', title: '생활비', thumbnail: null, works: [w('babe', 'b2', '생활비')] }
  ]
  it('플랫폼+작품 번호, 아니면 정리한 제목으로 붙이고 못 붙인 것은 버린다', () => {
    expect(
      countByGroup(groups, [
        { platform: 'babe', work: { id: 'b1', title: null } },
        { platform: 'eden', work: { id: 'zz', title: '비 오는  날' } },
        { platform: 'babe', work: { id: 'b2', title: '엉뚱한 제목' } },
        { platform: 'crack', work: { id: 'q', title: '모르는 작품' } },
        { platform: 'crack', work: null }
      ])
    ).toEqual({ a: 2, b: 1 })
  })
  it('같은 제목이 두 묶음에 있으면 제목으로는 붙이지 않는다', () => {
    const dup = [
      { key: 'a', title: '같은', thumbnail: null, works: [w('eden', 'e1', '같은')] },
      { key: 'b', title: '같은', thumbnail: null, works: [w('crack', 'c1', '같은')] }
    ]
    expect(countByGroup(dup, [{ platform: 'babe', work: { id: 'x', title: '같은' } }])).toEqual({})
  })
})
