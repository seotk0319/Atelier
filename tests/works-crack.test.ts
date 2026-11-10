import { describe, expect, it } from 'vitest'
import { crackDraftForm, crackWorks } from '../src/main/works/crack'
import { crackCreateBody, crackPatchBody } from '../src/main/works/crack-core'
import { imageSize } from '../src/main/works/crack-media'
import type {
  LocalImage,
  WorkChanges,
  WorkFetch,
  WorkIo,
  WorkRequest,
  WorkSend,
  WorkWrite
} from '../src/main/works/types'

// 가짜 응답 모양은 2026-11-10 크랙 편집기 코드에서 읽은 필드를 따른다
// (편집 데이터 → 폼 변환 z()가 읽는 필드, 응답 {result, data}, 목록 data.stories/nextCursor,
//  내 작품 관리 data.contents[{_id, sourceId, type}], 프로필 이미지 응답 data.url).
const W = 'a'.repeat(24)
const API = 'https://crack-api.wrtn.ai/crack-api'
type Obj = Record<string, unknown>

const ok = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(status < 400 ? { result: 'SUCCESS', data } : data), {
    status,
    headers: { 'content-type': 'application/json' }
  })

/** 가로·세로만 적힌 png 머리 */
function png(width: number, height: number): Uint8Array {
  const b = new Uint8Array(32)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const v = new DataView(b.buffer)
  v.setUint32(16, width)
  v.setUint32(20, height)
  return b
}
const image = (name: string, data = png(1080, 1620)): LocalImage => ({
  name,
  type: 'image/png',
  data
})

const school = { name: '학교', prompt: '학교 설명', keywords: ['학교', '교실'] }
function story(): Obj {
  return {
    _id: W,
    snapshotId: 'snap-1',
    updateInfo: { version: 3 },
    status: 'active',
    name: '시험 작품',
    simpleDescription: '한 줄 소개',
    detailDescription: '상세 설명',
    portraitImage: {
      origin: 'https://cdn.wrtn.ai/p/origin.png',
      w600: 'https://cdn.wrtn.ai/p/600.png'
    },
    promptTemplate: { template: 'custom', name: '제작자 커스텀 프롬프트' },
    storyDetails: '',
    customPrompt: '메인 프롬프트',
    chatExamples: [],
    visibility: 'private',
    isAdult: true,
    genreId: 'g1',
    target: 'male',
    chatType: 'roleplay',
    defaultCrackerModel: 'superchat',
    chatModelId: 'm1',
    tags: ['순애'],
    isCommentBlocked: false,
    situationImageVersion: 'v2',
    shortcutCommands: [{ shortcutId: 's1', name: '요약', description: '요약', prompt: '요약해' }],
    startingSets: [
      {
        _id: 'set0',
        baseSetId: 'base0',
        name: '기본 설정',
        initialMessages: ['첫 메시지'],
        situationPrompt: '시작 상황',
        replySuggestions: ['안녕'],
        playGuide: '',
        keywordBook: [school, { name: '비', prompt: '비 오는 날', keywords: ['비'] }],
        situationImages: [],
        parameters: [{ name: ' 호감 ', min: 0, max: 100, initialValue: 10, prompt: '호감도' }]
      },
      {
        _id: 'set1',
        baseSetId: 'base1',
        name: '둘째',
        initialMessages: ['둘째 메시지'],
        situationPrompt: '',
        replySuggestions: [],
        playGuide: '가이드',
        keywordBook: [school],
        situationImages: []
      }
    ]
  }
}

