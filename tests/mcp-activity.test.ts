import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  activityKind,
  createActivityLog,
  withActivity,
  type ActivityLog
} from '../src/main/mcp/activity'
import { createWorkTools, type ToolDef } from '../src/main/works/tools'
import type { McpActivity } from '../src/shared/types'

const dirs: string[] = []
async function tempFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-activity-'))
  dirs.push(dir)
  return join(dir, 'mcp', 'activity.jsonl')
}
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

const fail = (): never => {
  throw new Error('NOT_CALLED')
}
const TOOL_NAMES = createWorkTools({
  reader: fail,
  writer: fail,
  sender: fail,
  snapshot: fail,
  readFile: fail,
  readBinary: fail,
  listFolder: fail
}).map((t) => t.name)

const EXPECTED_KIND: Record<string, McpActivity['kind']> = {
  sites_list: 'read',
  works_list: 'read',
  work_read: 'read',
  lorebook_read: 'read',
  start_scenarios_read: 'read',
  characters_read: 'read',
  editions_list: 'read',
  edition_read: 'read',
  images_list: 'read',
  canvas_export: 'read',
  work_plan: 'plan',
  work_delete_plan: 'plan',
  edition_plan: 'plan',
  images_plan: 'plan',
  cover_plan: 'plan',
  canvas_plan: 'plan',
  work_save: 'save',
  edition_save: 'save',
  images_apply: 'save',
  cover_apply: 'save',
  canvas_apply: 'save',
  work_create: 'create',
  work_delete: 'delete'
}

describe('activityKind', () => {
  it('실제 도구 23개 전부를 알맞은 종류로 나눈다', () => {
    expect(TOOL_NAMES).toHaveLength(23)
    expect([...TOOL_NAMES].sort()).toEqual(Object.keys(EXPECTED_KIND).sort())
    for (const name of TOOL_NAMES) expect(activityKind(name), name).toBe(EXPECTED_KIND[name])
  })
  it('모르는 도구는 other', () => {
    expect(activityKind('echo')).toBe('other')
  })
})

