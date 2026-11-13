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
      // 원본이 null이던 값·없던 값은 예전부터 보내던 기본값으로 채운다
      isIncentiveEnabled: true,
      showCreatorHandle: true,
      isMarketingConsent: true,
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

  it('첫상황 제목이 100자를 넘으면 잘라 보내지 않고 막는다', () => {
    const long = '가'.repeat(101)
    expect(() =>
      nekoWorks.checkDraft!({ ...draft, startScenarios: [{ title: long, content: 'x' }] })
    ).toThrow('BAD_START')
    nekoWorks.checkDraft!({
      ...draft,
      startScenarios: [{ title: '가'.repeat(100), content: 'x' }]
    })
  })
})

type Raw = { id: string; character: Obj }
const loreEntry = (title: string, keys: string, content = title + ' 설명'): LoreEntryInput => ({
  title,
  keys,
  content,
  mode: null,
  offKeys: [],
  turnRange: null,
  offTurnRange: null
})
type LoreEntryInput = NonNullable<
  Parameters<NonNullable<typeof nekoWorks.applyChanges>>[1]['lorebook']
>[number]

describe('네코챗 저장: 원본 값을 지키고, 없음·null일 때만 예전 기본값을 채운다', () => {
  async function saved(edit: (c: Obj) => void): Promise<Obj> {
    const s = site()
    const raw = (await nekoWorks.readRaw(s.read, W)) as Raw
    edit(raw.character)
    const next = nekoWorks.applyChanges!(raw, { fields: { title: '새 제목' } })
    await nekoWorks.save!(s.write, W, next)
    // 사이트로 나가는 모양 (값이 없는 칸은 빠진다)
    return JSON.parse(JSON.stringify(s.bodies.at(-1)))
  }

  it('원본에 없거나 null인 설정값은 예전부터 보내던 기본값으로 채운다', async () => {
    const wire = await saved((c) => {
      c.isIncentiveEnabled = null
      delete c.showCreatorHandle
      delete c.isMarketingConsent
      delete c.isShared
      delete c.narrationMode
      delete c.loreBudget
      delete c.characterAudience
      c.isLinkShareOnly = null
      c.personaTemplates = null
      c.slashCommands = null
      c.imageSlots = [
        { slug: 'a', url: 'https://cdn.nekochat.xyz/a.webp', isVisible: null },
        { slug: 'b', url: 'https://cdn.nekochat.xyz/b.webp' }
      ]
    })
    expect(wire).toMatchObject({
      isIncentiveEnabled: true,
      showCreatorHandle: true,
      isMarketingConsent: false,
      isShared: false,
      narrationMode: 'narrator',
      loreBudget: 100000,
      characterAudience: '',
      isLinkShareOnly: false
    })
    // null인 목록 설정은 칸을 뺀다
    expect('personaTemplates' in wire).toBe(false)
    expect('slashCommands' in wire).toBe(false)
    for (const slot of wire.imageSlots as Obj[])
      expect(slot).toMatchObject({ isVisible: true, isAlwaysVisible: false })
    // 편집기가 항상 false로 두는 값(isDraftMode)과 공개 여부는 그대로
    expect(wire.isDraftMode).toBe(false)
    expect(wire.isPublic).toBe(true)
  })

  it('원본에 값이 있으면 끔(false)이어도 기본값으로 덮지 않는다', async () => {
    const wire = await saved((c) => {
      c.isIncentiveEnabled = false
      c.showCreatorHandle = false
      c.isMarketingConsent = false
      c.isShared = true
      c.narrationMode = 'character'
      c.loreBudget = 7
      c.characterAudience = 'female'
      c.isLinkShareOnly = true
      c.imageSlots = [
        { slug: 'a', url: 'https://cdn.nekochat.xyz/a.webp', isVisible: false, isAlwaysVisible: true }
      ]
    })
    expect(wire).toMatchObject({
      isIncentiveEnabled: false,
      showCreatorHandle: false,
      isMarketingConsent: false,
      isShared: true,
      narrationMode: 'character',
      loreBudget: 7,
      characterAudience: 'female',
      isLinkShareOnly: true
    })
    expect((wire.imageSlots as Obj[])[0]).toMatchObject({ isVisible: false, isAlwaysVisible: true })
  })

  it('공개 여부를 모르면 보내지 않고 멈춘다', async () => {
    const s = site()
    const raw = (await nekoWorks.readRaw(s.read, W)) as Raw
    delete raw.character.isPublic
    const next = nekoWorks.applyChanges!(raw, { fields: { title: '새 제목' } })
    await expect(nekoWorks.save!(s.write, W, next)).rejects.toThrow('UNKNOWN_VISIBILITY')
    expect(s.calls.filter((c) => c.startsWith('PUT'))).toEqual([])
  })

  it('이미지 저장도 공개 여부를 모르면 파일을 올리기 전에 멈춘다', async () => {
    const s = site()
    const raw = (await nekoWorks.readRaw(s.read, W)) as Raw
    raw.character.isPublic = null
    await expect(
      nekoWorks.applyImages!(s.io, W, raw, { add: [{ file: image('a.webp'), label: 'a' }] })
    ).rejects.toThrow('UNKNOWN_VISIBILITY')
    delete raw.character.isPublic
    await expect(
      nekoWorks.applyImages!(s.io, W, raw, { main: image('m.webp') })
    ).rejects.toThrow('UNKNOWN_VISIBILITY')
    // 올리기도 저장도 나가지 않는다 (읽기만 한 번)
    expect(s.calls.filter((c) => !c.startsWith('GET'))).toEqual([])
    expect(s.sent).toEqual([])
  })
})