/** 크랙 흉내: PATCH 본문을 편집 데이터로 되돌려 둔다 */
function site(start: Obj = story()): {
  io: WorkIo
  read: WorkFetch
  write: WorkWrite
  send: WorkSend
  calls: string[]
  bodies: Obj[]
  sent: WorkRequest[]
  state: { story: Obj; contents: Obj[][] }
} {
  const calls: string[] = []
  const bodies: Obj[] = []
  const sent: WorkRequest[] = []
  const state = {
    story: start,
    contents: [
      [{ _id: 'c'.repeat(24), sourceId: 'd'.repeat(24), type: 'story' }],
      [{ _id: 'e'.repeat(24), sourceId: W, type: 'story' }]
    ]
  }
  let snap = 1
  const read: WorkFetch = async (url) => {
    calls.push('GET ' + url)
    if (!crackWorks.readAllowed(url)) throw new Error('UNAPPROVED_READ_ROUTE ' + url)
    if (url.includes('/content/me')) {
      const page = url.includes('cursor=') ? 1 : 0
      return ok({ contents: state.contents[page], nextCursor: page === 0 ? 'n1' : null })
    }
    if (url.endsWith('/stories/me/' + W)) return ok(state.story)
    return new Response('', { status: 404 })
  }
  const write: WorkWrite = async (method, url, body) => {
    calls.push(method + ' ' + url)
    if (!crackWorks.writeAllowed!(method, url)) throw new Error('UNAPPROVED_WRITE_ROUTE ' + url)
    bodies.push((body ?? {}) as Obj)
    if (url.endsWith('/temp-stories')) return ok('f'.repeat(24))
    if (url.endsWith('/stories/v2')) return ok({ _id: (body as Obj).storyId })
    if (url.endsWith('/stories/profile-image')) return ok({ url: '/p/new.png' })
    return ok({})
  }
  const send: WorkSend = async (request) => {
    calls.push(request.method + ' ' + request.url)
    if (!crackWorks.sendRule!(request.method, request.url))
      throw new Error('UNAPPROVED ' + request.url)
    sent.push(request)
    const b = request.json as Obj
    if (
      b.expectedBaseSnapshotId !== undefined &&
      b.expectedBaseSnapshotId !== state.story.snapshotId
    )
      return ok({ code: 'STALE_BASE_SNAPSHOT', message: '다른 기기' }, 422)
    snap++
    const s = state.story
    if (!('name' in b)) {
      state.story = { ...s, visibility: b.visibility, snapshotId: 'snap-' + snap }
      return ok(state.story)
    }
    state.story = {
      ...s,
      snapshotId: 'snap-' + snap,
      name: b.name,
      simpleDescription: b.simpleDescription,
      detailDescription: b.detailDescription,
      customPrompt: b.customPrompt,
      storyDetails: b.storyDetails,
      visibility: b.visibility,
      portraitImage: { origin: b.portraitImageUrl },
      startingSets: (b.startingSets as Obj[]).map((x, i) => ({
        ...x,
        _id: 'srv' + i,
        baseSetId: x.baseSetId ?? 'newbase' + i
      }))
    }
    return ok(state.story)
  }
  return { io: { read, write, send }, read, write, send, calls, bodies, sent, state }
}

async function saved(
  s: ReturnType<typeof site>,
  changes: WorkChanges
): Promise<{
  next: unknown
  body: Obj
}> {
  const raw = await crackWorks.readRaw(s.read, W)
  const next = crackWorks.applyChanges!(raw, changes)
  await crackWorks.save!(s.write, W, next, s.io)
  const after = crackWorks.normalize(await crackWorks.readRaw(s.read, W))
  // 저장 뒤 다시 읽은 값이 저장하려던 값과 같아야 한다 (verified. 시작 상황 번호는 서버가 새로 붙이고 비교하지 않는다)
  const plain = (b: ReturnType<typeof crackWorks.normalize>): unknown => ({
    ...b,
    startScenarios: b.startScenarios.map((x) => ({ ...x, id: null }))
  })
  expect(plain(after)).toEqual(plain(crackWorks.normalize(next)))
  return { next, body: s.sent[s.sent.length - 1].json as Obj }
}

