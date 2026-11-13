import { describe, expect, it } from 'vitest'
import type { LoreEntry } from '../src/main/works/types'
import { elynWorks } from '../src/main/works/elyn'
import { elynJsonData, list } from '../src/main/works/elyn-core'
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
    // 수정 시각은 목록과 같은 작품의 updatedAt이고, 판 번호·상태는 extras에 있다
    expect(body.updatedAt).toBe('2026-11-01T00:00:00Z')
    expect(body.extras).toMatchObject({ revision_version: 4, revision_status: 'approved' })
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

// 지어낸 값으로 만든 "바꾸려던 칸만 바뀌고 나머지는 원본 그대로" 시험
const loreOf = (name: string, over: Obj = {}): Obj => ({
  name,
  content: name + ' 설명',
  trigger_strings: [name],
  scan_first_message: false,
  condition: 'on_match',
  scan_turns: 3,
  group: null,
  group_priority: 0,
  requires: [],
  ...over
})
const loreInput = (title: string, keys: string, content: string): LoreEntry => ({
  title,
  keys,
  content,
  mode: null,
  offKeys: [],
  turnRange: null,
  offTurnRange: null
})
const loresOf = (next: unknown): Obj[] =>
  ((next as { form: Obj }).form.lorebook as { lores: Obj[] }).lores

