import { describe, expect, it } from 'vitest'
import { elynWorks } from '../src/main/works/elyn'
import { elynJsonData } from '../src/main/works/elyn-core'
import type {
  LocalImage,
  WorkFetch,
  WorkIo,
  WorkRequest,
  WorkSend,
  WorkWrite
} from '../src/main/works/types'

// 가짜 응답 모양은 2026-11-10 엘린 편집기 코드에서 읽은 필드를 따른다
// (characterToFormSchema가 읽는 작품 필드, revisions/status의 snake_case 필드, 판 form은 편집기 폼 모양).
const W = '11111111-2222-4333-8444-555555555555'
const R1 = '99999999-2222-4333-8444-555555555555'
const API = 'https://api.elyn.ai/api/v1/characters/'
type Obj = Record<string, unknown>

const ok = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const image = (name: string, size = 10): LocalImage => ({
  name,
  type: 'image/webp',
  data: new Uint8Array(size)
})
const MAIN = '가'.repeat(60)

function character(): Obj {
  return {
    id: W,
    name: '시험 작품',
    imageUrl: 'https://cdn.elyn.ai/main.webp',
    creatorNotes: [{ locale: 'ko', content: '소개 글' }],
    tags: ['순애', '학원'],
    visibility: 'private',
    target: 'all',
    is_nsfw: false,
    isExclusive: false,
    exclusiveLockedUntil: null,
    assetData: {
      images: [
        {
          id: 'img-1',
          image_url: 'https://cdn.elyn.ai/a.webp',
          slug: 'smile',
          description: '웃음',
          visibility: 'public'
        },
        {
          id: 'img-2',
          image_url: 'https://cdn.elyn.ai/b.webp',
          slug: 'cry',
          description: '울음',
          visibility: 'partial'
        }
      ]
    },
    isPaug: false,
    description: MAIN,
    favoredModelId: null,
    firstMessage: [{ locale: 'ko', messages: ['첫 메시지', '둘째 메시지'] }],
    lorebook: {
      lores: [
        {
          name: '학교',
          content: '학교 설명',
          trigger_strings: ['학교', '교실'],
          scan_first_message: false,
          condition: 'on_match',
          scan_turns: 3,
          group: null,
          group_priority: 0,
          requires: []
        }
      ]
    },
    customScript: null,
    is_my_character: true,
    updatedAt: '2026-11-01T00:00:00Z'
  }
}