describe('네코챗 로어북 전체 교체', () => {
  const oldLore = [
    { id: 'lore_a', name: '학교', content: 'a', keys: ['학교'], negativeKeys: [], isEnabled: true, isExported: false, order: 0 },
    { id: 'lore_b', name: '집', content: 'b', keys: ['집'], negativeKeys: [], isEnabled: false, isExported: true, order: 1 },
    { id: 'lore_c', _id: 'db_c', name: '길', content: 'c', keys: ['길'], negativeKeys: [], isEnabled: true, isExported: false, order: 2 }
  ]
  async function replaced(entries: LoreEntryInput[], edit?: (c: Obj) => void): Promise<Obj[]> {
    const s = site()
    const raw = (await nekoWorks.readRaw(s.read, W)) as Raw
    raw.character.lorebook = structuredClone(oldLore)
    edit?.(raw.character)
    const next = nekoWorks.applyChanges!(raw, { lorebook: entries }) as Raw
    return next.character.lorebook as Obj[]
  }

  it('제목으로 옛 항목과 짝지어 번호·켜짐 상태를 잇고, 짝 없는 새 항목은 새로 만든다', async () => {
    const lore = await replaced([
      loreEntry('길', '길'),
      loreEntry('새것', '새것'),
      loreEntry('집', '집')
    ])
    expect(lore[0]).toMatchObject({ id: 'lore_c', _id: 'db_c', isEnabled: true, order: 0 })
    expect(lore[1]).toMatchObject({ name: '새것', isEnabled: true, isExported: false, order: 1 })
    expect(String(lore[1].id)).toMatch(/^lore_\d+_[a-z0-9]{7}$/)
    expect('_id' in lore[1]).toBe(false)
    // 꺼 둔 '집'은 자리가 바뀌어도 꺼진 채 자기 번호를 지킨다
    expect(lore[2]).toMatchObject({ id: 'lore_b', isEnabled: false, isExported: true, order: 2 })
  })

  it('제목만 고친 항목은 같은 자리의 옛 항목을 잇는다', async () => {
    const lore = await replaced([
      loreEntry('학교', '학교'),
      loreEntry('우리 집', '집'),
      loreEntry('길', '길')
    ])
    expect(lore.map((e) => e.id)).toEqual(['lore_a', 'lore_b', 'lore_c'])
    expect(lore[1]).toMatchObject({ name: '우리 집', isEnabled: false })
  })

  it('쉼표가 든 키와 앞뒤 공백이 있는 제외키는 그대로 돌려받으면 깨지지 않는다', async () => {
    const s = site()
    const raw = (await nekoWorks.readRaw(s.read, W)) as Raw
    raw.character.lorebook = [
      {
        id: 'lore_k',
        name: '키',
        content: 'k',
        keys: ['a,b', 'c'],
        negativeKeys: [' 공백 '],
        isEnabled: true,
        isExported: false,
        order: 0
      }
    ]
    const read = nekoWorks.normalize(raw).lorebook
    const next = nekoWorks.applyChanges!(raw, {
      lorebook: [{ ...read[0], content: '바뀐 본문' }]
    }) as Raw
    expect((next.character.lorebook as Obj[])[0]).toMatchObject({
      keys: ['a,b', 'c'],
      negativeKeys: [' 공백 '],
      content: '바뀐 본문'
    })
  })
})

