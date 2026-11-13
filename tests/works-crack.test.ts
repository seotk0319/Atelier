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

describe('크랙 저장: 바꾸려던 칸만 바뀐다', () => {
  const lore = (title: string, keys: string, content: string): WorkChanges['lorebook'] => [
    { title, keys, content, mode: null, offKeys: [], turnRange: null, offTurnRange: null }
  ]
  const names = (set: Obj): unknown[] => (set.keywordBook as Obj[]).map((k) => k.name)

  it('로어북 전체 교체는 제목으로 짝지어 옛 노트의 적용 시작 설정을 물려준다', async () => {
    // 학교 = 두 시작 설정, 비 = 첫 시작 설정에만 적용
    const s = site()
    const all = [
      ...lore('밤', '밤', '밤 설명')!,
      ...lore('학교', '학교, 교실', '학교 설명')!,
      ...lore('비', '비', '비 오는 날')!
    ]
    const { body } = await saved(s, { lorebook: all })
    const sets = body.startingSets as Obj[]
    expect(names(sets[0])).toEqual(['밤', '학교', '비'])
    expect(names(sets[1])).toEqual(['밤', '학교'])
  })

  it('전체 교체에서 짝이 없는 새 노트는 같은 자리 옛 노트를 물려받지 않는다', async () => {
    const s = site()
    const { body } = await saved(s, {
      lorebook: [...lore('비', '비', '비 오는 날')!, ...lore('새 노트', '새', '새 설명')!]
    })
    const sets = body.startingSets as Obj[]
    expect(names(sets[0])).toEqual(['비', '새 노트'])
    expect(names(sets[1])).toEqual(['새 노트'])
  })

  it('이름만 바꾼 노트는 본문이 같은 옛 노트의 적용 범위를 물려받는다 (앞 노트를 지워도)', async () => {
    // 학교 = 두 시작 설정, 비 = 첫 시작 설정에만 적용. 학교를 지우고 비를 장마로 이름 바꿈
    const s = site()
    const { body } = await saved(s, { lorebook: lore('장마', '비', '비 오는 날') })
    const sets = body.startingSets as Obj[]
    expect(names(sets[0])).toEqual(['장마'])
    expect(names(sets[1])).toEqual([])
  })

  it('이름을 바꾸고 새 노트를 끼워도 옛 노트의 적용 범위가 새 노트로 번지지 않는다', async () => {
    const s = site()
    const { body } = await saved(s, {
      lorebook: [
        ...lore('학교', '학교, 교실', '학교 설명')!,
        ...lore('끼움', '끼', '끼운 설명')!,
        ...lore('새 이름', '비', '비 오는 날')!
      ]
    })
    const sets = body.startingSets as Obj[]
    // 끼운 노트만 새 노트(모든 시작 설정), 이름 바꾼 비는 첫 시작 설정에만
    expect(names(sets[0])).toEqual(['학교', '끼움', '새 이름'])
    expect(names(sets[1])).toEqual(['학교', '끼움'])
  })

  it('같은 제목 노트가 둘일 때 순서를 바꿔도 내용이 같은 옛 노트의 적용 범위를 지킨다', async () => {
    const st = story()
    const raws = st.startingSets as Obj[]
    raws[0].keywordBook = [{ name: '중복', prompt: '첫째 본문', keywords: ['가'] }]
    raws[1].keywordBook = [{ name: '중복', prompt: '둘째 본문', keywords: ['나'] }]
    const s = site(st)
    const raw = await crackWorks.readRaw(s.read, W)
    // 목록 순서가 바뀌므로 저장 뒤 다시 읽은 순서와는 견주지 않고 보낼 본문만 본다
    const next = crackWorks.applyChanges!(raw, {
      lorebook: [...lore('중복', '나', '둘째 본문')!, ...lore('중복', '가', '첫째 본문')!]
    })
    const sets = crackPatchBody((next as { story: Obj }).story).startingSets as Obj[]
    expect(sets[0].keywordBook).toEqual([{ name: '중복', prompt: '첫째 본문', keywords: ['가'] }])
    expect(sets[1].keywordBook).toEqual([{ name: '중복', prompt: '둘째 본문', keywords: ['나'] }])
  })

  it('전체 교체에서 키워드를 안 준 노트는 짝지은 옛 노트의 키워드를 그대로 둔다', async () => {
    const s = site()
    const raw = await crackWorks.readRaw(s.read, W)
    const entry = { title: '학교', content: '고친 학교 설명', mode: null, offKeys: [], turnRange: null, offTurnRange: null }
    const { body } = await saved(s, {
      lorebook: [
        { ...entry, keys: '', given: ['title', 'content'] },
        { ...entry, title: '비', content: '비 오는 날', keys: '', given: ['title', 'content'] }
      ] as WorkChanges['lorebook']
    })
    const sets = body.startingSets as Obj[]
    expect(sets[0].keywordBook).toEqual([
      { name: '학교', prompt: '고친 학교 설명', keywords: ['학교', '교실'] },
      { name: '비', prompt: '비 오는 날', keywords: ['비'] }
    ])
    // 짝이 없는 새 노트(순서가 밀려 제자리 이음도 없음)는 키워드를 안 주면 여전히 막는다
    expect(() =>
      crackWorks.applyChanges!(raw, {
        lorebook: [
          { ...entry, title: '비', content: '비 오는 날', keys: '', given: ['title', 'content'] },
          { ...entry, title: '새', content: '새 설명', keys: '', given: ['title', 'content'] }
        ] as WorkChanges['lorebook']
      })
    ).toThrow('BAD_LOREBOOK')
  })

  it('읽은 키워드 글을 그대로 돌려주면 쉼표가 든 키워드가 쪼개지지 않는다', async () => {
    const st = story()
    const raws = st.startingSets as Obj[]
    raws[0].keywordBook = [{ name: '쉼표', prompt: '설명', keywords: ['a,b', 'c'] }]
    raws[1].keywordBook = []
    const s = site(st)
    const read = crackWorks.normalize(await crackWorks.readRaw(s.read, W))
    expect(read.lorebook[0].keys).toBe('a,b, c')
    const { body } = await saved(s, { lorebook: [{ ...read.lorebook[0], content: '고친 설명' }] })
    expect((body.startingSets as Obj[])[0].keywordBook).toEqual([
      { name: '쉼표', prompt: '고친 설명', keywords: ['a,b', 'c'] }
    ])
  })

  it('첫 메시지를 고쳐도 두 번째 이후 프롤로그를 지우지 않는다', async () => {
    const st = story()
    ;(st.startingSets as Obj[])[0].initialMessages = ['첫 메시지', '두 번째']
    const s = site(st)
    const { body } = await saved(s, {
      startScenarios: [{ index: 0, title: '새 이름', content: '첫 메시지' }]
    })
    expect((body.startingSets as Obj[])[0]).toMatchObject({
      name: '새 이름',
      initialMessages: ['첫 메시지', '두 번째']
    })
    // 첫 메시지를 바꿔도 두 번째 이후 프롤로그는 원본 그대로 남는다
    const s2 = site(st)
    const r2 = await saved(s2, { startScenarios: [{ index: 0, content: '바뀐 메시지' }] })
    expect((r2.body.startingSets as Obj[])[0].initialMessages).toEqual(['바뀐 메시지', '두 번째'])
    // 프롤로그가 하나뿐이면 그 하나만 바뀐다
    const s3 = site()
    const r3 = await saved(s3, { startScenarios: [{ index: 1, content: '새 둘째' }] })
    expect((r3.body.startingSets as Obj[])[1].initialMessages).toEqual(['새 둘째'])
  })

  it('원본에 공개 상태·템플릿이 없으면 지어 보내지 않고 멈춘다', async () => {
    const noVisibility = story()
    delete noVisibility.visibility
    expect(() => crackPatchBody(noVisibility)).toThrow('WORK_SHAPE visibility')
    const noTemplate = story()
    delete noTemplate.promptTemplate
    expect(() => crackPatchBody(noTemplate)).toThrow('WORK_SHAPE promptTemplate')

    // 계획 단계(applyChanges)에서 멈춘다. 저장까지 가서 계획이 소비된 뒤에 걸리지 않는다
    const s = site(noVisibility)
    const raw = await crackWorks.readRaw(s.read, W)
    expect(() => crackWorks.applyChanges!(raw, { fields: { title: '바뀐 제목' } })).toThrow(
      'WORK_SHAPE visibility'
    )
    // 고칠 것이 없는 호출은 멈추지 않는다
    expect(() => crackWorks.applyChanges!(raw, {})).not.toThrow()
    // 공개 상태를 직접 정하는 저장은 원본의 빈 칸을 지어 보내지 않으므로 막지 않는다
    const vis = await saved(s, { visibility: 'private' })
    expect(vis.body).toEqual({ visibility: 'private' })
    expect(s.sent).toHaveLength(1)
  })

  it('템플릿 칸이 객체인데 template이 없어도 지어 보내지 않고 계획 단계에서 멈춘다', async () => {
    const st = story()
    st.promptTemplate = { name: '이름만' }
    expect(() => crackPatchBody(st)).toThrow('WORK_SHAPE promptTemplate')
    const s = site(st)
    const raw = await crackWorks.readRaw(s.read, W)
    expect(() => crackWorks.applyChanges!(raw, { fields: { title: '바뀐 제목' } })).toThrow(
      'WORK_SHAPE promptTemplate'
    )
  })

  it('표지 올리기도 이미지를 올리기 전에 멈춘다', async () => {
    const st = story()
    delete st.visibility
    const s = site(st)
    const raw = await crackWorks.readRaw(s.read, W)
    expect(() => crackWorks.planImages!(raw, { main: image('p.png') })).toThrow('WORK_SHAPE visibility')
    await expect(crackWorks.applyImages!(s.io, W, raw, { main: image('p.png') })).rejects.toThrow(
      'WORK_SHAPE visibility'
    )
    await expect(crackWorks.uploadCover!(s.io, W, image('c.png'))).rejects.toThrow(
      'WORK_SHAPE visibility'
    )
    expect(s.calls.some((c) => c.includes('profile-image'))).toBe(false)
    expect(s.sent).toHaveLength(0)
  })

  it('손대지 않은 옛 항목은 한도를 넘어도 저장을 막지 않고 그대로 보낸다', async () => {
    const st = story()
    Object.assign(st, { simpleDescription: '', customPrompt: '가'.repeat(7005) })
    const raws = st.startingSets as Obj[]
    raws[0].name = '열세 글자가 넘는 시작 설정'
    raws[0].keywordBook = [
      { name: '긴 노트', prompt: '나'.repeat(450), keywords: ['가나다라마바사아자차카'] }
    ]
    raws[1].keywordBook = []
    raws[1].playGuide = 'x'.repeat(501)
    const s = site(st)
    const { body } = await saved(s, { fields: { title: '제목만 고침' } })
    const sets = body.startingSets as Obj[]
    expect(body.name).toBe('제목만 고침')
    expect(body.simpleDescription).toBe('')
    expect((body.customPrompt as string).length).toBe(7005)
    expect(sets[0].name).toBe('열세 글자가 넘는 시작 설정')
    expect((sets[0].keywordBook as Obj[])[0].prompt).toHaveLength(450)
    expect(sets[1].playGuide).toHaveLength(501)

    // 바뀐 칸은 여전히 검사한다. 옛 값이 길어도 그 칸을 고치지 않았다면 통과한다
    const raw = await crackWorks.readRaw(s.read, W)
    const apply = (c: WorkChanges): unknown => crackWorks.applyChanges!(raw, c)
    expect(() => apply({ fields: { main: '가'.repeat(7006) } })).toThrow('BAD_FIELD main')
    expect(() => apply({ lorebookPatch: [{ index: 0, content: '라'.repeat(451) }] })).toThrow(
      'BAD_LOREBOOK'
    )
    expect(() => apply({ lorebookPatch: [{ index: 0, keys: '가나다라마바사아자차카, 둘' }] })).toThrow(
      'BAD_LOREBOOK'
    )
    expect(() => apply({ startScenarios: [{ index: 0, situation: 'x'.repeat(1001) }] })).toThrow(
      'BAD_START'
    )
    expect(() => apply({ startScenarios: [{ index: 0, title: '다른 이름이 열세 글자 넘음' }] })).toThrow(
      'BAD_START'
    )
    expect(() => apply({ lorebookPatch: [{ index: 0, content: '짧게 고침' }] })).not.toThrow()
    expect(() => apply({ startScenarios: [{ index: 0, situation: '새 상황' }] })).not.toThrow()
  })

  it('노트 개수는 옛 작품보다 늘어난 때만 한도로 막는다', async () => {
    const st = story()
    const raws = st.startingSets as Obj[]
    raws[0].keywordBook = Array.from({ length: 21 }, (_, i) => ({
      name: '노트' + i,
      prompt: '설명',
      keywords: ['k']
    }))
    raws[1].keywordBook = []
    const s = site(st)
    const raw = await crackWorks.readRaw(s.read, W)
    expect(() => crackWorks.applyChanges!(raw, { fields: { title: '제목만' } })).not.toThrow()
    const same = crackWorks.normalize(raw).lorebook
    expect(() => crackWorks.applyChanges!(raw, { lorebook: [...same, ...lore('끝', 'k', '내용')!] })).toThrow(
      'LOREBOOK_LIMIT'
    )
  })

  it('시작 설정이 없던 작품도 다른 칸을 고쳐 저장할 수 있다', async () => {
    const st = story()
    st.startingSets = []
    const s = site(st)
    const raw = await crackWorks.readRaw(s.read, W)
    const next = crackWorks.applyChanges!(raw, { fields: { title: '제목만' } })
    expect(crackPatchBody((next as { story: Obj }).story).startingSets).toBeUndefined()
  })

  it('단축어 번호는 원본에 있으면 그대로 돌려보낸다', () => {
    const st = story()
    ;(st.shortcutCommands as Obj[])[0].id = 'sc-1'
    expect((crackPatchBody(st).shortcutCommands as Obj[])[0].id).toBe('sc-1')
    expect(typeof (crackPatchBody(story()).shortcutCommands as Obj[])[0].id).toBe('string')
  })
})