describe('크랙 허용 주소', () => {
  it('편집기가 쓰는 주소·메서드만 허용한다', () => {
    const r = crackWorks.readAllowed
    expect(r(API + '/stories/me')).toBe(true)
    expect(r(API + '/stories/me?cursor=abc')).toBe(true)
    expect(r(API + '/stories/me?cursor=abc&x=1')).toBe(false)
    expect(r(API + '/stories/me/' + W)).toBe(true)
    expect(r(API + '/stories/me/' + W + '?cursor=1')).toBe(false)
    expect(r(API + '/stories/me/' + W.toUpperCase())).toBe(false)
    expect(r(API + '/stories/' + W)).toBe(false)
    expect(r(API + '/content/me?limit=20&type=story')).toBe(true)
    expect(r(API + '/content/me?limit=20&type=story&cursor=x')).toBe(true)
    expect(r(API + '/content/me?limit=20&type=character')).toBe(false)
    expect(r('https://crack.wrtn.ai/crack-api/stories/me')).toBe(false)

    const w = crackWorks.writeAllowed!
    expect(w('POST', API + '/stories/v2')).toBe(true)
    expect(w('POST', API + '/temp-stories')).toBe(true)
    expect(w('POST', API + '/stories/profile-image')).toBe(true)
    expect(w('POST', API + '/stories/situation-image')).toBe(false)
    expect(w('DELETE', API + '/content/' + W)).toBe(true)
    expect(w('DELETE', API + '/temp-stories/' + W)).toBe(true)
    expect(w('DELETE', API + '/stories/' + W)).toBe(false)
    expect(w('PUT', API + '/stories/' + W + '/v2')).toBe(false)
    expect(w('PATCH', API + '/stories/' + W + '/v2')).toBe(false)

    const s = crackWorks.sendRule!
    expect(s('PATCH', API + '/stories/' + W + '/v2')).toEqual({ auth: 'session', body: 'json' })
    expect(s('PATCH', API + '/stories/' + W + '/v2?x=1')).toBeNull()
    expect(s('PATCH', API + '/characters/' + W + '/visibility')).toBeNull()
    expect(s('POST', API + '/stories/' + W + '/v2')).toBeNull()
  })
})

describe('크랙 읽기', () => {
  it('목록을 커서로 끝까지 읽고 번호 중복·지운 작품을 뺀다', async () => {
    const b = 'b'.repeat(24)
    const urls: string[] = []
    const read: WorkFetch = async (url) => {
      urls.push(url)
      expect(crackWorks.readAllowed(url)).toBe(true)
      if (!url.includes('cursor'))
        return ok({
          stories: [
            {
              _id: W,
              name: '하나',
              visibility: 'linkonly',
              status: 'active',
              createdAt: '2026-01-01'
            },
            { _id: b, name: '지움', visibility: 'private', status: 'deleted' }
          ],
          nextCursor: 'c1'
        })
      return ok({
        stories: [{ _id: W, name: '하나(중복)', visibility: 'public' }],
        nextCursor: null
      })
    }
    const works = await crackWorks.list(read)
    expect(urls).toEqual([API + '/stories/me', API + '/stories/me?cursor=c1'])
    expect(works).toEqual([
      {
        id: W,
        title: '하나',
        visibility: 'link',
        status: 'active',
        updatedAt: '2026-01-01',
        characters: null
      }
    ])
  })

  it('편집 데이터를 공통 모양으로 읽는다 (키워드북은 편집기처럼 모은다)', async () => {
    const s = site()
    const body = crackWorks.normalize(await crackWorks.readRaw(s.read, W))
    expect(body.updatedAt).toBe('v3')
    expect(body.fields).toEqual({
      title: '시험 작품',
      subtitle: '한 줄 소개',
      description: '상세 설명',
      main: '메인 프롬프트'
    })
    expect(body.lorebook.map((e) => [e.title, e.keys, e.content])).toEqual([
      ['학교', '학교, 교실', '학교 설명'],
      ['비', '비', '비 오는 날']
    ])
    expect(body.lorebook[0]).toMatchObject({ mode: null, offKeys: [], turnRange: null })
    expect(body.startScenarios).toEqual([
      {
        id: 'base0',
        title: '기본 설정',
        isDefault: true,
        content: '첫 메시지',
        subPrompt: '',
        dialogue: '',
        situation: '시작 상황',
        description: ''
      },
      {
        id: 'base1',
        title: '둘째',
        isDefault: false,
        content: '둘째 메시지',
        subPrompt: '',
        dialogue: '',
        situation: '',
        description: '가이드'
      }
    ])
    expect(body.characters).toEqual([])
    expect(crackWorks.coverUrl!(await crackWorks.readRaw(s.read, W))).toBe(
      'https://cdn.wrtn.ai/p/origin.png'
    )
  })

  it('템플릿이 custom이 아니면 main은 스토리 설정이다', async () => {
    const s = site({ ...story(), promptTemplate: 'default', storyDetails: '스토리 설정' })
    const body = crackWorks.normalize(await crackWorks.readRaw(s.read, W))
    expect(body.fields.main).toBe('스토리 설정')
  })

  it('지운 작품은 없는 작품이다', async () => {
    const s = site({ ...story(), status: 'deleted' })
    await expect(crackWorks.readRaw(s.read, W)).rejects.toThrow('WORK_NOT_FOUND')
  })
})