describe('엘린 전체 교체 짝짓기', () => {
  it('제목이 같은 옛 항목의 숨은 설정만 물려받고, 짝 없는 새 항목은 기본값으로 시작한다', async () => {
    const s = site()
    s.state.character = {
      ...character(),
      lorebook: {
        lores: [
          loreOf('가', {
            condition: 'until_match',
            scan_turns: 7,
            scan_first_message: true,
            group: 'g1',
            group_priority: 2,
            requires: ['x']
          }),
          loreOf('나', { scan_turns: 9 })
        ]
      }
    }
    const raw = await elynWorks.readRaw(s.read, W)
    // 새 항목을 맨 앞에 끼우고 '가'를 뒤로 보낸다 (자리 번호로만 짝지으면 '새것'이 '가'의 설정을 가져간다)
    const next = elynWorks.applyChanges!(raw, {
      lorebook: [
        loreInput('새것', '새것', '새 설명'),
        loreInput('가', '가', '고친 설명'),
        loreInput('나', '나', '나 설명')
      ]
    })
    const lores = loresOf(next)
    expect(lores[0]).toEqual(loreOf('새것', { content: '새 설명' }))
    expect(lores[1]).toMatchObject({
      name: '가',
      content: '고친 설명',
      condition: 'until_match',
      scan_turns: 7,
      scan_first_message: true,
      group: 'g1',
      group_priority: 2,
      requires: ['x']
    })
    expect(lores[2]).toMatchObject({ name: '나', scan_turns: 9 })
  })

  it('쉼표가 든 키워드는 같은 글로 되돌려 보내면 쪼개지지 않는다', async () => {
    const s = site()
    s.state.character = {
      ...character(),
      lorebook: { lores: [loreOf('가', { trigger_strings: ['안녕, 세상', '교실 '] })] }
    }
    const raw = await elynWorks.readRaw(s.read, W)
    const body = elynWorks.normalize(raw)
    const next = elynWorks.applyChanges!(raw, {
      lorebook: [loreInput('가', body.lorebook[0].keys, '가 설명')]
    })
    expect(loresOf(next)[0].trigger_strings).toEqual(['안녕, 세상', '교실 '])
    // 키워드를 실제로 고치면 쉼표로 쪼갠다
    const edited = elynWorks.applyChanges!(raw, {
      lorebookPatch: [{ index: 0, keys: '하나, 둘' }]
    })
    expect(loresOf(edited)[0].trigger_strings).toEqual(['하나', '둘'])
  })

  const HIDDEN = {
    scan_first_message: true,
    group: 'g1',
    group_priority: 2,
    requires: ['x']
  }
  const hiddenBook = {
    lores: [loreOf('A'), loreOf('B'), loreOf('C', { ...HIDDEN, trigger_strings: ['씨', '시'] })]
  }

  it('같은 자리에 다른 항목으로 바꿔 넣으면 지워진 옛 항목의 숨은 설정을 물려받지 않는다', async () => {
    const s = site()
    s.state.character = { ...character(), lorebook: hiddenBook }
    const raw = await elynWorks.readRaw(s.read, W)
    // C를 지우고 전혀 다른 N을 같은 자리에
    const last = elynWorks.applyChanges!(raw, {
      lorebook: [loreInput('A', 'A', 'A 설명'), loreInput('B', 'B', 'B 설명'), loreInput('N', 'N', 'N 설명')]
    })
    expect(loresOf(last)[2]).toEqual(loreOf('N', { content: 'N 설명' }))
    // 가운데 B를 다른 항목 E로 바꾸고 C는 그대로
    const middle = elynWorks.applyChanges!(raw, {
      lorebook: [
        loreInput('A', 'A', 'A 설명'),
        loreInput('E', 'E', 'E 설명'),
        loreInput('C', '씨, 시', 'C 설명')
      ]
    })
    expect(loresOf(middle)[1]).toEqual(loreOf('E', { content: 'E 설명' }))
    expect(loresOf(middle)[2]).toMatchObject({ name: 'C', ...HIDDEN })
  })

  it('같은 자리에서 제목만 고친 항목은 숨은 설정을 지킨다 (키워드나 내용이 이어질 때)', async () => {
    const s = site()
    s.state.character = { ...character(), lorebook: hiddenBook }
    const raw = await elynWorks.readRaw(s.read, W)
    // 제목만 고침
    const renamed = elynWorks.applyChanges!(raw, {
      lorebook: [
        loreInput('A', 'A', 'A 설명'),
        loreInput('B', 'B', 'B 설명'),
        loreInput('새 이름', '씨, 시', 'C 설명')
      ]
    })
    expect(loresOf(renamed)[2]).toMatchObject({ name: '새 이름', ...HIDDEN })
    // 제목과 키워드를 고쳤지만 내용은 그대로
    const sameContent = elynWorks.applyChanges!(raw, {
      lorebook: [
        loreInput('A', 'A', 'A 설명'),
        loreInput('B', 'B', 'B 설명'),
        loreInput('새 이름', '다른 키', 'C 설명')
      ]
    })
    expect(loresOf(sameContent)[2]).toMatchObject({
      name: '새 이름',
      trigger_strings: ['다른 키'],
      ...HIDDEN
    })
  })

  it('전체 교체에서 keys를 안 주면 짝지은 옛 항목의 키워드를 그대로 둔다', async () => {
    const s = site()
    s.state.character = { ...character(), lorebook: hiddenBook }
    const raw = await elynWorks.readRaw(s.read, W)
    const noKeys = (title: string, content: string): unknown => ({
      ...loreInput(title, '', content),
      given: ['title', 'content']
    })
    const next = elynWorks.applyChanges!(raw, {
      lorebook: [
        noKeys('A', '고친 A') as never,
        noKeys('B', 'B 설명') as never,
        // 제목을 고쳤어도 keys를 안 줬으면 같은 항목이다
        noKeys('새 이름', '새 내용') as never
      ]
    })
    expect(loresOf(next)[0]).toMatchObject({ content: '고친 A', trigger_strings: ['A'] })
    expect(loresOf(next)[2]).toMatchObject({
      name: '새 이름',
      trigger_strings: ['씨', '시'],
      ...HIDDEN
    })
    // keys를 빈 글로 직접 줬으면(given에 있음) 비운다
    const wiped = elynWorks.applyChanges!(raw, {
      lorebook: [
        {
          ...loreInput('A', '', 'A 설명'),
          mode: 'until_match',
          given: ['title', 'keys', 'content', 'mode']
        } as never,
        loreInput('B', 'B', 'B 설명'),
        loreInput('C', '씨, 시', 'C 설명')
      ]
    })
    expect(loresOf(wiped)[0].trigger_strings).toEqual([])
  })
})

