import { describe, expect, it } from 'vitest'
import { nekoCreateBody, nekoWorks } from '../src/main/works/neko'
import type {
  LocalImage,
  WorkFetch,
  WorkIo,
  WorkRequest,
  WorkSend,
  WorkWrite
} from '../src/main/works/types'

// 가짜 응답 모양은 2026-11-10 네코챗 편집기 코드에서 읽은 필드를 따른다
// (loadCharacterForEdit가 폼을 채우는 character 필드, 업로드 응답 {url}, 저장 응답 {character}).
const W = 'char_1793272855482_1jbsps4'
const SITE = 'https://www.nekochat.xyz'
type Obj = Record<string, unknown>

const ok = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const image = (name: string, size = 10): LocalImage => ({
  name,
  type: 'image/webp',
  data: new Uint8Array(size)
})

function character(): Obj {
  return {
    id: W,
    displayName: '시험 작품',
    description: '캐릭터 설명',
    shortDescription: '짧은 설명',
    narrationMode: 'narrator',
    systemPrompt: '페르소나 본문',
    persistentContext: '',
    auxiliaryPrompts: [
      {
        id: 'greeting_aux_prompt_1',
        title: '',
        content: '둘째 전용',
        keys: [],
        negativeKeys: [],
        greetingIndexes: [1],
        isEnabled: true,
        order: 0
      },
      {
        id: 'greeting_aux_prompt_2',
        title: '',
        content: '셋째 전용',
        keys: [],
        negativeKeys: [],
        greetingIndexes: [2],
        isEnabled: true,
        order: 1
      },
      {
        id: 'kw',
        title: '키워드',
        content: '키워드 전용',
        keys: ['비'],
        negativeKeys: [],
        greetingIndexes: [],
        isEnabled: true,
        order: 2
      }
    ],
    greeting: ['첫째 상황', '둘째 상황', '셋째 상황'],
    greetingSettings: [{ title: '기본', includeLorebook: true, isEditable: true }],
    categoryIds: ['romance'],
    tags: ['순애'],
    characterAudience: 'male',
    isIncentiveEnabled: null,
    isPublic: true,
    isLinkShareOnly: false,
    isMarketingConsent: true,
    isNsfw: false,
    isShared: false,
    language: 'ko',
    avatar: {
      url: 'https://cdn.nekochat.xyz/characters/' + W + '/avatar.webp',
      alt: '시험 작품 프로필 이미지'
    },
    lorebook: [
      {
        id: 'lore_1',
        name: '학교',
        content: '학교 설명',
        keys: ['학교', '교실'],
        negativeKeys: ['방학'],
        isEnabled: true,
        isExported: false,
        order: 0
      }
    ],
    loreBudget: 50000,
    lorebookImportCharacterIds: [],
    imageSlots: [
      {
        slug: 'smile',
        description: '웃음',
        url: 'https://cdn.nekochat.xyz/characters/' + W + '/smile.webp',
        triggerKeywords: []
      },
      {
        slug: 'cry',
        description: '울음',
        url: 'https://cdn.nekochat.xyz/characters/' + W + '/cry.webp',
        isVisible: false
      }
    ],
    imageSlotFolders: [],
    updatedAt: '2026-11-01T00:00:00Z'
  }
}