describe('네코챗 저장: 바꾸지 않은 항목은 검사하지 않는다', () => {
  async function legacy(): Promise<Raw> {
    const s = site()
    const raw = (await nekoWorks.readRaw(s.read, W)) as Raw
    raw.character.shortDescription = ''
    raw.character.lorebook = [
      { id: 'lore_x', name: '키 없음', content: 'x', keys: [], negativeKeys: [], isEnabled: true, isExported: false, order: 0 },
      { id: 'lore_y', name: '정상', content: 'y', keys: ['정상'], negativeKeys: [], isEnabled: true, isExported: false, order: 1 }
    ]
    raw.character.greeting = ['첫째', '', '셋째']
    return raw
  }

  it('글 칸 하나만 고치면 다른 칸의 옛 빈 값 때문에 막히지 않는다', async () => {
    const raw = await legacy()
    const next = nekoWorks.applyChanges!(raw, { fields: { title: '새 제목' } }) as Raw
    expect(next.character).toMatchObject({ displayName: '새 제목', shortDescription: '' })
    // 바꾸는 칸은 여전히 본다
    expect(() => nekoWorks.applyChanges!(raw, { fields: { subtitle: '' } })).toThrow('BAD_FIELD')
  })

  it('로어북 한 항목만 고치면 키 없는 옛 항목 때문에 막히지 않는다', async () => {
    const raw = await legacy()
    const next = nekoWorks.applyChanges!(raw, {
      lorebookPatch: [{ index: 1, content: '고친 본문' }]
    }) as Raw
    const lore = next.character.lorebook as Obj[]
    expect(lore[0]).toMatchObject({ id: 'lore_x', keys: [] })
    expect(lore[1]).toMatchObject({ content: '고친 본문' })
    // 바꾼 항목이 규칙을 어기면 막는다
    expect(() =>
      nekoWorks.applyChanges!(raw, { lorebookPatch: [{ index: 1, keys: '' }] })
    ).toThrow('BAD_LOREBOOK')
    expect(() =>
      nekoWorks.applyChanges!(raw, { lorebookPatch: [{ index: 0, content: '고침' }] })
    ).toThrow('BAD_LOREBOOK')
    // 항목을 지울 때도 남은 옛 항목은 보지 않는다
    expect(
      (nekoWorks.applyChanges!(raw, { lorebookRemove: [1] }) as Raw).character.lorebook
    ).toHaveLength(1)
  })

  it('첫상황 하나만 고치면 빈 옛 첫상황 때문에 막히지 않는다', async () => {
    const raw = await legacy()
    const next = nekoWorks.applyChanges!(raw, {
      startScenarios: [{ index: 0, content: '고친 첫째' }]
    }) as Raw
    expect(next.character.greeting).toEqual(['고친 첫째', '', '셋째'])
    expect(() =>
      nekoWorks.applyChanges!(raw, { startScenarios: [{ index: 2, content: '' }] })
    ).toThrow('BAD_START')
    expect(() =>
      nekoWorks.applyChanges!(raw, { startScenarios: [{ index: 0, content: 'x'.repeat(20_001) }] })
    ).toThrow('BAD_START')
    expect(() =>
      nekoWorks.applyChanges!(raw, { startScenarios: [{ index: 0, title: '가'.repeat(101) }] })
    ).toThrow('BAD_START')
  })

  it('옛 개수가 한도를 넘어도 줄이는 저장은 되고, 더 늘리는 저장은 막힌다', async () => {
    const raw = await legacy()
    raw.character.greeting = Array.from({ length: 11 }, (_, i) => '상황 ' + i)
    const next = nekoWorks.applyChanges!(raw, { startScenariosRemove: [5] }) as Raw
    expect(next.character.greeting).toHaveLength(10)
    expect(() => nekoWorks.applyChanges!(raw, { startScenariosAdd: [{ content: 'x' }] })).toThrow(
      'START_LIMIT'
    )
  })

  it('옛 로어북이 500개를 넘어도 줄이거나 하나 고치는 저장은 되고, 더 늘리는 저장은 막힌다', async () => {
    const raw = await legacy()
    raw.character.lorebook = Array.from({ length: 501 }, (_, i) => ({
      id: 'lore_' + i,
      name: '항목' + i,
      content: '글' + i,
      keys: ['키' + i],
      negativeKeys: [],
      isEnabled: true,
      isExported: false,
      order: i
    }))
    const removed = nekoWorks.applyChanges!(raw, { lorebookRemove: [500] }) as Raw
    expect(removed.character.lorebook).toHaveLength(500)
    const patched = nekoWorks.applyChanges!(raw, {
      lorebookPatch: [{ index: 3, content: '고친 글' }]
    }) as Raw
    expect(patched.character.lorebook).toHaveLength(501)
    expect(() =>
      nekoWorks.applyChanges!(raw, { lorebookAdd: [loreEntry('새것', '새것')] })
    ).toThrow('LOREBOOK_LIMIT')
  })
})