describe('크랙 저장', () => {
  it('글 칸·로어북을 고쳐 편집기 수정 등록 본문으로 보낸다', async () => {
    const s = site()
    const { body } = await saved(s, {
      fields: { main: '새 메인', subtitle: '새 소개' },
      lorebookPatch: [{ index: 0, content: '학교 새 설명' }],
      lorebookAdd: [
        {
          title: '밤',
          keys: '밤, 야간',
          content: '밤 설명',
          mode: null,
          offKeys: [],
          turnRange: null,
          offTurnRange: null
        }
      ]
    })
    expect(s.calls).toContain('PATCH ' + API + '/stories/' + W + '/v2')
    expect(body.expectedBaseSnapshotId).toBe('snap-1')
    expect(body.customPrompt).toBe('새 메인')
    expect(body.simpleDescription).toBe('새 소개')
    expect(body.promptTemplate).toBe('custom')
    expect(body.defaultCrackerModel).toBe('superchat_2_0')
    expect(body.tags).toEqual(['순애'])
    expect(body.isAdult).toBeUndefined()
    expect(body.releaseNote).toBeUndefined()
    // 비공개 작품은 공개 방식 선언을 보내지 않는다
    expect('publishDeclaration' in body && body.publishDeclaration !== undefined).toBe(false)
    const sets = body.startingSets as Obj[]
    expect(sets.map((x) => x.baseSetId)).toEqual(['base0', 'base1'])
    // 두 시작 설정에 같이 있던 노트는 둘 다 고쳐지고, 새 노트는 모든 시작 설정에 붙는다
    expect(sets[0].keywordBook).toEqual([
      { name: '학교', prompt: '학교 새 설명', keywords: ['학교', '교실'] },
      { name: '비', prompt: '비 오는 날', keywords: ['비'] },
      { name: '밤', prompt: '밤 설명', keywords: ['밤', '야간'] }
    ])
    expect(sets[1].keywordBook).toEqual([
      { name: '학교', prompt: '학교 새 설명', keywords: ['학교', '교실'] },
      { name: '밤', prompt: '밤 설명', keywords: ['밤', '야간'] }
    ])
    expect(sets[0].replySuggestions).toEqual(['안녕'])
    expect(sets[1].situationPrompt).toBe('')
    expect((sets[0].parameters as Obj[])[0].name).toBe('호감')
    expect(sets[0].situationImages).toEqual([])
    expect((body.shortcutCommands as Obj[])[0]).toMatchObject({ shortcutId: 's1', name: '요약' })
  })

  it('로어북 지우기·시작 상황 추가·삭제', async () => {
    const s = site()
    const { body } = await saved(s, {
      lorebookRemove: [1],
      startScenariosRemove: [1],
      startScenariosAdd: [
        { title: '셋째', content: '셋째 메시지', situation: '밤', description: '안내' }
      ]
    })
    const sets = body.startingSets as Obj[]
    expect(sets.map((x) => x.name)).toEqual(['기본 설정', '셋째'])
    expect(sets[1]).toMatchObject({
      baseSetId: undefined,
      initialMessages: ['셋째 메시지'],
      situationPrompt: '밤',
      playGuide: '안내',
      keywordBook: []
    })
    expect(sets[0].keywordBook).toEqual([school])
  })

  it('편집기에 없는 값과 지울 수 없는 것은 막는다', async () => {
    const s = site()
    const raw = await crackWorks.readRaw(s.read, W)
    const apply = (c: WorkChanges): unknown => crackWorks.applyChanges!(raw, c)
    expect(() => apply({ startScenariosRemove: [0] })).toThrow('KEEP_DEFAULT')
    expect(() => apply({ startScenarios: [{ index: 0, subPrompt: 'x' }] })).toThrow('BAD_CHANGES')
    expect(() => apply({ lorebookPatch: [{ index: 0, mode: 'always' }] })).toThrow('BAD_CHANGES')
    expect(() => apply({ lorebookPatch: [{ index: 0, offKeys: ['x'] }] })).toThrow('BAD_CHANGES')
    expect(() => apply({ lorebookPatch: [{ index: 0, keys: 'a,b,c,d,e,f' }] })).toThrow(
      'BAD_LOREBOOK'
    )
    expect(() => apply({ lorebookPatch: [{ index: 0, content: 'x'.repeat(401) }] })).toThrow(
      'BAD_LOREBOOK'
    )
    expect(() =>
      apply({ startScenarios: [{ index: 0, title: '열세 글자가 넘는 시작 설정' }] })
    ).toThrow('BAD_START')
    expect(() => apply({ fields: { main: 'x'.repeat(7001) } })).toThrow('BAD_FIELD main')
    expect(() => apply({ fields: { creator_comment: 'x' } })).toThrow('BAD_FIELD')
    expect(() => apply({ charactersAdd: [{ name: 'x' }] })).toThrow('NO_CHARACTERS')
    expect(() => apply({ visibility: 'unlisted' })).toThrow('BAD_VISIBILITY')
    expect(() => apply({ lorebookPatch: [{ index: 9, title: 'x' }] })).toThrow('BAD_INDEX')
  })

  it('공개 상태만 바꾸면 내 작품 메뉴와 같은 짧은 본문을 보낸다', async () => {
    const s = site()
    const { body } = await saved(s, { visibility: 'link' })
    expect(body).toEqual({ visibility: 'linkonly', publishDeclaration: {} })
    const s2 = site({ ...story(), visibility: 'public' })
    const r2 = await saved(s2, { visibility: 'private' })
    expect(r2.body).toEqual({ visibility: 'private' })
  })

  it('상황 이미지가 있으면 공개할 때 실패 정책을 같이 보낸다', async () => {
    const st = story()
    ;(st.startingSets as Obj[])[0].situationImages = [
      { _id: 'i1', category: '기본', situation: '웃음', imageUrl: 'https://cdn.wrtn.ai/s/1.png' }
    ]
    const s = site(st)
    const { body } = await saved(s, { visibility: 'public', fields: { title: '공개 작품' } })
    expect(body.publishDeclaration).toEqual({ failurePolicy: 'do_not_publish' })
    expect(body.visibility).toBe('public')
    expect(((body.startingSets as Obj[])[0].situationImages as Obj[])[0]).toMatchObject({
      category: '기본',
      situation: '웃음',
      keyword: ''
    })
    const groups = crackWorks.imageGroups!(await crackWorks.readRaw(s.read, W))
    expect(groups[0].images[1]).toMatchObject({ label: '기본::웃음', isDefault: false })
  })

  it('다른 곳에서 먼저 등록돼 기준이 바뀌면 PLAN_STALE', async () => {
    const s = site()
    const raw = await crackWorks.readRaw(s.read, W)
    s.state.story = { ...s.state.story, snapshotId: 'other' }
    const next = crackWorks.applyChanges!(raw, { fields: { title: '바뀐 제목' } })
    await expect(crackWorks.save!(s.write, W, next, s.io)).rejects.toThrow('PLAN_STALE')
  })

  it('send 통로가 없으면 저장하지 않는다', async () => {
    const s = site()
    const raw = await crackWorks.readRaw(s.read, W)
    const next = crackWorks.applyChanges!(raw, { fields: { title: '바뀐 제목' } })
    await expect(crackWorks.save!(s.write, W, next)).rejects.toThrow('SAVE_NEEDS_SEND')
  })

  it('수정 등록 본문은 편집 데이터만으로 다시 만들 수 있다', () => {
    const body = crackPatchBody(story())
    expect(Object.keys(body)).toContain('creatorRecommendedMaxOutput')
    expect(body.creatorRecommendedMaxOutput).toEqual({ type: 'TOTAL', totalMultiplier: 'default' })
    expect(body.chatExamples).toEqual([])
  })
})