describe('엘린 손대지 않은 칸은 막지 않는다', () => {
  const LONG = '가'.repeat(2000)

  it('글 칸은 바뀐 칸만 검사한다', async () => {
    const s = site()
    s.state.character = { ...character(), name: '가'.repeat(25), description: '짧음' }
    const raw = await elynWorks.readRaw(s.read, W)
    const next = elynWorks.applyChanges!(raw, { fields: { description: '새 소개' } }) as {
      form: Obj
    }
    expect(next.form).toMatchObject({ name: '가'.repeat(25), description: '짧음' })
    // 같은 값을 다시 주는 것도 바뀐 것이 아니다
    expect(() => elynWorks.applyChanges!(raw, { fields: { title: '가'.repeat(25) } })).not.toThrow()
    expect(() => elynWorks.applyChanges!(raw, { fields: { title: '가'.repeat(26) } })).toThrow(
      'BAD_FIELD'
    )
    expect(() => elynWorks.applyChanges!(raw, { fields: { main: '여전히 짧음' } })).toThrow(
      'BAD_FIELD'
    )
  })

  it('로어북은 바뀌었거나 새로 더한 항목만 검사한다', async () => {
    const s = site()
    s.state.character = {
      ...character(),
      lorebook: { lores: [loreOf('긴것', { content: LONG }), loreOf('짧은것')] }
    }
    const raw = await elynWorks.readRaw(s.read, W)
    const change = (c: Parameters<NonNullable<typeof elynWorks.applyChanges>>[1]): unknown =>
      elynWorks.applyChanges!(raw, c)
    // 안 건드린 긴 항목 때문에 막히지 않는다
    expect(loresOf(change({ lorebookPatch: [{ index: 1, content: '고침' }] }))[0].content).toBe(LONG)
    expect(loresOf(change({ lorebookRemove: [1] }))).toHaveLength(1)
    expect(loresOf(change({ lorebookAdd: [loreInput('셋째', '셋째', '설명')] }))).toHaveLength(3)
    // 바꾸거나 새로 더한 항목은 그대로 검사한다
    expect(() => change({ lorebookPatch: [{ index: 0, keys: '하나' }] })).toThrow('BAD_LOREBOOK')
    expect(() => change({ lorebookAdd: [loreInput('넷째', '넷째', LONG)] })).toThrow('BAD_LOREBOOK')
    expect(() => change({ lorebookAdd: [loreInput('짧은것', '키', '설명')] })).toThrow(
      'BAD_LOREBOOK'
    )
    expect(() => change({ lorebookPatch: [{ index: 1, keys: '' }] })).toThrow('BAD_LOREBOOK')
  })

  it('옛 로어북에 이미 있던 중복 이름·초과 개수는 새로 늘지 않는 한 막지 않는다', async () => {
    const s = site()
    s.state.character = {
      ...character(),
      lorebook: {
        lores: Array.from({ length: 251 }, (_, i) =>
          loreOf(i < 2 ? '같은' : '항목' + i, { trigger_strings: ['키' + i] })
        )
      }
    }
    const raw = await elynWorks.readRaw(s.read, W)
    const change = (c: Parameters<NonNullable<typeof elynWorks.applyChanges>>[1]): unknown =>
      elynWorks.applyChanges!(raw, c)
    expect(loresOf(change({ lorebookPatch: [{ index: 0, content: '고침' }] }))).toHaveLength(251)
    expect(loresOf(change({ lorebookRemove: [5] }))).toHaveLength(250)
    expect(() => change({ lorebookAdd: [loreInput('새것', '새것', '설명')] })).toThrow(
      'LOREBOOK_LIMIT'
    )
    expect(() => change({ lorebookPatch: [{ index: 5, title: '같은' }] })).toThrow('BAD_LOREBOOK')
  })

  it('첫 메시지는 바뀌었거나 새로 더한 것만 검사한다', async () => {
    const s = site()
    s.state.character = {
      ...character(),
      firstMessage: [{ locale: 'ko', messages: ['가'.repeat(3000), '둘째 메시지'] }]
    }
    const raw = await elynWorks.readRaw(s.read, W)
    const change = (c: Parameters<NonNullable<typeof elynWorks.applyChanges>>[1]): unknown =>
      elynWorks.applyChanges!(raw, c)
    const starts = (next: unknown): string[] =>
      list((next as { form: Obj }).form.firstMessages).map((m) => String(m.message))
    expect(starts(change({ startScenarios: [{ index: 1, content: '고침' }] }))).toEqual([
      '가'.repeat(3000),
      '고침'
    ])
    expect(starts(change({ startScenariosAdd: [{ content: '셋째' }] }))).toHaveLength(3)
    expect(() => change({ startScenarios: [{ index: 0, content: '나'.repeat(3000) }] })).toThrow(
      'BAD_START'
    )
    expect(() => change({ startScenariosAdd: [{ content: '다'.repeat(3000) }] })).toThrow(
      'BAD_START'
    )
  })

  it('첫 메시지가 이미 10개를 넘는 작품은 고치거나 줄이는 저장을 막지 않고, 늘리는 저장만 막는다', async () => {
    const s = site()
    const many = Array.from({ length: 11 }, (_, i) => '메시지 ' + i)
    s.state.character = { ...character(), firstMessage: [{ locale: 'ko', messages: many }] }
    const raw = await elynWorks.readRaw(s.read, W)
    const change = (c: Parameters<NonNullable<typeof elynWorks.applyChanges>>[1]): unknown =>
      elynWorks.applyChanges!(raw, c)
    const count = (next: unknown): number =>
      list((next as { form: Obj }).form.firstMessages).length
    expect(count(change({ startScenarios: [{ index: 3, content: '고침' }] }))).toBe(11)
    expect(count(change({ startScenariosRemove: [5] }))).toBe(10)
    expect(() => change({ startScenariosAdd: [{ content: '열두째' }] })).toThrow('START_LIMIT')
    // 10개 이하 작품은 11개로 늘릴 수 없다
    const ten = Array.from({ length: 10 }, (_, i) => '메시지 ' + i)
    s.state.character = { ...character(), firstMessage: [{ locale: 'ko', messages: ten }] }
    const small = await elynWorks.readRaw(s.read, W)
    expect(() => elynWorks.applyChanges!(small, { startScenariosAdd: [{ content: '열한째' }] })).toThrow(
      'START_LIMIT'
    )
  })
})