describe('기록 한 줄 만들기', () => {
  let log: ActivityLog
  const added: McpActivity[] = []
  const make = async (): Promise<void> => {
    added.length = 0
    log = createActivityLog({ file: await tempFile(), onAdd: (a) => added.push(a) })
  }
  // 임시 폴더를 지우기 전에 밀린 쓰기를 끝낸다
  afterEach(() => log?.flush())

  it('읽기 결과의 개수로 요약하고 사이트 별칭은 id로 바꾼다', async () => {
    await make()
    const a = log.record(
      'lorebook_read',
      { site: '에덴', work_id: 'W1' },
      { entries: Array.from({ length: 34 }, () => ({ content: 'x' })) },
      undefined
    )!
    expect(a).toMatchObject({
      kind: 'read',
      site: 'eden',
      workId: 'W1',
      ok: true,
      verified: null,
      summary: '로어북 34개 읽음',
      error: null
    })
    expect(added).toHaveLength(1)
    const w = log.record(
      'work_read',
      { site: 'eden', work_id: 'W1', fields: ['main'] },
      { id: 'W1', title: '제목', content: { main: '본문' } },
      undefined
    )!
    expect(w.summary).toBe('작품 읽음 · 본문 1칸')
    expect(w.workTitle).toBe('제목')
    // 제목을 돌려주지 않는 도구도 앞서 본 제목을 쓴다
    const c = log.record(
      'characters_read',
      { site: 'eden', work_id: 'W1' },
      { characters: [{}, {}] },
      undefined
    )!
    expect(c.summary).toBe('캐릭터 2개 읽음')
    expect(c.workTitle).toBe('제목')
  })

  it('계획 → 저장: plan_id로 사이트·작품을 잇고 verified를 그대로 쓴다', async () => {
    await make()
    const plan = log.record(
      'work_plan',
      { site: 'eden', work_id: 'W2', fields: { main: 'x' } },
      { id: 'W2', title: '작품', plan_id: 'p1', changes: [{}, {}, {}] },
      undefined
    )!
    expect(plan).toMatchObject({ kind: 'plan', summary: '저장 계획 · 3곳 바뀜', workTitle: '작품' })
    const saved = log.record(
      'work_save',
      { plan_id: 'p1' },
      { saved: true, verified: true, mismatches: [], id: 'W2', title: '작품' },
      undefined
    )!
    expect(saved).toMatchObject({
      kind: 'save',
      site: 'eden',
      workId: 'W2',
      ok: true,
      verified: true,
      summary: '저장 · 확인됨'
    })
    const empty = log.record(
      'work_plan',
      { site: 'eden', work_id: 'W2' },
      { id: 'W2', title: '작품', changes: [], nothing_to_save: true },
      undefined
    )!
    expect(empty.summary).toBe('저장 계획 · 바뀔 곳 없음')
  })

  it('저장이 확인되지 않으면 verified false와 다른 곳 수', async () => {
    await make()
    const a = log.record(
      'work_save',
      { plan_id: 'zz' },
      { saved: true, verified: false, mismatches: [{}, {}], id: 'W3', title: 'T' },
      undefined
    )!
    expect(a).toMatchObject({ ok: true, verified: false, summary: '저장 · 확인 안 됨 (2곳 다름)' })
  })

  it('이미지 계획의 개수를 적용 기록에 잇는다', async () => {
    await make()
    log.record(
      'images_plan',
      { site: 'eden', work_id: 'W4', add: Array.from({ length: 12 }, () => ({ file: 'a.webp' })) },
      { plan_id: 'img1', changes: [] },
      undefined
    )
    const a = log.record(
      'images_apply',
      { plan_id: 'img1' },
      { applied: true, verified: true, mismatches: [], groups: [] },
      undefined
    )!
    expect(a).toMatchObject({
      kind: 'save',
      site: 'eden',
      workId: 'W4',
      verified: true,
      summary: '이미지 12장 올림 · 확인됨'
    })
  })

  it('표지·생성·삭제 요약', async () => {
    await make()
    expect(
      log.record(
        'cover_apply',
        { plan_id: 'c' },
        { uploaded: 2, verified: true, results: [] },
        undefined
      )!.summary
    ).toBe('표지 바꿈 · 2곳 · 확인됨')
    const created = log.record(
      'work_create',
      { site: 'babe', title: '새 작품', adult: false, main: '긴 본문' },
      { created: true, id: 'N1', title: '새 작품', lorebook_count: 3 },
      undefined
    )!
    expect(created).toMatchObject({ kind: 'create', workId: 'N1', summary: '새 작품 만듦' })
    const deleted = log.record(
      'work_delete',
      { plan_id: 'd', title: '새 작품' },
      { deleted: true, verified: true, id: 'N1', title: '새 작품' },
      undefined
    )!
    expect(deleted).toMatchObject({ kind: 'delete', summary: '작품 삭제 · 확인됨', workId: 'N1' })
  })

  it('던진 오류는 ok false와 짧은 메시지', async () => {
    await make()
    const a = log.record('work_save', { plan_id: 'x' }, undefined, new Error('PLAN_STALE'))!
    expect(a.ok).toBe(false)
    expect(a.verified).toBeNull()
    expect(a.summary).toBe('저장 실패')
    expect(a.error).toContain('계획')
    expect(a.error!.length).toBeLessThanOrEqual(200)
  })

  it('canvas_apply의 imported false는 실패로 남긴다', async () => {
    await make()
    const a = log.record(
      'canvas_apply',
      { plan_id: 'cv' },
      { imported: false, error: 'IMPORT_FAILED 500', canvas_changed: false },
      undefined
    )!
    expect(a).toMatchObject({
      ok: false,
      error: 'IMPORT_FAILED 500',
      summary: '캔버스 가져오기 실패'
    })
  })

  it('본문 글은 기록 파일에 들어가지 않는다', async () => {
    const file = await tempFile()
    const secret = '비밀본문'.repeat(200)
    const log2 = createActivityLog({ file })
    log2.record(
      'work_read',
      { site: 'eden', work_id: 'W9', fields: ['main'] },
      { id: 'W9', title: '제목', content: { main: secret }, prompt: secret },
      undefined
    )
    log2.record(
      'work_plan',
      { site: 'eden', work_id: 'W9', fields: { main: secret } },
      { id: 'W9', title: '제목', plan_id: 'q', changes: [{ before: secret, after: secret }] },
      undefined
    )
    log2.record('work_read', { site: 'eden', work_id: 'W9' }, undefined, new Error('x'.repeat(500)))
    await log2.flush()
    const text = await readFile(file, 'utf8')
    expect(text).not.toContain('비밀본문')
    for (const line of text.trim().split('\n')) {
      const a = JSON.parse(line) as McpActivity
      expect(a.summary.length).toBeLessThanOrEqual(60)
      expect((a.error ?? '').length).toBeLessThanOrEqual(200)
    }
  })
})