describe('네코챗 기능 표', () => {
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
  it('열쇠 22개가 모두 있고 note는 40자 이내다', () => {
    const features = nekoWorks.features!
    expect(Object.keys(features).sort()).toEqual([...KEYS].sort())
    for (const f of Object.values(features)) expect((f.note ?? '').length).toBeLessThanOrEqual(40)
  })
  it('코드와 맞는 값: 태그는 읽기만, 캐릭터·판본은 없다', () => {
    const f = nekoWorks.features!
    expect(f.tags).toMatchObject({ read: 'yes', write: 'partial' })
    expect(f.characters).toMatchObject({ site: 'no', write: 'no' })
    expect(f.language_editions).toMatchObject({ site: 'no' })
    expect(f.versioning_review).toMatchObject({ read: 'partial', write: 'no' })
  })
  it('못 읽는 칸이 있는 기능은 read가 partial이고, 원본에 칸이 없는 것만으로 사이트에 없다고 하지 않는다', () => {
    const f = nekoWorks.features!
    // NEKO_UNSUPPORTED: 로어북 항목별 켬끔·순서, 이미지 슬롯 트리거·폴더, 첫상황 로어북 포함·수정 불가(extras 개수만)
    expect(f.lorebook).toMatchObject({ read: 'partial', write: 'partial' })
    expect(f.start_scenarios).toMatchObject({ read: 'partial', write: 'partial' })
    expect(f.situation_images).toMatchObject({ read: 'partial', write: 'partial' })
    expect(f.bgm_voice).toMatchObject({ site: 'unknown', verified: 'no' })
    expect(f.model_settings).toMatchObject({ site: 'unknown', verified: 'no' })
    // 코드에 비율 검사가 없으므로 비율 규칙을 적지 않는다
    expect(f.cover.note ?? '').not.toContain('1:1')
  })
})