describe('크랙 기능 표·읽기 전용 설정', () => {
  const KEYS = [
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
  /** 지어낸 값으로 채운 원본: 통계·상황 이미지·스탯·엔딩·단축어·애드온·대화 예시까지 */
  function rich(): Obj {
    const st = story()
    const sets = st.startingSets as Obj[]
    sets[0].initialMessages = ['첫 메시지', '두 번째']
    sets[0].ending = { endings: [{ name: '엔딩 하나' }, { name: '엔딩 둘' }] }
    sets[0].situationImages = [
      { situation: '웃음', imageUrl: 'https://cdn.wrtn.ai/s/1.png', moderationVerdict: 'passed' },
      { situation: '울음', imageUrl: 'https://cdn.wrtn.ai/s/2.png', moderationVerdict: null }
    ]
    sets[0].replySuggestions = ['안녕', '반가워']
    return {
      ...st,
      createdAt: '2026-01-02T03:04:05.000Z',
      firstPublicAt: '2026-01-03T03:04:05.000Z',
      updateInfo: { version: 7, releasedAt: '2026-02-03T00:00:00.000Z' },
      countryCode: 'KR',
      genre: { _id: 'g1', name: '로맨스', type: 'romance' },
      isConvertedToAdult: false,
      model: 'SONNET',
      badges: [{ type: 'a' }, { type: 'b' }],
      original: { isOriginal: false, isEditBlocked: true, isFanficEnabled: false },
      onlyContent: { isOnlyContent: true, isLocked: false },
      creatorRecommendedMaxOutput: { type: 'TOTAL', totalMultiplier: 'long' },
      isMovingPortraitImage: false,
      chatExamples: [{ user: '질문', character: '대답' }],
      addonCategories: [
        { categoryName: '문체', addons: [{ name: 'a', prompt: 'p' }, { name: 'b', prompt: 'q' }] }
      ],
      creator: { nickname: '지어낸 닉네임', wrtnUid: 'uid-secret' },
      chatCount: 11,
      chatUserCount: 5,
      likeCount: 3,
      dislikeCount: 1,
      commentCount: 2,
      totalMessageCount: 99,
      isLiked: true
    }
  }
  const read = (st: Obj): ReturnType<typeof crackWorks.normalize> =>
    crackWorks.normalize({ id: W, story: st })

  it('기능 표는 22개 열쇠를 모두 갖고 설명은 40자 이내다', () => {
    const features = crackWorks.features!
    expect(Object.keys(features).sort()).toEqual([...KEYS].sort())
    for (const [key, f] of Object.entries(features)) {
      expect(['yes', 'no', 'unknown']).toContain(f.site)
      expect(['yes', 'no', 'partial']).toContain(f.read)
      expect(['yes', 'no', 'partial', 'blocked']).toContain(f.write)
      expect(['yes', 'no', 'partial']).toContain(f.verified)
      expect(f.note, key).toBeTruthy()
      expect(f.note!.length, key).toBeLessThanOrEqual(40)
    }
    expect(features.situation_images.write).toBe('blocked')
    expect(features.characters.site).toBe('no')
    // 적용 시작 설정이 안 보이고 쓰기는 제목 짝짓기로 추정하므로 일부만 된다
    expect(features.lorebook).toMatchObject({ read: 'partial', write: 'partial' })
    expect(features.example_dialogue.read).toBe('partial')
    // 상황 이미지가 있는 옛 방식(v1)의 한도도 적혀 있다
    expect(features.main_prompt.note).toContain('5000·3000')
    expect(features.first_message.write).toBe('yes')
  })

  it('숨은 설정을 짧은 값·개수로 싣는다', () => {
    const { extras } = read(rich())
    expect(extras).toEqual({
      genre_name: '로맨스',
      genre_type: 'romance',
      genre_id: 'g1',
      target: 'male',
      chat_type: 'roleplay',
      is_adult: true,
      is_converted_to_adult: false,
      prompt_template: 'custom',
      default_cracker_model: 'superchat',
      chat_model_id: 'm1',
      model: 'SONNET',
      max_output_type: 'TOTAL',
      max_output_multiplier: 'long',
      country_code: 'KR',
      tags: ['순애'],
      has_cover: true,
      cover_is_moving: false,
      is_comment_blocked: false,
      situation_image_version: 'v2',
      version: 7,
      created_at: '2026-01-02T03:04:05.000Z',
      is_original: false,
      is_edit_blocked: true,
      is_fanfic_enabled: false,
      only_content: true,
      only_content_locked: false,
      situation_image_count: 2,
      reply_suggestion_count: 2,
      stat_count: 1,
      ending_count: 2,
      shortcut_count: 1,
      addon_category_count: 1,
      addon_count: 2,
      chat_example_count: 1,
      keyword_notes_limited_to_some_sets: 1
    })
  })

  it('본문·표지 주소·계정 정보·통계는 싣지 않는다', () => {
    const json = JSON.stringify(read(rich()).extras)
    for (const leak of ['메인 프롬프트', '첫 메시지', '질문', 'origin.png', '지어낸 닉네임', 'uid-secret'])
      expect(json).not.toContain(leak)
    const { extras } = read(rich())
    for (const key of ['chat_count', 'like_count', 'comment_count', 'total_message_count', 'is_liked'])
      expect(extras).not.toHaveProperty(key)
    // 통계가 달라져도 읽은 모양이 같아야 계획 뒤 변화 검사가 깨지지 않는다
    const later = { ...rich(), chatCount: 500, likeCount: 90, commentCount: 40, isLiked: false }
    expect(JSON.stringify(read(later))).toBe(JSON.stringify(read(rich())))
  })

  it('서버가 따로 바꾸는 값(검수 결과·배지·공개 시각)이 달라져도 읽은 모양이 같다', () => {
    // work_plan이 굳히는 값(frozen)은 updatedAt만 뺀 읽은 모양 전체다
    const frozen = (st: Obj): string => JSON.stringify({ ...read(st), updatedAt: null })
    const before = rich()
    const sets = JSON.parse(JSON.stringify(before.startingSets)) as Obj[]
    ;(sets[0].situationImages as Obj[]).forEach((e) => (e.moderationVerdict = 'rejected'))
    const after = {
      ...before,
      startingSets: sets,
      badges: [],
      firstPublicAt: '2026-11-13T00:00:00.000Z',
      updateInfo: { version: 7, releasedAt: '2026-11-13T00:00:00.000Z' }
    }
    expect(frozen(after)).toBe(frozen(before))
    const { extras } = read(before)
    for (const key of ['situation_image_moderation', 'badge_count', 'first_public_at', 'released_at'])
      expect(extras).not.toHaveProperty(key)
  })

  it('원본에 없는 칸은 싣지 않고 긴 값은 개수로 줄인다', () => {
    const { extras, unsupported } = read({
      _id: W,
      name: '이름',
      visibility: 'private',
      promptTemplate: 'default',
      tags: Array.from({ length: 21 }, (_, i) => 't' + i),
      target: 'x'.repeat(81),
      startingSets: [{ _id: 's', name: '기본', initialMessages: ['a'], keywordBook: [] }]
    })
    expect(extras).toEqual({
      prompt_template: 'default',
      tag_count: 21,
      situation_image_count: 0,
      reply_suggestion_count: 0,
      stat_count: 0,
      ending_count: 0
    })
    expect(unsupported).toEqual(['제작자 노트', '대화·좋아요·댓글 수'])
  })

  it('읽지 못하는 칸은 내용이 있을 때만 알린다', () => {
    expect(read(rich()).unsupported).toEqual([
      '제작자 노트',
      '대화·좋아요·댓글 수',
      '추천 답변 내용',
      '스탯 내용',
      '엔딩 내용',
      '단축어 내용',
      '애드온 내용',
      '대화 예시 내용',
      '키워드 노트 적용 시작 설정',
      '두 번째 이후 프롤로그'
    ])
    const plain = read(story())
    expect(plain.unsupported).toContain('추천 답변 내용')
    expect(plain.unsupported).not.toContain('엔딩 내용')
    expect(plain.unsupported).not.toContain('두 번째 이후 프롤로그')
  })

  it('숨은 설정을 더해도 계획 비교에 쓰는 기존 칸은 그대로다', async () => {
    const s = site()
    const body = crackWorks.normalize(await crackWorks.readRaw(s.read, W))
    expect(body.updatedAt).toBe('v3')
    expect(body.visibility).toBe('private')
    expect(body.status).toBe('active')
    expect(body.characters).toEqual([])
    expect(body.lorebook).toHaveLength(2)
  })

  it('로어북 전체 교체: 크랙에 없는 칸(mode·턴·제외 키워드)은 안 줬으면 통과하고 값을 주면 막는다', () => {
    const s = story()
    const entry = {
      title: '학교',
      keys: '학교, 교실',
      content: '새 설명',
      mode: null,
      offKeys: [],
      turnRange: null,
      offTurnRange: null
    }
    const apply = (e: Obj): unknown =>
      crackWorks.applyChanges!({ id: W, story: s }, {
        lorebook: [{ ...entry, ...e }] as WorkChanges['lorebook']
      })
    expect(() => apply({ given: ['title', 'content'] })).not.toThrow()
    expect(() => apply({ given: ['title', 'mode'], mode: 'keyword' })).toThrow('BAD_CHANGES')
    expect(() => apply({ given: ['offKeys'], offKeys: ['x'] })).toThrow('BAD_CHANGES')
    expect(() => apply({ given: ['mode'], mode: null })).not.toThrow()
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