/** 엘린 흉내: 판 저장은 새 판을 만들고, 제출하면 그 판이 최근 판이 된다 */
function site(opts: { revision?: boolean; inReview?: boolean } = {}): {
  io: WorkIo
  read: WorkFetch
  write: WorkWrite
  send: WorkSend
  calls: string[]
  sent: WorkRequest[]
  written: Obj[]
  state: { form: Obj | null; version: number; character: Obj }
} {
  const calls: string[] = []
  const sent: WorkRequest[] = []
  const written: Obj[] = []
  const state = {
    character: character(),
    form: null as Obj | null,
    version: 0,
    pendingForm: null as Obj | null
  }
  if (opts.revision) {
    state.version = 4
    state.form = {
      name: '판 제목',
      imageUrl: 'https://cdn.elyn.ai/main.webp',
      creatorNotes: '판 소개',
      tags: '순애,학원',
      visibility: 'private',
      target: 'all',
      isNsfw: false,
      isExclusive: false,
      exclusiveLockedUntil: null,
      subImages: [
        {
          id: 'img-1',
          image_url: 'https://cdn.elyn.ai/a.webp',
          slug: 'smile',
          description: '웃음',
          visibility: 'public'
        }
      ],
      isPaug: false,
      description: MAIN + ' 판',
      favoredModelId: 'none',
      firstMessages: [{ message: '판 첫 메시지' }],
      lorebook: { lores: [] },
      customScriptData: { components: [{ name: 'App', code: 'x' }] },
      mainImage: null
    }
  }
  const revision = (): Obj => ({
    id: R1,
    character_id: W,
    status: 'approved',
    version_number: state.version,
    created_at: '2026-11-02T00:00:00Z',
    updated_at: '2026-11-02T00:00:00Z'
  })
  const read: WorkFetch = async (url) => {
    calls.push('GET ' + url)
    if (!elynWorks.readAllowed(url)) throw new Error('UNAPPROVED_READ_ROUTE ' + url)
    const u = new URL(url)
    if (u.pathname.endsWith('/mine')) {
      const page = Number(u.searchParams.get('page'))
      const rows = Array.from({ length: page === 1 ? 50 : 3 }, (_, i) => ({
        id: '00000000-0000-4000-8000-' + String(page * 100 + i).padStart(12, '0'),
        name: '작품 ' + page + '-' + i,
        visibility: 'public'
      }))
      return ok({ characters: rows, total: 53 })
    }
    if (u.pathname.endsWith('/revisions/status'))
      return ok({
        draft: null,
        in_review: opts.inReview ? revision() : null,
        latest_approved: state.form ? revision() : null,
        rejected: null,
        latest_revision: state.form ? revision() : null,
        active_revision_id: state.form ? R1 : null
      })
    if (u.pathname.includes('/revisions/'))
      return ok({ revision: revision(), form: structuredClone(state.form) })
    return ok({ characters: [state.character] })
  }
  const write: WorkWrite = async (method, url, body) => {
    calls.push(method + ' ' + url)
    if (!elynWorks.writeAllowed!(method, url)) throw new Error('UNAPPROVED_WRITE_ROUTE ' + url)
    written.push((body ?? {}) as Obj)
    if (url.endsWith('/submit')) {
      state.form = state.pendingForm
      state.version += 1
      return ok({ success: true })
    }
    return ok({ success: true })
  }
  const send: WorkSend = async (request) => {
    calls.push(request.method + ' ' + request.url + ' (form)')
    if (!elynWorks.sendRule!(request.method, request.url))
      throw new Error('UNAPPROVED ' + request.url)
    sent.push(request)
    const data = JSON.parse(
      (request.form!.find((f) => f.name === 'data') as { value: string }).value
    ) as Obj
    const files = request.form!.filter((f) => f.name === 'files')
    if (request.url.endsWith('/create/simple'))
      return ok({ character: { id: '22222222-2222-4333-8444-555555555555', name: data.name } })
    // 판 저장: 받은 data로 폼을 만든다 (새 파일은 주소를 지어 준다)
    let n = 0
    const assets = (data.assetData as { images: Obj[] }).images
    const newCount = assets.filter((a) => !a.id).length
    const mainFile = files.length > newCount
    if (mainFile) n++
    const old = state.form ?? { subImages: (state.character.assetData as { images: Obj[] }).images }
    const subImages = assets.map((a) => {
      if (a.id) return { ...(old.subImages as Obj[]).find((s) => s.id === a.id), ...a }
      n++
      return { ...a, id: 'new-' + n, image_url: 'https://cdn.elyn.ai/new-' + n + '.webp' }
    })
    state.pendingForm = {
      name: data.name,
      imageUrl: mainFile
        ? 'https://cdn.elyn.ai/main-new.webp'
        : (state.form?.imageUrl ?? state.character.imageUrl),
      creatorNotes: (data.creatorNotes as Obj[])[0].content,
      tags: (data.tags as string[]).join(','),
      visibility: data.visibility,
      target: data.target,
      isNsfw: data.isNsfw,
      isExclusive: data.isExclusive,
      exclusiveLockedUntil: null,
      subImages,
      isPaug: data.isPaug,
      description: data.description,
      favoredModelId: data.favoredModelId ?? 'none',
      firstMessages: ((data.firstMessages as Obj[])[0].messages as string[]).map((message) => ({
        message
      })),
      lorebook: data.lorebook,
      customScriptData: data.customScript
    }
    return ok({ revision: { ...revision(), id: R1, status: 'draft' }, form: state.pendingForm })
  }
  return { io: { read, write, send }, read, write, send, calls, sent, written, state }
}