/** 네코챗 흉내: PUT 본문을 그대로 편집 데이터로 삼는다 */
function site(): {
  io: WorkIo
  read: WorkFetch
  write: WorkWrite
  send: WorkSend
  calls: string[]
  bodies: Obj[]
  sent: WorkRequest[]
  state: { character: Obj }
} {
  const calls: string[] = []
  const bodies: Obj[] = []
  const sent: WorkRequest[] = []
  const state = { character: character() }
  let n = 0
  const read: WorkFetch = async (url) => {
    calls.push('GET ' + url)
    if (!nekoWorks.readAllowed(url)) throw new Error('UNAPPROVED_READ_ROUTE ' + url)
    if (url.endsWith('/api/users/me/characters'))
      return ok({
        characters: [{ id: W, displayName: '시험 작품', isPublic: true, isLinkShareOnly: true }]
      })
    return ok({ character: state.character })
  }
  const write: WorkWrite = async (method, url, body) => {
    calls.push(method + ' ' + url)
    if (!nekoWorks.writeAllowed!(method, url)) throw new Error('UNAPPROVED_WRITE_ROUTE ' + url)
    bodies.push((body ?? {}) as Obj)
    if (method === 'PUT') {
      const { characterId, notifyFollowers, uploadedImageUrls, ...rest } = body as Obj
      void notifyFollowers
      void uploadedImageUrls
      state.character = { ...rest, id: characterId }
      return ok({ character: state.character })
    }
    if (method === 'POST') return ok({ character: { id: (body as Obj).characterId } })
    return ok({ success: true })
  }
  const send: WorkSend = async (request) => {
    calls.push(request.method + ' ' + request.url + ' (form)')
    if (!nekoWorks.sendRule!(request.method, request.url))
      throw new Error('UNAPPROVED ' + request.url)
    sent.push(request)
    const id = (request.form!.find((f) => f.name === 'characterId') as { value: string }).value
    n++
    return ok({ url: 'https://cdn.nekochat.xyz/characters/' + id + '/up-' + n + '.webp' })
  }
  return { io: { read, write, send }, read, write, send, calls, bodies, sent, state }
}

describe('네코챗 허용 주소', () => {
  it('편집기가 쓰는 주소·메서드만 허용한다', () => {
    const r = nekoWorks.readAllowed
    expect(r(SITE + '/api/users/me/characters')).toBe(true)
    expect(r(SITE + '/api/users/me/characters/' + W)).toBe(true)
    expect(r(SITE + '/api/users/me/characters/' + W + '?x=1')).toBe(false)
    expect(r(SITE + '/api/users/me/characters/../admin')).toBe(false)
    expect(r(SITE + '/api/characters/' + W)).toBe(false)
    expect(r('https://nekochat.xyz/api/users/me/characters')).toBe(false)

    const w = nekoWorks.writeAllowed!
    expect(w('PUT', SITE + '/api/characters')).toBe(true)
    expect(w('POST', SITE + '/api/characters')).toBe(true)
    expect(w('PUT', SITE + '/api/characters?x=1')).toBe(false)
    expect(w('DELETE', SITE + '/api/characters?characterId=' + W)).toBe(true)
    expect(w('DELETE', SITE + '/api/characters?characterId=' + W + '&x=1')).toBe(false)
    expect(w('DELETE', SITE + '/api/characters?characterId=abc')).toBe(false)
    expect(w('DELETE', SITE + '/api/characters')).toBe(false)
    expect(w('POST', SITE + '/api/characters/' + W + '/duplicate')).toBe(false)
    expect(w('PATCH', SITE + '/api/characters')).toBe(false)

    const s = nekoWorks.sendRule!
    expect(s('POST', SITE + '/api/upload/character-avatar')).toEqual({
      auth: 'session',
      body: 'form'
    })
    expect(s('POST', SITE + '/api/upload/character-image-slot')).toEqual({
      auth: 'session',
      body: 'form'
    })
    expect(s('POST', SITE + '/api/upload/character-avatar-optimized')).toBeNull()
    expect(s('DELETE', SITE + '/api/upload/character-image')).toBeNull()
    expect(s('POST', SITE + '/api/upload/character-avatar?x=1')).toBeNull()
  })
})

describe('네코챗 읽기', () => {
  it('목록과 편집 데이터를 공통 모양으로 읽는다', async () => {
    const { read } = site()
    expect(await nekoWorks.list(read)).toEqual([
      {
        id: W,
        title: '시험 작품',
        visibility: 'link',
        status: null,
        updatedAt: null,
        characters: null
      }
    ])
    const body = nekoWorks.normalize(await nekoWorks.readRaw(read, W))
    expect(body.fields).toEqual({
      title: '시험 작품',
      subtitle: '짧은 설명',
      description: '캐릭터 설명',
      main: '페르소나 본문',
      persistent_context: ''
    })
    expect(body.visibility).toBe('public')
    expect(body.lorebook).toEqual([
      {
        title: '학교',
        keys: '학교, 교실',
        content: '학교 설명',
        mode: null,
        offKeys: ['방학'],
        turnRange: null,
        offTurnRange: null
      }
    ])
    // 첫상황 설정이 모자라면 편집기처럼 "첫상황 N"으로 채운다
    expect(body.startScenarios.map((s) => [s.title, s.content, s.isDefault])).toEqual([
      ['기본', '첫째 상황', true],
      ['첫상황 2', '둘째 상황', false],
      ['첫상황 3', '셋째 상황', false]
    ])
    expect(body.characters).toEqual([])
    await expect(nekoWorks.readRaw(read, 'abc')).rejects.toThrow('BAD_WORK_ID')
  })
})