describe('크랙 작품 삭제', () => {
  it('내 작품 관리 목록에서 콘텐츠 번호를 찾아 지운다', async () => {
    const s = site()
    await crackWorks.remove!(s.write, W, s.io)
    expect(s.calls).toEqual([
      'GET ' + API + '/content/me?limit=20&type=story',
      'GET ' + API + '/content/me?limit=20&type=story&cursor=n1',
      'DELETE ' + API + '/content/' + 'e'.repeat(24)
    ])
  })
  it('목록에 없으면 지우지 않는다', async () => {
    const s = site()
    s.state.contents = [[], []]
    await expect(crackWorks.remove!(s.write, W, s.io)).rejects.toThrow('WORK_NOT_FOUND')
    expect(s.calls.some((c) => c.startsWith('DELETE'))).toBe(false)
  })
})

describe('크랙 새 작품', () => {
  const options = {
    genre_id: 'g1',
    target: 'male',
    chat_type: 'roleplay',
    chat_model_id: 'm1',
    default_cracker_model: 'superchat_2_0'
  }
  const draft = {
    title: '새 작품',
    main: '메인',
    adult: false,
    subtitle: '소개',
    description: '상세',
    hashtags: ['순애'],
    characters: [],
    startScenarios: [{ content: '첫 메시지' }, { title: '둘째', content: '둘째 메시지' }],
    lorebook: [
      {
        title: '학교',
        keys: '학교',
        content: '학교 설명',
        mode: null,
        offKeys: [],
        turnRange: null,
        offTurnRange: null
      }
    ],
    options
  }

  it('번호를 받아 비공개로 등록한다', async () => {
    const s = site()
    const id = await crackWorks.create!(s.write, {
      ...draft,
      coverUrl: 'https://cdn.wrtn.ai/p/c.png'
    })
    expect(id).toBe('f'.repeat(24))
    expect(s.calls).toEqual(['POST ' + API + '/temp-stories', 'POST ' + API + '/stories/v2'])
    const body = s.bodies[1]
    expect(body).toMatchObject({
      storyId: 'f'.repeat(24),
      name: '새 작품',
      simpleDescription: '소개',
      detailDescription: '상세',
      promptTemplate: 'custom',
      customPrompt: '메인',
      visibility: 'private',
      isAdult: false,
      genreId: 'g1',
      chatModelId: 'm1',
      portraitImageUrl: 'https://cdn.wrtn.ai/p/c.png',
      tags: ['순애']
    })
    expect(body.publishDeclaration).toBeUndefined()
    expect(body._keywordBook).toBeUndefined()
    const sets = body.startingSets as Obj[]
    expect(sets.map((x) => x.name)).toEqual(['기본 설정', '둘째'])
    expect(sets[1].keywordBook).toEqual([{ name: '학교', prompt: '학교 설명', keywords: ['학교'] }])
    expect(sets[0].situationPrompt).toBeUndefined()
  })

  it('등록이 실패하면 받은 번호를 지운다', async () => {
    const s = site()
    const write: WorkWrite = async (method, url, body) => {
      if (url.endsWith('/stories/v2')) {
        s.calls.push(method + ' ' + url)
        return ok({ code: 'INVALID', message: '장르' }, 400)
      }
      return s.write(method, url, body)
    }
    await expect(
      crackWorks.create!(write, { ...draft, coverUrl: 'https://cdn.wrtn.ai/p/c.png' })
    ).rejects.toThrow('CREATE_FAILED 400 INVALID 장르')
    expect(s.calls[s.calls.length - 1]).toBe('DELETE ' + API + '/temp-stories/' + 'f'.repeat(24))
  })

  it('규격을 먼저 본다', () => {
    expect(() => crackWorks.checkDraft!({ ...draft, options: {} })).toThrow('BAD_DRAFT options')
    expect(() => crackDraftForm({ ...draft })).toThrow('COVER_REQUIRED')
    expect(() => crackWorks.checkDraft!({ ...draft, characters: [{ name: 'x' }] })).toThrow(
      'NO_CHARACTERS'
    )
    expect(() => crackWorks.checkDraft!({ ...draft, startScenarios: [] })).toThrow('BAD_DRAFT')
    expect(() => crackWorks.checkDraft!({ ...draft, categories: ['x'] })).toThrow('BAD_DRAFT')
    expect(() => crackWorks.checkDraft!(draft)).not.toThrow()
    const form = crackDraftForm({ ...draft, coverUrl: 'https://x/c.gif' })
    expect(crackCreateBody(form, W).isMovingPortraitImage).toBe(true)
  })
})