describe('엘린 허용 주소', () => {
  it('편집기가 쓰는 주소·메서드만 허용한다', () => {
    const r = elynWorks.readAllowed
    expect(r(API + 'mine?page=1&limit=50')).toBe(true)
    expect(r(API + 'mine?page=1&limit=50&x=1')).toBe(false)
    expect(r(API + 'mine?page=1')).toBe(false)
    expect(r(API + W + '?minimal=false')).toBe(true)
    expect(r(API + W)).toBe(false)
    expect(r(API + W + '/revisions/status')).toBe(true)
    expect(r(API + W + '/revisions/' + R1)).toBe(true)
    expect(r(API + W + '/revisions/' + R1 + '?x=1')).toBe(false)
    expect(r(API + W + '/comments')).toBe(false)
    expect(r('https://api.seoul.elyn.ai/api/v1/characters/' + W + '?minimal=false')).toBe(false)
    expect(r('https://evil.ai/api/v1/characters/' + W + '?minimal=false')).toBe(false)

    const w = elynWorks.writeAllowed!
    expect(w('POST', API + W + '/revisions/' + R1 + '/submit')).toBe(true)
    expect(w('POST', API + W + '/revisions/12/submit')).toBe(true)
    expect(w('POST', API + W + '/revisions/../submit')).toBe(false)
    expect(w('DELETE', API + W)).toBe(true)
    expect(w('DELETE', API + W + '/revisions/' + R1)).toBe(false)
    expect(w('PUT', API + W)).toBe(false)
    expect(w('POST', API + W + '/draft')).toBe(false)
    expect(w('POST', API + W + '/copy')).toBe(false)

    const s = elynWorks.sendRule!
    expect(s('POST', API + W + '/draft')).toEqual({ auth: 'session', body: 'form' })
    expect(s('POST', API + 'create/simple')).toEqual({ auth: 'session', body: 'form' })
    expect(s('POST', API + W + '/draft?commit_message=x')).toBeNull()
    expect(s('PUT', API + W + '/draft')).toBeNull()
    expect(s('POST', API + W + '/gallery')).toBeNull()
  })
})

describe('엘린 읽기', () => {
  it('목록을 50개씩 끝까지 읽는다', async () => {
    const { read } = site()
    const works = await elynWorks.list(read)
    expect(works).toHaveLength(53)
    expect(works[0]).toMatchObject({ title: '작품 1-0', visibility: 'public' })
  })

  it('판이 없으면 작품 원본을 편집기 폼으로 옮겨 읽는다', async () => {
    const { read } = site()
    const body = elynWorks.normalize(await elynWorks.readRaw(read, W.toUpperCase()))
    expect(body.id).toBe(W)
    expect(body.fields).toEqual({ title: '시험 작품', description: '소개 글', main: MAIN })
    expect(body.visibility).toBe('private')
    expect(body.lorebook).toEqual([
      {
        title: '학교',
        keys: '학교, 교실',
        content: '학교 설명',
        mode: 'on_match',
        offKeys: [],
        turnRange: 3,
        offTurnRange: null
      }
    ])
    expect(body.startScenarios.map((s) => [s.content, s.isDefault])).toEqual([
      ['첫 메시지', true],
      ['둘째 메시지', false]
    ])
    expect(body.characters).toEqual([])
  })

  it('판이 있으면 편집기처럼 가장 최근 판의 폼을 연다', async () => {
    const { read, calls } = site({ revision: true })
    const raw = await elynWorks.readRaw(read, W)
    const body = elynWorks.normalize(raw)
    expect(calls).toContain('GET ' + API + W + '/revisions/' + R1)
    expect(body.title).toBe('판 제목')
    expect(body.updatedAt).toBe('v4 approved')
    expect(body.fields.main).toBe(MAIN + ' 판')
    expect(elynWorks.imageGroups!(raw)[0].images.map((i) => i.label)).toEqual(['대표', 'smile'])
  })

  it('남의 작품이면 읽지 않는다', async () => {
    const read: WorkFetch = async () =>
      ok({ characters: [{ ...character(), is_my_character: false }] })
    await expect(elynWorks.readRaw(read, W)).rejects.toThrow('NOT_MY_WORK')
    await expect(elynWorks.readRaw(read, 'abc')).rejects.toThrow('BAD_WORK_ID')
  })
})