describe('네코챗 고치기', () => {
  it('글 칸·로어북·첫상황·공개 상태를 고쳐 PUT 한 번으로 저장한다', async () => {
    const s = site()
    const raw = await nekoWorks.readRaw(s.read, W)
    const next = nekoWorks.applyChanges!(raw, {
      visibility: 'private',
      fields: { title: '새 제목', persistent_context: '상시' },
      lorebookPatch: [{ index: 0, keys: '학교, 강당', offKeys: [] }],
      lorebookAdd: [
        {
          title: '집',
          keys: '집',
          content: '집 설명',
          mode: null,
          offKeys: [],
          turnRange: null,
          offTurnRange: null
        }
      ],
      startScenarios: [{ index: 0, title: '처음' }],
      startScenariosRemove: [1],
      startScenariosAdd: [{ title: '', content: '넷째 상황' }]
    })
    await nekoWorks.save!(s.write, W, next)
    expect(s.calls.at(-1)).toBe('PUT ' + SITE + '/api/characters')
    const body = s.bodies.at(-1)!
    expect(body).toMatchObject({
      characterId: W,
      notifyFollowers: false,
      displayName: '새 제목',
      isPublic: false,
      isLinkShareOnly: false,
      isIncentiveEnabled: true,
      showCreatorHandle: true,
      isDraftMode: false,
      loreBudget: 50000,
      avatar: {
        url: 'https://cdn.nekochat.xyz/characters/' + W + '/avatar.webp',
        alt: '새 제목 프로필 이미지'
      }
    })
    expect(body.uploadedImageUrls).toBeUndefined()
    expect(body.greeting).toEqual(['첫째 상황', '셋째 상황', '넷째 상황'])
    expect(body.greetingSettings).toEqual([
      { title: '처음', includeLorebook: true, isEditable: true },
      { title: '첫상황 3', includeLorebook: false, isEditable: true },
      { title: '첫상황 3', includeLorebook: false, isEditable: true }
    ])
    // 지운 첫상황(1)에 묶인 보조 프롬프트는 빠지고, 뒤의 것은 번호가 하나 당겨진다
    expect((body.auxiliaryPrompts as Obj[]).map((p) => [p.id, p.greetingIndexes])).toEqual([
      ['greeting_aux_prompt_2', [1]],
      ['kw', []]
    ])
    const lore = body.lorebook as Obj[]
    expect(lore[0]).toMatchObject({
      id: 'lore_1',
      keys: ['학교', '강당'],
      negativeKeys: [],
      order: 0
    })
    expect(lore[1]).toMatchObject({ name: '집', keys: ['집'], isEnabled: true, order: 1 })
    expect(String(lore[1].id)).toMatch(/^lore_\d+_[a-z0-9]{7}$/)

    const after = nekoWorks.normalize(await nekoWorks.readRaw(s.read, W))
    expect(after.visibility).toBe('private')
    expect(after.fields.persistent_context).toBe('상시')
    expect(after.startScenarios.map((x) => x.content)).toEqual([
      '첫째 상황',
      '셋째 상황',
      '넷째 상황'
    ])
  })

  it('링크 공개와 편집기 규칙', async () => {
    const { read } = site()
    const raw = await nekoWorks.readRaw(read, W)
    const linked = nekoWorks.applyChanges!(raw, { visibility: 'link' }) as { character: Obj }
    expect(linked.character).toMatchObject({ isPublic: true, isLinkShareOnly: true })
    const change = (c: Parameters<NonNullable<typeof nekoWorks.applyChanges>>[1]): unknown =>
      nekoWorks.applyChanges!(raw, c)
    expect(() => change({ visibility: 'unlisted' })).toThrow('BAD_VISIBILITY')
    expect(() => change({ fields: { main: '' } })).toThrow('BAD_FIELD')
    expect(() => change({ fields: { title: '가'.repeat(81) } })).toThrow('BAD_FIELD')
    expect(() => change({ fields: { creator_comment: 'x' } })).toThrow('BAD_FIELD')
    expect(() => change({ startScenariosRemove: [0] })).toThrow('KEEP_DEFAULT')
    expect(() => change({ startScenarios: [{ index: 0, dialogue: 'x' }] })).toThrow('BAD_CHANGES')
    expect(() =>
      change({ startScenariosAdd: Array.from({ length: 8 }, () => ({ content: 'x' })) })
    ).toThrow('START_LIMIT')
    expect(() => change({ lorebookPatch: [{ index: 0, mode: 'keyword' }] })).toThrow('BAD_CHANGES')
    expect(() => change({ lorebookPatch: [{ index: 0, keys: '' }] })).toThrow('BAD_LOREBOOK')
    expect(() =>
      change({ lorebookPatch: [{ index: 0, offKeys: ['a', 'b', 'c', 'd', 'e', 'f'] }] })
    ).toThrow('BAD_LOREBOOK')
    expect(() => change({ characters: [{ index: 0, name: 'x' }] })).toThrow('NO_CHARACTERS')
  })

  it('작품 삭제는 characterId 쿼리 하나만 붙인 DELETE다', async () => {
    const s = site()
    await nekoWorks.remove!(s.write, W)
    expect(s.calls).toEqual(['DELETE ' + SITE + '/api/characters?characterId=' + W])
  })
})