describe('네코챗 숨은 설정(extras)·못 읽는 칸', () => {
  // 지어낸 값. 원본 칸 이름은 2026-11-10 원본 스냅샷의 것
  async function body(edit?: (c: Obj) => void): Promise<ReturnType<typeof nekoWorks.normalize>> {
    const s = site()
    const raw = (await nekoWorks.readRaw(s.read, W)) as { id: string; character: Obj }
    Object.assign(raw.character, {
      ownerUserId: 'user_secret_1',
      creatorHandle: 'handle_secret',
      curationTags: ['추천'],
      isActive: true,
      showCreatorProfile: true,
      showCreatorHandle: false,
      isMarketingConsent: false,
      popularity: 200,
      likeCount: 15,
      isLiked: true,
      version: 4,
      createdAt: '2026-10-01T00:00:00.000Z',
      personaTemplates: [{ title: '가' }, { title: '나' }],
      slashCommands: [],
      lorebookImportCharacterIds: ['char_1_a'],
      greetingSettings: [
        { title: '기본', includeLorebook: true, isEditable: true },
        { title: '둘', includeLorebook: false, isEditable: false }
      ]
    })
    edit?.(raw.character)
    return nekoWorks.normalize(raw)
  }

  it('원본에 있는 설정만 짧게 싣는다', async () => {
    const { extras } = await body()
    expect(extras).toEqual({
      tags: ['순애'],
      category_ids: ['romance'],
      curation_tags: ['추천'],
      character_audience: 'male',
      narration_mode: 'narrator',
      language: 'ko',
      is_nsfw: false,
      is_shared: false,
      is_active: true,
      is_marketing_consent: false,
      show_creator_handle: false,
      show_creator_profile: true,
      version: 4,
      created_at: '2026-10-01T00:00:00.000Z',
      has_cover_image: true,
      lore_budget: 50000,
      lore_disabled_count: 0,
      lore_exported_count: 0,
      lorebook_import_count: 1,
      auxiliary_prompt_count: 3,
      persona_template_count: 2,
      slash_command_count: 0,
      image_slot_count: 2,
      image_slot_hidden_count: 1,
      image_slot_trigger_count: 0,
      image_slot_folder_count: 0,
      start_scenario_lorebook_count: 1,
      start_scenario_locked_count: 1
    })
  })

  it('통계·계정 번호·본문·주소는 싣지 않는다 (null인 설정도 건너뛴다)', async () => {
    const { extras } = await body()
    const json = JSON.stringify(extras)
    for (const bad of ['popularity', 'likeCount', 'like_count', 'is_liked', 'popular'])
      expect(json).not.toContain(bad)
    for (const bad of ['user_secret_1', 'handle_secret', 'cdn.nekochat.xyz', '페르소나 본문'])
      expect(json).not.toContain(bad)
    // isIncentiveEnabled가 null인 원본: 칸을 만들지 않는다
    expect(extras).not.toHaveProperty('is_incentive_enabled')
  })

  it('조회·좋아요 통계와 수정 시각이 달라져도 extras는 그대로다 (계획 뒤 변화 감지용)', async () => {
    const first = await body()
    const later = await body((c) => {
      c.popularity = 999
      c.likeCount = 77
      c.isLiked = false
      c.updatedAt = '2026-12-01T00:00:00Z'
    })
    expect(JSON.stringify(later.extras)).toBe(JSON.stringify(first.extras))
  })

  it('긴 목록·긴 글은 개수로 줄인다', async () => {
    const many = Array.from({ length: 25 }, (_, i) => '태그' + i)
    const { extras } = await body((c) => {
      c.tags = many
      c.categoryIds = ['x'.repeat(81)]
      c.language = 'l'.repeat(81)
    })
    expect(extras).toMatchObject({ tag_count: 25, category_count: 1 })
    expect(extras).not.toHaveProperty('tags')
    expect(extras).not.toHaveProperty('category_ids')
    expect(extras).not.toHaveProperty('language')
  })

  it('못 읽는 칸을 한국어 이름으로 적고, extras로 읽는 태그는 넣지 않는다', async () => {
    const { unsupported } = await body()
    expect(unsupported).toEqual(
      expect.arrayContaining(['보조 프롬프트 내용', 'JSX 렌더러', '댓글·좋아요 통계'])
    )
    expect(unsupported!.join(' ')).not.toContain('태그')
    expect(unsupported!.join(' ')).not.toContain('캐릭터')
  })

  it('기존 칸(fields·lorebook·첫상황·공개 상태)은 그대로다', async () => {
    const b = await body()
    expect(b.fields.title).toBe('시험 작품')
    expect(b.lorebook).toHaveLength(1)
    expect(b.startScenarios).toHaveLength(3)
    expect(b.visibility).toBe('public')
    expect(b.status).toBeNull()
  })
})

describe('네코챗 로어북 전체 교체: given', () => {
  async function replacedWith(entry: Record<string, unknown>): Promise<Obj> {
    const s = site()
    const raw = (await nekoWorks.readRaw(s.read, W)) as Raw
    raw.character.lorebook = [
      {
        id: 'lore_a',
        name: '학교',
        content: 'a',
        keys: ['학교'],
        negativeKeys: ['방학', '휴일'],
        isEnabled: true,
        isExported: false,
        order: 0
      }
    ]
    const next = nekoWorks.applyChanges!(raw, {
      lorebook: [entry as unknown as LoreEntryInput]
    }) as Raw
    return (next.character.lorebook as Obj[])[0]
  }
  const whole = {
    title: '학교',
    keys: '학교',
    content: '바뀐 본문',
    mode: null,
    offKeys: [],
    turnRange: null,
    offTurnRange: null
  }

  it('given에 제외키가 없으면 짝지은 옛 항목의 제외키를 둔다', async () => {
    const lore = await replacedWith({ ...whole, given: ['title', 'keys', 'content'] })
    expect(lore).toMatchObject({ content: '바뀐 본문', negativeKeys: ['방학', '휴일'] })
  })
  it('given에 제외키가 있으면 받은 값(빈 값 포함)으로 바꾼다', async () => {
    const emptied = await replacedWith({ ...whole, given: ['title', 'content', 'offKeys'] })
    expect(emptied.negativeKeys).toEqual([])
    const set = await replacedWith({ ...whole, offKeys: ['비'], given: ['title', 'offKeys'] })
    expect(set.negativeKeys).toEqual(['비'])
  })
  it('given이 없는 옛 호출은 지금 동작 그대로다 (빈 제외키가 옛 값을 지운다)', async () => {
    const lore = await replacedWith({ ...whole })
    expect(lore.negativeKeys).toEqual([])
  })
})
