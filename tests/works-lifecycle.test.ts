import { describe, expect, it } from 'vitest'
import { edenCreateBody, edenWorks } from '../src/main/works/eden'
import { babeWorks } from '../src/main/works/babe'
import { workWriteAllowed } from '../src/main/works/adapters'
import { createWorkTools, toolMessage } from '../src/main/works/tools'
import type { WorkFetch, WorkWrite } from '../src/main/works/types'

const O = 'https://www.eden-chat.com'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
type Obj = Record<string, unknown>

const ok = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })

/** 에덴 흉내: 만들기·통째 저장·삭제를 받는 작은 저장소 */
function eden(): {
  read: WorkFetch
  write: WorkWrite
  works: Map<string, { work: Obj; characters: Obj[] }>
  calls: string[]
} {
  const works = new Map<string, { work: Obj; characters: Obj[] }>()
  const calls: string[] = []
  const store = (id: string, sent: Obj): void => {
    const { characters, ...rest } = sent
    works.set(id, {
      work: { ...rest, id, updated_at: 'u' + calls.length },
      characters: (characters as Obj[]).map((c) => ({ ...c, images: undefined }))
    })
  }
  const read: WorkFetch = async (url) => {
    if (!edenWorks.readAllowed(url)) throw new Error('UNAPPROVED_READ_ROUTE')
    const m = url.match(/\/api\/works\/([0-9a-f-]{36})(\/characters)?(\/[0-9a-f-]{36}\/images)?$/)
    const found = m && works.get(m[1])
    if (!found) return new Response('{"error":"not found"}', { status: 404 })
    if (m[3]) return ok([])
    return ok(m[2] ? found.characters : found.work)
  }
  const write: WorkWrite = async (method, url, body) => {
    if (!edenWorks.writeAllowed!(method, url)) throw new Error('UNAPPROVED_WRITE_ROUTE')
    const path = new URL(url).pathname
    calls.push(method + ' ' + path)
    if (method === 'PUT' && path === '/api/works/new') {
      const id = '99999999-0000-4000-8000-00000000000' + works.size
      store(id, body as Obj)
      return ok({ success: true, work: { to_jsonb: { id } }, isNew: true })
    }
    const id = path.split('/').pop()!
    if (!works.has(id)) return new Response('{}', { status: 404 })
    if (method === 'DELETE') {
      expect(body).toBeUndefined()
      works.delete(id)
      return ok({ success: true })
    }
    store(id, body as Obj)
    return ok({ success: true, workId: id })
  }
  return { read, write, works, calls }
}

function tools(s: ReturnType<typeof eden>): (name: string, args?: Obj) => Promise<Obj> {
  const all = createWorkTools({
    reader: () => s.read,
    writer: () => s.write,
    snapshot: async () => 'C:/snap.json',
    readFile: async (path) => {
      if (path !== 'D:/work/main.md') throw new Error('ENOENT')
      return '파일에서 온 메인'
    }
  })
  return (name, args = {}) => all.find((t) => t.name === name)!.run(args) as Promise<Obj>
}

const DRAFT = {
  site: 'eden',
  title: '새 작품',
  main: '메인 프롬프트',
  adult: true,
  characters: [{ name: '주연', details: '주연 설정' }, { name: '조연' }],
  lorebook: [{ title: '로어', keys: '학교', content: '로어 본문' }],
  start_scenarios: [{ title: '기본', content: '시작 본문' }, { title: '둘째' }]
}

describe('허용 요청', () => {
  it('에덴: 통째 저장·삭제는 작품 주소, 새 작품은 /api/works/new 로만', () => {
    const W = O + '/api/works/11111111-2222-4333-8444-555555555555'
    expect(workWriteAllowed('eden', 'DELETE', W)).toBe(true)
    expect(workWriteAllowed('eden', 'PUT', O + '/api/works/new')).toBe(true)
    expect(workWriteAllowed('eden', 'POST', O + '/api/works')).toBe(false)
    expect(workWriteAllowed('eden', 'DELETE', O + '/api/works/new')).toBe(false)
    expect(workWriteAllowed('eden', 'DELETE', W + '/characters')).toBe(false)
    expect(workWriteAllowed('eden', 'DELETE', O + '/api/user/me')).toBe(false)
  })
  it('베이비챗: 삭제는 작품 주소 하나', () => {
    const B = 'https://api.babechatapi.com/ko/api/characters/'
    const W = B + '11111111-2222-4333-8444-555555555555'
    expect(workWriteAllowed('babe', 'DELETE', W)).toBe(true)
    expect(workWriteAllowed('babe', 'DELETE', W + '/edit')).toBe(false)
    expect(workWriteAllowed('babe', 'DELETE', B + 'edit/draft')).toBe(false)
    expect(babeWorks.visibilities).toEqual(['public', 'private'])
  })
})