describe('네코챗 이미지', () => {
  it('아바타는 0번이고, 슬롯은 slug·숨김 여부로 보인다', async () => {
    const { read } = site()
    const raw = await nekoWorks.readRaw(read, W)
    expect(
      nekoWorks.imageGroups!(raw)[0].images.map((i) => [i.label, i.visibility, i.isDefault])
    ).toEqual([
      ['대표', null, true],
      ['smile', 'public', false],
      ['cry', 'hidden', false]
    ])
    const plan = nekoWorks.planImages!
    expect(() => plan(raw, { remove: [0] })).toThrow('KEEP_MAIN_IMAGE')
    expect(() => plan(raw, { add: [{ file: image('a.webp'), label: 'cry' }] })).toThrow(
      'BAD_IMAGE_LABEL'
    )
    expect(() => plan(raw, { add: [{ file: image('a.webp'), label: 'a-b' }] })).toThrow(
      'BAD_IMAGE_LABEL'
    )
    expect(() => plan(raw, { add: [{ file: image('a.webp', 4_718_593) }] })).toThrow(
      'IMAGE_TOO_LARGE'
    )
    expect(() => plan(raw, { add: [{ file: image('a.webp') }], order: [0, 2, 1] })).toThrow(
      'BAD_CHANGES'
    )
    expect(
      plan(raw, { remove: [1], add: [{ file: image('a.webp'), label: 'cry2' }] })
    ).toHaveLength(2)
  })

  it('파일을 먼저 올리고 받은 주소로 PUT 한 번에 저장한다', async () => {
    const s = site()
    const raw = await nekoWorks.readRaw(s.read, W)
    await nekoWorks.applyImages!(s.io, W, raw, {
      main: image('main.webp'),
      add: [{ file: image('wink.webp'), label: 'wink', visibility: 'hidden' }],
      remove: [1]
    })
    expect(s.calls.filter((c) => c.startsWith('POST') || c.startsWith('PUT'))).toEqual([
      'POST ' + SITE + '/api/upload/character-avatar (form)',
      'POST ' + SITE + '/api/upload/character-image-slot (form)',
      'PUT ' + SITE + '/api/characters'
    ])
    expect(
      s.sent[1].form!.map((f) => ('file' in f ? 'file:' + f.file.name : f.name + '=' + f.value))
    ).toEqual(['file:wink.webp', 'characterId=' + W, 'imageSlug=wink'])
    const body = s.bodies.at(-1)!
    expect(body.uploadedImageUrls).toEqual([
      'https://cdn.nekochat.xyz/characters/' + W + '/up-1.webp',
      'https://cdn.nekochat.xyz/characters/' + W + '/up-2.webp'
    ])
    expect((body.imageSlots as Obj[]).map((e) => [e.slug, e.isVisible])).toEqual([
      ['cry', false],
      ['wink', false]
    ])
    expect(body.avatar).toEqual({
      url: 'https://cdn.nekochat.xyz/characters/' + W + '/up-1.webp',
      alt: '시험 작품 프로필 이미지'
    })
  })

  it('순서 바꾸기와 표지', async () => {
    const s = site()
    const raw = await nekoWorks.readRaw(s.read, W)
    await nekoWorks.applyImages!(s.io, W, raw, { order: [0, 2, 1] })
    expect((s.bodies.at(-1)!.imageSlots as Obj[]).map((e) => e.slug)).toEqual(['cry', 'smile'])
    const url = await nekoWorks.uploadCover!(s.io, W, image('cover.webp'))
    expect(nekoWorks.coverUrl!(await nekoWorks.readRaw(s.read, W))).toBe(url)
    await expect(nekoWorks.uploadCover!(s.io, W, image('c.webp'), 'en')).rejects.toThrow(
      'NO_EDITIONS'
    )
  })
})