describe('엘린 공개 범위를 모르면 저장하지 않는다', () => {
  it('판이 없는 작품에 공개 범위가 없으면 private으로 채우지 않고 멈춘다', async () => {
    const s = site()
    const c = character()
    delete c.visibility
    s.state.character = c
    const raw = await elynWorks.readRaw(s.read, W)
    expect(elynWorks.normalize(raw).visibility).toBeNull()
    // 계획 단계(applyChanges)에서 이미 멈춘다
    expect(() => elynWorks.applyChanges!(raw, { fields: { title: '새 제목' } })).toThrow(
      'BAD_VISIBILITY'
    )
    // 이미지 바꾸기는 applyChanges를 거치지 않으니 저장 쪽 검사가 막는다
    await expect(elynWorks.applyImages!(s.io, W, raw, { order: [0, 2, 1] })).rejects.toThrow(
      'BAD_VISIBILITY'
    )
    expect(s.sent).toHaveLength(0)
    expect(s.written).toHaveLength(0)
    // 공개 범위를 직접 주면 그 값으로 저장한다
    const set = elynWorks.applyChanges!(raw, { visibility: 'private' })
    await elynWorks.save!(s.write, W, set, s.send)
    expect(s.written.at(-1)).toEqual({ visibility: 'private', isExclusive: false })
  })

  it('판 폼의 공개 범위가 비어 있어도 public으로 제출하지 않는다', async () => {
    const s = site({ revision: true })
    s.state.form!.visibility = ''
    const raw = await elynWorks.readRaw(s.read, W)
    expect(() => elynWorks.applyChanges!(raw, { fields: { title: '새 제목' } })).toThrow(
      'BAD_VISIBILITY'
    )
    // 계획을 거치지 않고 비어 있는 원본을 바로 저장해도 요청이 나가지 않는다
    await expect(elynWorks.save!(s.write, W, raw, s.send)).rejects.toThrow('BAD_VISIBILITY')
    expect(s.sent).toHaveLength(0)
    expect(s.written).toHaveLength(0)
  })

  it('검수 중 검사가 공개 범위 검사보다 먼저다', async () => {
    const s = site({ revision: true, inReview: true })
    s.state.form!.visibility = ''
    const raw = await elynWorks.readRaw(s.read, W)
    await expect(elynWorks.save!(s.write, W, raw, s.send)).rejects.toThrow('IN_REVIEW')
    expect(s.sent).toHaveLength(0)
  })

  it('사이트가 준 모르는 공개 범위는 손대지 않은 값이라 그대로 보낸다', async () => {
    const s = site({ revision: true })
    s.state.form!.visibility = 'link'
    const raw = await elynWorks.readRaw(s.read, W)
    expect(elynWorks.normalize(raw).visibility).toBe('link')
    const next = elynWorks.applyChanges!(raw, { fields: { title: '새 제목' } })
    await elynWorks.save!(s.write, W, next, s.send)
    const data = JSON.parse((s.sent[0].form!.at(-1) as { value: string }).value) as Obj
    expect(data.visibility).toBe('link')
    expect(s.written.at(-1)).toEqual({ visibility: 'link', isExclusive: false })
    // 우리가 바꾸려는 값은 세 값만 받는다
    expect(() => elynWorks.applyChanges!(raw, { visibility: 'link2' })).toThrow('BAD_VISIBILITY')
  })
})