describe('새 작품 만들기', () => {
  it('본문: 항상 비공개 임시저장, 캐릭터마다 새 번호, 첫 캐릭터·첫 시작 상황이 기본', () => {
    const body = edenCreateBody({
      title: '새 작품',
      main: '메인',
      adult: false,
      characters: [{ name: '주연' }, { name: '조연', details: '설정' }],
      startScenarios: [{ title: '기본' }, { title: '둘째', content: '본문' }]
    })
    expect(body).toMatchObject({
      title: '새 작품',
      scenario_settings: '메인',
      visibility: 'private',
      status: 'draft',
      is_nsfw: false,
      work_type: 'original',
      prompt_version: 'v1',
      lorebook: [],
      selected_scenario_id: 1
    })
    expect('cover_image_url' in body).toBe(false)
    const chars = body.characters as Obj[]
    expect(chars.map((c) => [c.character_name, c.is_main_character, c.character_order])).toEqual([
      ['주연', true, 0],
      ['조연', false, 1]
    ])
    expect(chars.every((c) => UUID.test(String(c.id)))).toBe(true)
    expect(chars[0].id).not.toBe(chars[1].id)
    expect((body.start_scenarios as Obj[]).map((s) => [s.id, s.title, s.isDefault])).toEqual([
      [1, '기본', true],
      [2, '둘째', false]
    ])
    // 시작 상황을 안 주면 빈 기본 하나를 둔다
    expect(
      edenCreateBody({ title: 'a', main: 'b', adult: false, characters: [{ name: 'c' }] })
        .start_scenarios
    ).toHaveLength(1)
  })

  it('빈 제목·빈 메인·캐릭터 없음은 만들지 않는다', () => {
    const base = { title: 'a', main: 'b', adult: false, characters: [{ name: 'c' }] }
    expect(() => edenCreateBody({ ...base, title: ' ' })).toThrow('EMPTY_FIELD')
    expect(() => edenCreateBody({ ...base, main: '' })).toThrow('EMPTY_FIELD')
    expect(() => edenCreateBody({ ...base, characters: [] })).toThrow('EMPTY_FIELD')
    expect(() =>
      edenCreateBody({
        ...base,
        lorebook: [
          {
            title: 'x',
            keys: '',
            content: 'y',
            mode: 'keyword',
            offKeys: [],
            turnRange: 5,
            offTurnRange: 5
          }
        ]
      })
    ).toThrow('BAD_LOREBOOK')
  })

  it('work_create → 공개 전환 → 삭제', async () => {
    const s = eden()
    const run = tools(s)
    const made = await run('work_create', DRAFT)
    expect(made).toMatchObject({
      created: true,
      title: '새 작품',
      visibility: 'private',
      status: 'draft',
      lorebook_count: 1,
      start_scenario_count: 2,
      characters: ['주연', '조연']
    })
    const id = String(made.id)
    expect(s.calls).toEqual(['PUT /api/works/new'])

    // 공개 전환은 계획 → 저장 순서를 그대로 탄다
    const plan = await run('work_plan', { site: 'eden', work_id: id, visibility: 'link' })
    expect(plan.changes).toEqual([
      {
        where: '공개 상태',
        kind: 'changed',
        preview: { before: 'private/draft', after: 'link/active' }
      }
    ])
    expect(await run('work_save', { plan_id: plan.plan_id })).toMatchObject({
      verified: true,
      visibility: 'link',
      status: 'active'
    })
    await expect(
      run('work_plan', { site: 'eden', work_id: id, visibility: 'everyone' })
    ).rejects.toThrow('BAD_VISIBILITY')
    // 비공개로 돌려도 게시 상태(status)는 건드리지 않는다
    const back = await run('work_plan', { site: 'eden', work_id: id, visibility: 'private' })
    expect((back.changes as { preview: Obj }[])[0].preview).toEqual({
      before: 'link/active',
      after: 'private/active'
    })

    // 삭제: 계획 → 제목 확인 → 삭제
    const del = await run('work_delete_plan', { site: 'eden', work_id: id })
    expect(del).toMatchObject({ title: '새 작품', character_count: 2, lorebook_count: 1 })
    expect(s.works.has(id)).toBe(true)
    await expect(run('work_delete', { plan_id: del.plan_id, title: '새작품' })).rejects.toThrow(
      'TITLE_MISMATCH'
    )
    expect(s.works.has(id)).toBe(true)
    const done = await run('work_delete', { plan_id: del.plan_id, title: '새 작품' })
    expect(done).toMatchObject({ deleted: true, verified: true, id, backup: 'C:/snap.json' })
    expect(s.works.has(id)).toBe(false)
    await expect(run('work_delete', { plan_id: del.plan_id, title: '새 작품' })).rejects.toThrow(
      'PLAN_NOT_FOUND'
    )
  })

  it('계획 뒤 제목이 바뀐 작품은 지우지 않는다', async () => {
    const s = eden()
    const run = tools(s)
    const id = String((await run('work_create', DRAFT)).id)
    const del = await run('work_delete_plan', { site: 'eden', work_id: id })
    s.works.get(id)!.work.title = '다른 제목'
    await expect(run('work_delete', { plan_id: del.plan_id, title: '새 작품' })).rejects.toThrow(
      'TITLE_MISMATCH'
    )
    expect(s.works.has(id)).toBe(true)
  })

  it('main_file로 긴 본문을 받고, 잘못된 입력은 플랫폼에 닿기 전에 막는다', async () => {
    const s = eden()
    const run = tools(s)
    const { main: _main, ...rest } = DRAFT
    void _main
    const made = await run('work_create', { ...rest, main_file: 'D:/work/main.md' })
    expect(made.main_length).toBe(9)
    await expect(run('work_create', { ...DRAFT, adult: 'yes' })).rejects.toThrow('BAD_CHANGES')
    await expect(run('work_create', { ...DRAFT, characters: [] })).rejects.toThrow('EMPTY_FIELD')
    await expect(run('work_create', { ...DRAFT, main_file: 'D:/x.md' })).rejects.toThrow(
      'BAD_CHANGES'
    )
    await expect(run('work_create', { ...DRAFT, site: 'babe' })).rejects.toThrow('NO_CREATE')
    expect(s.calls).toEqual(['PUT /api/works/new'])
    expect(toolMessage(new Error('CREATE_FAILED 400 bad'))).toContain('400')
  })
})