describe('크랙 이미지', () => {
  it('대표(프로필) 이미지만 바꿀 수 있다', async () => {
    const s = site()
    const raw = await crackWorks.readRaw(s.read, W)
    expect(crackWorks.planImages!(raw, { main: image('p.png') })).toEqual([
      { action: 'main', detail: '대표 이미지(프로필) ← p.png' }
    ])
    expect(() => crackWorks.planImages!(raw, { add: [{ file: image('a.png') }] })).toThrow(
      'NOT_SUPPORTED'
    )
    expect(() => crackWorks.planImages!(raw, { remove: [0] })).toThrow('KEEP_MAIN_IMAGE')
    expect(() => crackWorks.planImages!(raw, { main: image('p.png', png(1000, 1000)) })).toThrow(
      'BAD_IMAGE_RATIO'
    )
    expect(() => crackWorks.planImages!(raw, { main: image('p.bmp') })).toThrow('BAD_IMAGE')

    await crackWorks.applyImages!(s.io, W, raw, { main: image('p.png') })
    expect(s.calls).toContain('POST ' + API + '/stories/profile-image')
    const up = s.bodies.find((b) => 'image' in b) as Obj
    expect(Buffer.from(up.image as string, 'base64')).toEqual(Buffer.from(png(1080, 1620)))
    expect((s.sent[0].json as Obj).portraitImageUrl).toBe('/p/new.png')
  })

  it('표지 = 프로필 이미지, 새 작품 대표 이미지는 올리기만 한다', async () => {
    const s = site()
    const url = await crackWorks.uploadCover!(s.io, W, image('c.png'))
    expect(url).toBe('/p/new.png')
    expect(s.sent).toHaveLength(1)
    await expect(crackWorks.uploadCover!(s.io, W, image('c.png'), 'en')).rejects.toThrow(
      'NO_EDITIONS'
    )
    const s2 = site()
    expect(await crackWorks.uploadImage!(s2.io, image('n.png'))).toBe('/p/new.png')
    expect(s2.sent).toHaveLength(0)
  })

  it('업로드 응답 모양이 다르면 칸 이름만 담아 멈춘다', async () => {
    const write: WorkWrite = async () => ok({ path: 'x' })
    const io = { ...site().io, write }
    await expect(crackWorks.uploadImage!(io, image('n.png'))).rejects.toThrow(
      'IMAGE_UPLOAD_FAILED response 200 path'
    )
  })

  it('이미지 머리에서 크기를 읽는다', () => {
    expect(imageSize(png(2, 3))).toEqual({ width: 2, height: 3 })
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 4, 0, 6, 0])
    expect(imageSize(gif)).toEqual({ width: 4, height: 6 })
    expect(imageSize(new Uint8Array([1, 2, 3]))).toBeNull()
  })
})