const FEATURE_KEYS = [
  'title',
  'description',
  'main_prompt',
  'first_message',
  'start_scenarios',
  'lorebook',
  'characters',
  'example_dialogue',
  'user_persona',
  'output_rules',
  'situation_images',
  'cover',
  'tags',
  'visibility',
  'create_work',
  'delete_work',
  'versioning_review',
  'language_editions',
  'bgm_voice',
  'jsx_html',
  'model_settings',
  'comments_stats'
]

describe('엘린 기능 표', () => {
  it('열쇠 22개를 모두 갖고, 안내 글은 40자 이내다', () => {
    const features = elynWorks.features!
    expect(Object.keys(features).sort()).toEqual([...FEATURE_KEYS].sort())
    for (const [key, f] of Object.entries(features)) {
      expect(f.note, key).toBeTruthy()
      expect(f.note!.length, key).toBeLessThanOrEqual(40)
    }
  })

  it('코드에 맞춘 값: 사이트에 없는 칸은 모두 no, 태그·모델은 읽기만 된다', () => {
    const f = elynWorks.features!
    for (const key of ['characters', 'example_dialogue', 'user_persona', 'output_rules', 'bgm_voice'])
      expect(f[key], key).toMatchObject({ site: 'no', read: 'no', write: 'no' })
    expect(f.tags).toMatchObject({ site: 'yes', read: 'yes', write: 'partial' })
    expect(f.model_settings).toMatchObject({ read: 'yes', write: 'no' })
    expect(f.jsx_html).toMatchObject({ read: 'partial', write: 'no' })
    // 로어북 항목별 첫 메시지 스캔·그룹·선행 조건은 읽지 못한다 (unsupported 와 같은 기준)
    expect(f.lorebook).toMatchObject({ read: 'partial' })
    expect(f.create_work).toMatchObject({ write: 'yes', verified: 'yes' })
  })
})