describe('네코챗 새 작품', () => {
  const draft = {
    title: '새 작품',
    main: '페르소나',
    adult: true,
    subtitle: '짧은 설명',
    description: '캐릭터 설명',
    hashtags: ['순애'],
    characters: [],
    startScenarios: [{ title: '시작', content: '첫 상황' }],
    options: { character_audience: 'all' }
  }

  it('아바타를 임시 번호로 올리고 같은 번호로 비공개 작품을 만든다', async () => {
    const s = site()
    const cover = await nekoWorks.uploadImage!(s.io, image('cover.webp'))
    const temp = (s.sent[0].form!.find((f) => f.name === 'characterId') as { value: string }).value
    expect(temp).toMatch(/^char_\d+_[a-z0-9]{7}$/)
    const id = await nekoWorks.create!(s.write, { ...draft, coverUrl: cover })
    expect(id).toBe(temp)
    const body = s.bodies.at(-1)!
    expect(s.calls.at(-1)).toBe('POST ' + SITE + '/api/characters')
    expect(body).toMatchObject({
      characterId: temp,
      displayName: '새 작품',
      systemPrompt: '페르소나',
      shortDescription: '짧은 설명',
      isPublic: false,
      isLinkShareOnly: false,
      isNsfw: true,
      characterAudience: 'all',
      language: 'ko',
      greeting: ['첫 상황'],
      greetingSettings: [{ title: '시작', includeLorebook: false, isEditable: true }],
      avatar: { url: cover, alt: '새 작품 프로필 이미지' },
      uploadedImageUrls: [cover]
    })
    expect(body.notifyFollowers).toBeUndefined()
  })

  it('규격을 먼저 본다', () => {
    nekoWorks.checkDraft!(draft)
    expect(() => nekoWorks.checkDraft!({ ...draft, options: {} })).toThrow('BAD_DRAFT')
    expect(() => nekoWorks.checkDraft!({ ...draft, subtitle: '' })).toThrow('BAD_FIELD')
    expect(() => nekoWorks.checkDraft!({ ...draft, hashtags: [] })).toThrow('BAD_DRAFT')
    expect(() => nekoWorks.checkDraft!({ ...draft, startScenarios: [] })).toThrow('START_LIMIT')
    expect(() => nekoWorks.checkDraft!({ ...draft, characters: [{ name: 'x' }] })).toThrow(
      'NO_CHARACTERS'
    )
    expect(() => nekoCreateBody({ ...draft, coverUrl: 'https://cdn.example/x.webp' })).toThrow(
      'COVER_REQUIRED'
    )
    // 카테고리만 있어도 된다
    nekoWorks.checkDraft!({ ...draft, hashtags: [], categories: ['romance'] })
  })
})