describe('기록 파일', () => {
  it('500개만 남기고, 600개를 넘으면 다시 쓴다', async () => {
    const file = await tempFile()
    const log = createActivityLog({ file })
    for (let i = 0; i < 650; i++)
      log.record('works_list', { site: 'eden' }, { count: i, works: [] }, undefined)
    await log.flush()
    const lines = (await readFile(file, 'utf8')).trim().split('\n')
    expect(lines.length).toBeLessThanOrEqual(600)
    expect(lines.length).toBeGreaterThanOrEqual(500)
    const items = await log.list(1000)
    expect(items).toHaveLength(500)
    expect(items[0].summary).toBe('작품 목록 649개 읽음') // 최근 것부터
    expect(items[499].summary).toBe('작품 목록 150개 읽음')

    // 다시 열면 파일에서 최근 500개를 읽는다
    const again = createActivityLog({ file })
    const loaded = await again.list(1000)
    expect(loaded).toHaveLength(500)
    expect(loaded[0].summary).toBe('작품 목록 649개 읽음')
  })

  it('깨진 마지막 줄을 건너뛰고 파일을 고쳐 쓴다', async () => {
    const file = await tempFile()
    const first = createActivityLog({ file })
    first.record('sites_list', {}, { sites: [{}, {}] }, undefined)
    first.record('works_list', { site: 'eden' }, { count: 4, works: [] }, undefined)
    await first.flush()
    await writeFile(file, (await readFile(file, 'utf8')) + '{"id":"broken","tool":"wor')
    const log = createActivityLog({ file })
    const items = await log.list()
    expect(items.map((a) => a.summary)).toEqual(['작품 목록 4개 읽음', '플랫폼 2곳 확인'])
    log.record('work_read', { site: 'eden', work_id: 'W' }, { id: 'W', title: 'T' }, undefined)
    await log.flush()
    const lines = (await readFile(file, 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(3)
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow()
  })

  it('파일을 쓸 수 없어도 도구 호출은 그대로 끝난다', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mcp-activity-'))
    dirs.push(dir)
    // 폴더 자리에 파일을 두어 mkdir/append가 실패하게 한다
    await writeFile(join(dir, 'blocked'), 'x')
    const log = createActivityLog({ file: join(dir, 'blocked', 'activity.jsonl') })
    const tools: ToolDef[] = [
      {
        name: 'works_list',
        description: '',
        inputSchema: {},
        run: async () => ({ count: 1, works: [] })
      },
      {
        name: 'work_read',
        description: '',
        inputSchema: {},
        run: async () => {
          throw new Error('WORK_NOT_FOUND')
        }
      }
    ]
    const wrapped = withActivity(tools, log)
    await expect(wrapped[0].run({ site: 'eden' })).resolves.toEqual({ count: 1, works: [] })
    await expect(wrapped[1].run({ site: 'eden', work_id: 'x' })).rejects.toThrow('WORK_NOT_FOUND')
    await log.flush()
    const items = await log.list()
    expect(items.map((a) => [a.tool, a.ok])).toEqual([
      ['work_read', false],
      ['works_list', true]
    ])
  })
})