describe('엘린 extras·unsupported', () => {
  it('판이 없는 작품: 있는 칸만 싣고 작품 본문·표지 주소는 싣지 않는다', async () => {
    const { read } = site()
    const body = elynWorks.normalize(await elynWorks.readRaw(read, W))
    expect(body.extras).toEqual({
      tags: ['순애', '학원'],
      is_nsfw: false,
      target: 'all',
      is_paug: false,
      favored_model_id: 'none',
      is_exclusive: false,
      has_cover: true,
      gallery_image_count: 2,
      custom_script_component_count: 0,
      lorebook_scan_first_message_count: 0,
      lorebook_grouped_count: 0,
      lorebook_requires_count: 0,
      has_draft_revision: false,
      has_in_review_revision: false,
      has_rejected_revision: false,
      creator_notes_locales: ['ko'],
      first_message_locales: ['ko']
    })
    const dump = JSON.stringify(body.extras)
    for (const secret of [MAIN, '소개 글', '첫 메시지', 'cdn.elyn.ai', '학교 설명'])
      expect(dump).not.toContain(secret)
    expect(body.unsupported).toEqual([
      '로어북 항목별 첫 메시지 스캔·그룹·선행 조건',
      'JSX 스크립트 코드',
      '통계(좋아요·대화·댓글 수)'
    ])
  })

  it('판이 있는 작품: 판 번호·상태와 심사 칸을 싣는다', async () => {
    const { read } = site({ revision: true, inReview: true })
    const body = elynWorks.normalize(await elynWorks.readRaw(read, W))
    expect(body.extras).toMatchObject({
      tags: ['순애', '학원'],
      gallery_image_count: 1,
      custom_script_component_count: 1,
      revision_version: 4,
      revision_status: 'approved',
      has_in_review_revision: true,
      has_rejected_revision: false,
      latest_approved_version: 4
    })
  })

  it('작품 원본에 있는 설정(모델·독점·상태창 데이터·언어·로어북 숨은 칸)을 읽되 통계는 싣지 않는다', async () => {
    const s = site()
    const c = character()
    s.state.character = {
      ...c,
      favoredModelId: 'model-1',
      favoredModel: { id: 'model-1', name: '시험 모델', creditCost: 55 },
      isExclusive: true,
      exclusiveLockedUntil: '2027-01-01T00:00:00Z',
      isOfficialPartner: false,
      is_nsfw: true,
      target: 'male',
      createdAt: '2026-01-01T00:00:00Z',
      publicAt: '2026-01-02T00:00:00Z',
      statusData: { global_status: [{}, {}], character_status: [], user_status: [{}] },
      creatorNotes: [
        { locale: 'ko', content: '소개 글' },
        { locale: 'en', content: 'notes' }
      ],
      likeCount: 7312345,
      chatCount: 8123456,
      commentCount: 9234567,
      mostLikedComment: '댓글 본문',
      creator: 'someone',
      creator_id: 'creator-id',
      lorebook: {
        lores: [
          loreOf('가', { scan_first_message: true, group: 'g1', requires: ['x'] }),
          loreOf('나', { scan_first_message: true }),
          loreOf('다')
        ]
      }
    }
    const body = elynWorks.normalize(await elynWorks.readRaw(s.read, W))
    expect(body.extras).toMatchObject({
      is_nsfw: true,
      target: 'male',
      favored_model_id: 'model-1',
      favored_model_name: '시험 모델',
      is_exclusive: true,
      exclusive_locked_until: '2027-01-01T00:00:00Z',
      is_official_partner: false,
      created_at: '2026-01-01T00:00:00Z',
      public_at: '2026-01-02T00:00:00Z',
      status_data_global_count: 2,
      status_data_character_count: 0,
      status_data_user_count: 1,
      creator_notes_locales: ['ko', 'en'],
      lorebook_scan_first_message_count: 2,
      lorebook_grouped_count: 1,
      lorebook_requires_count: 1
    })
    const dump = JSON.stringify(body.extras)
    for (const banned of [
      '7312345',
      '8123456',
      '9234567',
      'like',
      'chat',
      'comment_count',
      '댓글 본문',
      'someone',
      'creator-id'
    ])
      expect(dump, banned).not.toContain(banned)
    expect(body.unsupported).toContain('다른 언어의 소개·첫 메시지')

    // 통계가 달라져도 본문 전체(계획 뒤 변화 검사가 굳히는 값)는 그대로다
    const first = JSON.stringify(body)
    s.state.character = { ...s.state.character, likeCount: 99, chatCount: 1, commentCount: 0 }
    expect(JSON.stringify(elynWorks.normalize(await elynWorks.readRaw(s.read, W)))).toBe(first)
  })

  it('긴 글·많은 목록은 개수로 줄이고, 값이 없는 칸은 싣지 않는다', async () => {
    const s = site()
    const many = Array.from({ length: 21 }, (_, i) => '태그' + i)
    s.state.character = { ...character(), tags: many, statusData: null }
    let body = elynWorks.normalize(await elynWorks.readRaw(s.read, W))
    expect(body.extras).toMatchObject({ tag_count: 21 })
    expect(body.extras).not.toHaveProperty('tags')
    expect(body.extras).not.toHaveProperty('status_data_global_count')
    expect(body.extras).not.toHaveProperty('created_at')
    expect(body.extras).not.toHaveProperty('favored_model_name')

    s.state.character = { ...character(), tags: ['가'.repeat(81)], favoredModelId: '나'.repeat(81) }
    body = elynWorks.normalize(await elynWorks.readRaw(s.read, W))
    expect(body.extras).toMatchObject({ tag_count: 1 })
    expect(body.extras).not.toHaveProperty('tags')
    expect(body.extras).not.toHaveProperty('favored_model_id')
  })
})

