import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEditionStore, editionChange } from '../src/main/mcp/editions'
import { createActivityLog, withActivity } from '../src/main/mcp/activity'
import type { ToolDef } from '../src/main/works/tools'
import type { McpActivity } from '../src/shared/types'

const dirs: string[] = []
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-editions-'))
  dirs.push(dir)
  return dir
}
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

function act(extra: Partial<McpActivity>): McpActivity {
  return {
    id: Math.random().toString(36),
    at: '2026-11-01T00:00:00.000Z',
    tool: 'work_save',
    kind: 'save',
    site: 'eden',
    workId: 'W1',
    workTitle: '비 오는 날',
    ok: true,
    verified: true,
    summary: '저장',
    error: null,
    ...extra
  }
}

describe('editionChange', () => {
  it('바꾸는 도구가 성공하면 save, 삭제 성공은 delete', () => {
    for (const tool of [
      'work_save',
      'edition_save',
      'work_create',
      'images_apply',
      'cover_apply',
      'canvas_apply'
    ])
      expect(editionChange(act({ tool })), tool).toBe('save')
    expect(editionChange(act({ tool: 'work_delete' }))).toBe('delete')
    expect(editionChange(act({ tool: 'work_save', verified: null }))).toBe('save')
  })
  it('실패, 확인 실패, 읽기·계획, 작품을 모르는 기록은 무시한다', () => {
    expect(editionChange(act({ ok: false }))).toBeNull()
    expect(editionChange(act({ verified: false }))).toBeNull()
    expect(editionChange(act({ tool: 'work_plan' }))).toBeNull()
    expect(editionChange(act({ tool: 'work_read' }))).toBeNull()
    expect(editionChange(act({ site: null }))).toBeNull()
    expect(editionChange(act({ workId: null }))).toBeNull()
    expect(editionChange(act({ tool: 'work_delete', ok: false }))).toBeNull()
  })
})

describe('createEditionStore', () => {
  it('저장 기록을 남기고, 다시 열어도 읽고, 삭제하면 지운다', async () => {
    const file = join(await tempDir(), 'mcp', 'editions.json')
    const store = createEditionStore({ file })
    store.apply(act({ at: '2026-11-01T00:00:00.000Z' }))
    store.apply(act({ at: '2026-11-02T00:00:00.000Z', tool: 'edition_save', workTitle: null }))
    store.apply(act({ site: 'crack', workId: 'C1', at: '2026-11-03T00:00:00.000Z' }))
    store.apply(act({ site: 'babe', workId: 'B1', ok: false }))
    expect(await store.list()).toEqual([
      {
        site: 'crack',
        workId: 'C1',
        title: '비 오는 날',
        lastSavedAt: '2026-11-03T00:00:00.000Z',
        lastTool: 'work_save'
      },
      {
        site: 'eden',
        workId: 'W1',
        title: '비 오는 날', // 제목을 모르는 기록은 이전 제목을 이어 쓴다
        lastSavedAt: '2026-11-02T00:00:00.000Z',
        lastTool: 'edition_save'
      }
    ])
    const saved = JSON.parse(await readFile(file, 'utf8')) as { records: unknown[] }
    expect(saved.records).toHaveLength(2)

    const again = createEditionStore({ file })
    expect((await again.list()).map((r) => r.workId)).toEqual(['C1', 'W1'])
    again.apply(act({ tool: 'work_delete', site: 'crack', workId: 'C1' }))
    expect((await again.list()).map((r) => r.workId)).toEqual(['W1'])
    await again.flush()
  })

  it('파일이 깨져 있어도 빈 목록으로 시작한다', async () => {
    const dir = await tempDir()
    const file = join(dir, 'editions.json')
    const { writeFile } = await import('node:fs/promises')
    await writeFile(file, '{broken')
    const store = createEditionStore({ file })
    expect(await store.list()).toEqual([])
  })

  it('도구 호출 기록 경로에 붙이면 사이트·작품 번호를 기록에서 이어 받는다', async () => {
    const dir = await tempDir()
    const store = createEditionStore({ file: join(dir, 'editions.json') })
    const log = createActivityLog({
      file: join(dir, 'activity.jsonl'),
      onAdd: (a) => store.apply(a),
      now: () => new Date('2026-11-05T00:00:00.000Z')
    })
    const tools: ToolDef[] = [
      {
        name: 'images_plan',
        description: '',
        inputSchema: {},
        run: async () => ({ plan_id: 'P1', site: 'eden', work_id: 'W9', title: '눈' })
      },
      {
        name: 'images_apply',
        description: '',
        inputSchema: {},
        run: async () => ({ ok: true, verified: true })
      }
    ]
    const [plan, apply] = withActivity(tools, log)
    await plan.run({ site: 'eden', work_id: 'W9' })
    await apply.run({ plan_id: 'P1' })
    expect(await store.list()).toEqual([
      {
        site: 'eden',
        workId: 'W9',
        title: '눈',
        lastSavedAt: '2026-11-05T00:00:00.000Z',
        lastTool: 'images_apply'
      }
    ])
    await log.flush()
  })
})