describe('엘린 고치기', () => {
  it('글 칸·로어북·첫 메시지를 고치고 편집기 규칙으로 막는다', async () => {
    const { read } = site()
    const raw = await elynWorks.readRaw(read, W)
    const next = elynWorks.applyChanges!(raw, {
      fields: { title: '새 제목', description: '새 소개' },
      lorebookPatch: [{ index: 0, content: '고친 설명', mode: 'until_match', turnRange: 5 }],
      lorebookAdd: [
        {
          title: '집',
          keys: '집, 방',
          content: '집 설명',
          mode: null,
          offKeys: [],
          turnRange: null,
          offTurnRange: null
        }
      ],
      startScenarios: [{ index: 0, content: '고친 첫 메시지' }],
      startScenariosRemove: [1],
      startScenariosAdd: [{ content: '셋째' }]
    })
    const body = elynWorks.normalize(next)
    expect(body.fields.title).toBe('새 제목')
    expect(body.lorebook.map((l) => [l.title, l.mode, l.turnRange])).toEqual([
      ['학교', 'until_match', 5],
      ['집', 'on_match', 3]
    ])
    expect(body.startScenarios.map((s) => s.content)).toEqual(['고친 첫 메시지', '셋째'])
    // 원본은 그대로
    expect(elynWorks.normalize(raw).fields.title).toBe('시험 작품')

    const change = (c: Parameters<NonNullable<typeof elynWorks.applyChanges>>[1]): unknown =>
      elynWorks.applyChanges!(raw, c)
    expect(() => change({ fields: { main: '짧음' } })).toThrow('BAD_FIELD')
    expect(() => change({ fields: { title: '가'.repeat(21) } })).toThrow('BAD_FIELD')
    expect(() => change({ fields: { subtitle: 'x' } })).toThrow('BAD_FIELD')
    expect(() => change({ startScenariosRemove: [0] })).toThrow('KEEP_DEFAULT')
    expect(() => change({ startScenarios: [{ index: 0, title: '제목' }] })).toThrow('BAD_CHANGES')
    expect(() => change({ startScenariosAdd: [{ content: '' }] })).toThrow('BAD_START')
    expect(() => change({ lorebookPatch: [{ index: 0, offKeys: ['x'] }] })).toThrow('BAD_CHANGES')
    expect(() => change({ lorebookPatch: [{ index: 0, mode: 'keyword' }] })).toThrow('BAD_CHANGES')
    expect(() => change({ lorebookPatch: [{ index: 0, keys: '' }] })).toThrow('BAD_LOREBOOK')
    expect(() => change({ lorebookPatch: [{ index: 3, content: 'x' }] })).toThrow('BAD_INDEX')
    expect(() => change({ charactersAdd: [{ name: '둘째' }] })).toThrow('NO_CHARACTERS')
    expect(() => change({ visibility: 'link' })).toThrow('BAD_VISIBILITY')
  })

  it('공개 범위를 바꾸고, 잠긴 독점 작품은 막는다', async () => {
    const { read, state } = site()
    const raw = await elynWorks.readRaw(read, W)
    expect(
      elynWorks.normalize(elynWorks.applyChanges!(raw, { visibility: 'unlisted' })).visibility
    ).toBe('unlisted')
    state.character = {
      ...character(),
      visibility: 'public',
      isExclusive: true,
      exclusiveLockedUntil: '2999-01-01T00:00:00Z'
    }
    const locked = await elynWorks.readRaw(read, W)
    expect(() => elynWorks.applyChanges!(locked, { visibility: 'private' })).toThrow(
      'VISIBILITY_LOCKED'
    )
    state.character = {
      ...character(),
      visibility: 'public',
      isExclusive: true,
      exclusiveLockedUntil: '2000-01-01T00:00:00Z'
    }
    const open = elynWorks.applyChanges!(await elynWorks.readRaw(read, W), {
      visibility: 'private'
    }) as {
      form: Obj
    }
    expect(open.form).toMatchObject({ visibility: 'private', isExclusive: false })
  })

  it('저장은 판 저장(파일 묶음) → 제출 순서이고, 다시 읽으면 바뀐 값이 나온다', async () => {
    const s = site()
    const raw = await elynWorks.readRaw(s.read, W)
    const next = elynWorks.applyChanges!(raw, {
      fields: { title: '새 제목' },
      visibility: 'unlisted'
    })
    await elynWorks.save!(s.write, W, next, s.send)
    expect(s.calls.slice(-2)).toEqual([
      'POST ' + API + W + '/draft (form)',
      'POST ' + API + W + '/revisions/' + R1 + '/submit'
    ])
    const form = s.sent[0].form!
    expect(form.map((f) => f.name)).toEqual(['data'])
    const data = JSON.parse((form[0] as { value: string }).value) as Obj
    expect(data).toMatchObject({
      name: '새 제목',
      visibility: 'unlisted',
      tags: ['순애', '학원'],
      firstMessages: [{ locale: 'ko', messages: ['첫 메시지', '둘째 메시지'] }],
      creatorNotes: [{ locale: 'ko', content: '소개 글' }],
      nickname: null,
      favoredModelId: null,
      customScript: null
    })
    expect((data.assetData as Obj).images).toEqual([
      { id: 'img-1', slug: 'smile', description: '웃음', visibility: 'public' },
      { id: 'img-2', slug: 'cry', description: '울음', visibility: 'partial' }
    ])
    expect(s.written.at(-1)).toEqual({ visibility: 'unlisted', isExclusive: false })
    const after = elynWorks.normalize(await elynWorks.readRaw(s.read, W))
    expect(after.title).toBe('새 제목')
    expect(after.visibility).toBe('unlisted')
    expect(after.startScenarios.map((x) => x.content)).toEqual(['첫 메시지', '둘째 메시지'])
  })

  it('통로 묶음(io)으로 받아도 저장하고, send가 없으면 저장하지 않는다', async () => {
    const s = site({ revision: true })
    const raw = await elynWorks.readRaw(s.read, W)
    const next = elynWorks.applyChanges!(raw, { fields: { description: '바꾼 소개' } })
    await expect(elynWorks.save!(s.write, W, next)).rejects.toThrow('SAVE_NEEDS_SEND')
    const save = elynWorks.save as unknown as (
      w: WorkWrite,
      id: string,
      n: unknown,
      io: WorkIo
    ) => Promise<void>
    await save(s.write, W, next, s.io)
    const data = JSON.parse((s.sent[0].form!.at(-1) as { value: string }).value) as Obj
    // 판에 있던 JSX 스크립트를 편집기처럼 실어 보낸다
    expect(data.customScript).toEqual({
      version: 1,
      entryComponent: 'App',
      components: [{ name: 'App', code: 'x' }]
    })
    expect(elynWorks.normalize(await elynWorks.readRaw(s.read, W)).fields.description).toBe(
      '바꾼 소개'
    )
  })

  it('검수 중인 판이 있으면 저장하지 않는다', async () => {
    const s = site({ revision: true, inReview: true })
    const raw = await elynWorks.readRaw(s.read, W)
    const next = elynWorks.applyChanges!(raw, { fields: { description: 'x' } })
    await expect(elynWorks.save!(s.write, W, next, s.send)).rejects.toThrow('IN_REVIEW')
    expect(s.sent).toHaveLength(0)
  })

  it('작품 삭제는 DELETE 하나다', async () => {
    const s = site()
    await elynWorks.remove!(s.write, W)
    expect(s.calls).toEqual(['DELETE ' + API + W])
  })
})