describe('엘린 수정 시각', () => {
  it('판이 있어도 목록과 같은 수정 시각을 읽고, 작품에 없으면 판의 시각을 쓴다', async () => {
    const s = site({ revision: true })
    const listed = elynWorks.normalize(await elynWorks.readRaw(s.read, W)).updatedAt
    expect(listed).toBe('2026-11-01T00:00:00Z')
    const bare = character()
    delete bare.updatedAt
    s.state.character = bare
    expect(elynWorks.normalize(await elynWorks.readRaw(s.read, W)).updatedAt).toBe(
      '2026-11-02T00:00:00Z'
    )
  })

  it('상태 칸은 그대로 비워 둔다 (판 상태는 extras에만)', async () => {
    const s = site({ revision: true })
    expect(elynWorks.normalize(await elynWorks.readRaw(s.read, W)).status).toBeNull()
  })
})

describe('엘린 로어북 전체 교체: 안 준 칸은 옛 항목 값을 둔다', () => {
  const oldBook = {
    lores: [loreOf('가', { condition: 'until_match', scan_turns: 7 }), loreOf('나', { scan_turns: 9 })]
  }
  const whole = (title: string, given: string[], over: Obj = {}): Obj => ({
    ...loreInput(title, title, title + ' 설명'),
    ...(given.length ? { given } : {}),
    ...over
  })

  it('given에 없는 mode·turnRange는 짝지은 옛 항목의 값을 둔다', async () => {
    const s = site()
    s.state.character = { ...character(), lorebook: oldBook }
    const raw = await elynWorks.readRaw(s.read, W)
    const next = elynWorks.applyChanges!(raw, {
      lorebook: [
        whole('가', ['title', 'keys', 'content']),
        whole('나', ['title', 'keys', 'content'])
      ] as never
    })
    expect(loresOf(next)[0]).toMatchObject({ condition: 'until_match', scan_turns: 7 })
    expect(loresOf(next)[1]).toMatchObject({ condition: 'on_match', scan_turns: 9 })
  })

  it('given에 있는 칸은 받은 값으로 바꾸고, 안 준 칸만 옛 값을 둔다', async () => {
    const s = site()
    s.state.character = { ...character(), lorebook: oldBook }
    const raw = await elynWorks.readRaw(s.read, W)
    const next = elynWorks.applyChanges!(raw, {
      lorebook: [
        whole('가', ['title', 'keys', 'content', 'mode'], { mode: 'on_match' }),
        whole('나', ['title', 'keys', 'content', 'turnRange'], { turnRange: 0 })
      ] as never
    })
    expect(loresOf(next)[0]).toMatchObject({ condition: 'on_match', scan_turns: 7 })
    expect(loresOf(next)[1]).toMatchObject({ condition: 'on_match', scan_turns: 0 })
  })

  it('짝 없는 새 항목은 given이 없어도 엘린 기본값으로 시작한다', async () => {
    const s = site()
    s.state.character = { ...character(), lorebook: oldBook }
    const raw = await elynWorks.readRaw(s.read, W)
    const next = elynWorks.applyChanges!(raw, {
      lorebook: [
        whole('가', ['title', 'keys', 'content']),
        whole('나', ['title', 'keys', 'content']),
        whole('새것', ['title', 'keys', 'content'])
      ] as never
    })
    expect(loresOf(next)[2]).toMatchObject({ condition: 'on_match', scan_turns: 3 })
  })
})