describe('엘린 이미지', () => {
  it('대표 이미지는 0번이고 지울 수 없다', async () => {
    const { read } = site()
    const raw = await elynWorks.readRaw(read, W)
    const groups = elynWorks.imageGroups!(raw)
    expect(groups[0].images.map((i) => [i.label, i.isDefault])).toEqual([
      ['대표', true],
      ['smile', false],
      ['cry', false]
    ])
    const plan = elynWorks.planImages!
    expect(() => plan(raw, { remove: [0] })).toThrow('KEEP_MAIN_IMAGE')
    expect(() => plan(raw, { add: [{ file: image('a.gif') }] })).toThrow('BAD_IMAGE')
    expect(() => plan(raw, { add: [{ file: image('a.webp'), label: 'smile' }] })).toThrow(
      'BAD_IMAGE_LABEL'
    )
    expect(() => plan(raw, { add: [{ file: image('a.webp'), label: '한글' }] })).toThrow(
      'BAD_IMAGE_LABEL'
    )
    expect(() => plan(raw, { add: [{ file: image('a.webp'), isDefault: true }] })).toThrow(
      'BAD_CHANGES'
    )
    expect(() =>
      plan(raw, { add: Array.from({ length: 11 }, (_, i) => ({ file: image(i + '.webp') })) })
    ).toThrow('IMAGE_BATCH_LIMIT')
    expect(() => plan(raw, { order: [1, 0, 2] })).toThrow('BAD_INDEX')
    expect(() => plan(raw, {})).toThrow('NO_CHANGES')
    expect(plan(raw, { order: [0, 2, 1] })).toEqual([
      { action: 'order', detail: '갤러리 순서 → 0, 2, 1' }
    ])
  })

  it('대표 이미지 → 새 갤러리 순으로 파일을 실어 판 저장 한 번에 보낸다', async () => {
    const s = site()
    const raw = await elynWorks.readRaw(s.read, W)
    await elynWorks.applyImages!(s.io, W, raw, {
      main: image('main.webp'),
      add: [{ file: image('wink.png'), label: 'wink', visibility: 'private' }],
      remove: [1]
    })
    const form = s.sent[0].form!
    expect(form.map((f) => ('file' in f ? 'files:' + f.file.name : f.name))).toEqual([
      'files:main.webp',
      'files:wink.png',
      'data'
    ])
    const data = JSON.parse((form.at(-1) as { value: string }).value) as Obj
    expect((data.assetData as Obj).images).toEqual([
      { id: 'img-2', slug: 'cry', description: '울음', visibility: 'partial' },
      { id: null, slug: 'wink', description: 'wink', visibility: 'private' }
    ])
    const after = elynWorks.imageGroups!(await elynWorks.readRaw(s.read, W))[0].images
    expect(after.map((i) => i.label)).toEqual(['대표', 'cry', 'wink'])
    expect(after[0].url).toBe('https://cdn.elyn.ai/main-new.webp')
  })

  it('순서 바꾸기는 남은 갤러리 순서대로 보낸다', async () => {
    const s = site()
    const raw = await elynWorks.readRaw(s.read, W)
    await elynWorks.applyImages!(s.io, W, raw, { order: [0, 2, 1] })
    const data = JSON.parse((s.sent[0].form!.at(-1) as { value: string }).value) as Obj
    expect(((data.assetData as Obj).images as Obj[]).map((i) => i.id)).toEqual(['img-2', 'img-1'])
  })

  it('표지는 대표 이미지를 바꾸고 새 주소를 돌려준다', async () => {
    const s = site()
    const url = await elynWorks.uploadCover!(s.io, W, image('cover.webp'))
    expect(url).toBe('https://cdn.elyn.ai/main-new.webp')
    expect(elynWorks.coverUrl!(await elynWorks.readRaw(s.read, W))).toBe(url)
    await expect(elynWorks.uploadCover!(s.io, W, image('cover.webp'), 'en')).rejects.toThrow(
      'NO_EDITIONS'
    )
  })
})

describe('엘린 새 작품', () => {
  const draft = {
    title: '새 작품',
    main: MAIN,
    adult: false,
    description: '소개',
    hashtags: ['순애'],
    characters: [],
    startScenarios: [{ content: '첫 메시지' }],
    lorebook: [
      {
        title: '학교',
        keys: '학교',
        content: '설명',
        mode: null,
        offKeys: [],
        turnRange: null,
        offTurnRange: null
      }
    ]
  }

  it('대표 이미지를 맡겨 두었다가 만들기 요청에 같이 보낸다 (항상 비공개)', async () => {
    const s = site()
    const key = await elynWorks.uploadImage!(s.io, image('cover.webp'))
    expect(key).toMatch(/^elyn-pending:/)
    const create = elynWorks.create as unknown as (
      w: WorkWrite,
      d: typeof draft & { coverUrl: string },
      r: WorkFetch,
      send: WorkSend
    ) => Promise<string>
    const id = await create(s.write, { ...draft, coverUrl: key }, s.read, s.send)
    expect(id).toBe('22222222-2222-4333-8444-555555555555')
    const req = s.sent[0]
    expect(req.url).toBe(API + 'create/simple')
    expect(req.form!.map((f) => ('file' in f ? 'files:' + f.file.name : f.name))).toEqual([
      'files:cover.webp',
      'data'
    ])
    const data = JSON.parse((req.form![1] as { value: string }).value) as Obj
    expect(data).toMatchObject({
      name: '새 작품',
      visibility: 'private',
      isNsfw: false,
      firstMessages: [{ locale: 'ko', messages: ['첫 메시지'] }],
      assetData: { images: [] }
    })
    expect(((data.lorebook as Obj).lores as Obj[])[0]).toMatchObject({
      name: '학교',
      trigger_strings: ['학교'],
      condition: 'on_match',
      scan_turns: 3
    })
    // 맡긴 파일은 한 번만 쓴다
    await expect(create(s.write, { ...draft, coverUrl: key }, s.read, s.send)).rejects.toThrow(
      'COVER_REQUIRED'
    )
  })

  it('규격을 먼저 보고, send가 없으면 만들지 않는다', async () => {
    const s = site()
    expect(() => elynWorks.checkDraft!({ ...draft, main: '짧음' })).toThrow('BAD_FIELD')
    expect(() => elynWorks.checkDraft!({ ...draft, startScenarios: [] })).toThrow('START_LIMIT')
    expect(() => elynWorks.checkDraft!({ ...draft, characters: [{ name: 'x' }] })).toThrow(
      'NO_CHARACTERS'
    )
    expect(() => elynWorks.checkDraft!({ ...draft, options: { target: 'kids' } })).toThrow(
      'BAD_DRAFT'
    )
    elynWorks.checkDraft!(draft)
    await expect(elynWorks.create!(s.write, { ...draft, coverUrl: 'x' }, s.read)).rejects.toThrow(
      'CREATE_NEEDS_SEND'
    )
  })

  it('저장 본문 data는 편집기 buildJsonData 모양이다', () => {
    const data = elynJsonData(
      {
        name: 'n',
        description: 'd',
        visibility: 'public',
        isNsfw: true,
        isPaug: false,
        isExclusive: false,
        target: 'male',
        tags: ' a , ,b',
        firstMessages: [{ message: 'x' }, { message: '' }],
        creatorNotes: 'c',
        subImages: [{ id: '', slug: '', description: '', visibility: '' }],
        lorebook: { lores: [] },
        favoredModelId: 'm1',
        customScript: []
      },
      'en',
      'create'
    )
    expect(data).toEqual({
      name: 'n',
      description: 'd',
      visibility: 'public',
      isNsfw: true,
      isPaug: false,
      isExclusive: false,
      target: 'male',
      tags: ['a', 'b'],
      firstMessages: [{ locale: 'en', messages: ['x'] }],
      creatorNotes: [{ locale: 'en', content: 'c' }],
      nickname: null,
      assetData: { images: [{ slug: '', description: '', visibility: 'partial' }] },
      lorebook: { lores: [] },
      favoredModelId: 'm1',
      customScript: null
    })
  })
})
