import { describe, expect, it } from 'vitest'
import { rplayApplyChanges, rplayWorks } from '../src/main/works/rplay'
import type { WorkFetch, WorkIo, WorkWrite } from '../src/main/works/types'

// 가짜 응답 모양은 2026-11-10 rplay.live 편집기 스크립트에서 읽은 필드를 따른다
// (chat-content의 canvasOid·status·isPrivate, localization 응답 {storyChat:{localization:{revision, sourceLanguage}}},
//  chat-canvas 응답 {canvas:{nodes, connections}, metadataSet}, 노드 metadata의 title·coreContext·prologue·entries,
//  metadata 만들기 응답 = 새 metadata 문서(_id), 저장 응답 {storyChat}, getuser의 work_in_progress_storyChat·publishedStoryChat).
type Obj = Record<string, unknown>
const hx = (n: number): string => '65f0a1b2c3d4e5f6' + n.toString(16).padStart(8, '0')
const ME = hx(1)
const W = hx(100)
const CANVAS = hx(200)
const S1 = hx(301)
const S2 = hx(302)
const C1 = hx(311)
const L1 = hx(321)
const API = 'https://api.rplay.live'
const CHAT = 'https://chat-api.rplay.live/story-chat'
const ACCOUNT = { oid: ME, loginType: 'rplay' }
// 만든 시각이 더 늦은 작업 중 작품 (번호 앞 8자리가 시각)
const DRAFT = '66000000c3d4e5f600000065'

function state(): Obj {
  return {
    content: {
      _id: W,
      creatorOid: ME,
      canvasOid: CANVAS,
      title: '시험 작품',
      simpleIntro: '짧은 소개',
      description: '상세 설명',
      status: 'published',
      isPrivate: false,
      modified: '2026-11-01T00:00:00Z'
    },
    loc: {
      _id: W,
      title: '시험 작품',
      simpleIntro: '짧은 소개',
      description: '상세 설명',
      localization: { revision: 3, sourceLanguage: 'ko', enabled: false }
    },
    canvas: {
      _id: CANVAS,
      needsCompilation: false,
      nodes: [
        {
          uid: 'u-s2',
          type: 'story',
          metadataOid: S2,
          hash: 'aaaaa',
          coordinates: { x: 100, y: 300 }
        },
        {
          uid: 'u-s1',
          type: 'story',
          metadataOid: S1,
          hash: 'bbbbb',
          coordinates: { x: 100, y: 100 }
        },
        {
          uid: 'u-c1',
          type: 'character',
          metadataOid: C1,
          hash: 'ccccc',
          coordinates: { x: 700, y: 100 }
        },
        {
          uid: 'u-l1',
          type: 'lorebook',
          metadataOid: L1,
          hash: 'ddddd',
          coordinates: { x: 1300, y: 100 }
        },
        { uid: 'u-old', type: 'story', metadataOid: hx(399), deleted: true }
      ],
      connections: [
        {
          uid: 'k1',
          sourceNodeId: 'u-c1',
          targetNodeId: 'u-s1',
          connectionType: 'character',
          targetInputIndex: 1
        },
        {
          uid: 'k2',
          sourceNodeId: 'u-l1',
          targetNodeId: 'u-s1',
          connectionType: 'lorebook',
          targetInputIndex: 3
        },
        {
          uid: 'k3',
          sourceNodeId: 'u-c1',
          targetNodeId: 'u-s2',
          connectionType: 'character',
          targetInputIndex: 1
        }
      ]
    },
    meta: {
      [S1]: {
        _id: S1,
        type: 'story',
        title: '첫 이야기',
        sort: 0,
        isStart: true,
        useTokenBlock: true,
        coreContext: '메인 프롬프트',
        prologue: '시작 메시지',
        prologueGuide: '이어쓰기 지침',
        creatorNotice: '공지',
        text: '참고 자료'
      },
      [S2]: {
        _id: S2,
        type: 'story',
        title: '둘째 이야기',
        sort: 1,
        isStart: true,
        useTokenBlock: true,
        coreContext: '둘째 프롬프트',
        prologue: '둘째 시작'
      },
      [C1]: {
        _id: C1,
        type: 'character',
        name: '하나',
        coreContext: '핵심',
        text: '상세',
        imageUrl: 'https://pb3.rplay.live/x/ccccc.webp',
        image: 'ccccc'
      },
      [L1]: {
        _id: L1,
        type: 'lorebook',
        title: '장소',
        entries: [
          {
            key: '학교|교실',
            patterns: ['학교', '교실'],
            text: '학교 설명',
            tokenCount: 5,
            priority: 2,
            durationTurns: 3,
            activationMode: 'keyword'
          },
          {
            key: '',
            patterns: [],
            text: '늘 켜짐',
            priority: 1,
            durationTurns: 1,
            activationMode: 'always'
          }
        ]
      }
    }
  }
}

const ok = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** 알플레이 흉내: 받은 요청을 상태에 반영한다 */
function site(opts: { account?: boolean; hashes?: string[] } = {}): {
  io: WorkIo
  read: WorkFetch
  write: WorkWrite
  calls: string[]
  bodies: Obj[]
  s: Obj
} {
  const calls: string[] = []
  const bodies: Obj[] = []
  const works: Record<string, Obj> = { [W]: state() }
  let next = 500
  const withAccount = <T extends object>(fn: T): T =>
    opts.account === false ? fn : Object.assign(fn, { rplayAccount: () => ACCOUNT })
  const of = (id: string): Obj => {
    const w = works[id]
    if (!w) throw new Error('no work ' + id)
    return w
  }
  const read: WorkFetch = withAccount(async (url: string) => {
    calls.push('GET ' + url)
    if (!rplayWorks.readAllowed(url)) throw new Error('UNAPPROVED_READ_ROUTE ' + url)
    const u = new URL(url)
    const q = u.searchParams
    if (u.pathname === '/account/getuser')
      return ok({ work_in_progress_storyChat: [DRAFT], publishedStoryChat: [W, W, 'bad'] })
    if (u.pathname === '/story-chat/chat-content') {
      const w = works[q.get('contentOid')!]
      if (!w) return ok({ error: 'not-found' }, 404)
      return ok(w.content)
    }
    if (u.pathname.startsWith('/story-chat/localization/'))
      return ok({ storyChat: of(u.pathname.split('/').pop()!).loc })
    if (u.pathname === '/story-chat/chat-canvas') {
      const w = Object.values(works).find((x) => (x.canvas as Obj)._id === q.get('canvasOid'))!
      return ok({ canvas: w.canvas, metadataSet: w.meta })
    }
    if (u.pathname === '/story-chat/image-hashes') return ok({ hashes: opts.hashes ?? ['zzzzz'] })
    return ok({}, 404)
  })
  const write: WorkWrite = withAccount(async (method: string, url: string, body?: unknown) => {
    calls.push(method + ' ' + url)
    if (!rplayWorks.writeAllowed!(method, url)) throw new Error('UNAPPROVED_WRITE_ROUTE ' + url)
    const b = (body ?? {}) as Obj
    bodies.push(b)
    const u = new URL(url)
    if (u.pathname === '/story-chat/chat-content') {
      if (b.requestType === 'create') {
        const id = hx(next++)
        const canvas = hx(next++)
        works[id] = {
          content: { _id: id, canvasOid: canvas, status: 'wip', creatorOid: ME },
          loc: { _id: id, localization: { revision: 0, sourceLanguage: 'ko' } },
          canvas: { _id: canvas, nodes: [], connections: [] },
          meta: {}
        }
        return ok({ storyChat: { _id: id, canvasOid: canvas } })
      }
      if (b.requestType === 'delete') {
        if (b.userOid !== ME) return ok({ error: 'forbidden' }, 403)
        ;(of(b.contentOid as string).content as Obj).deleted = true
        return ok({ success: true })
      }
      const data = b.data as Obj
      const w = of(data._id as string)
      Object.assign(w.content as Obj, data)
      return ok({ storyChat: w.content })
    }
    const w = Object.values(works).find((x) => (x.canvas as Obj)._id === b.canvasOid)
    if (u.pathname === '/story-chat/chat-canvas/metadata') {
      const meta = w!.meta as Record<string, Obj>
      if (b.schemaType === 'story-sort') {
        for (const s of (b.update as Obj).sortUpdates as Obj[])
          meta[s.metadataOid as string].sort = s.sort
        return ok({ success: true })
      }
      if (b.oid === null) {
        const id = hx(next++)
        meta[id] = { _id: id, ...(b.update as Obj), version: 1 }
        return ok(meta[id])
      }
      const { version, ...rest } = b.update as Obj
      void version
      Object.assign(meta[b.oid as string], rest)
      return ok({ validatedUpdate: rest })
    }
    if (u.pathname === '/story-chat/chat-canvas') {
      const c = w!.canvas as Obj
      const d = b.updateData as Obj
      c.nodes = d.nodes
      c.connections = d.connections
      c.needsCompilation = true
      return ok({ success: true })
    }
    if (u.pathname.endsWith('/edit')) {
      const loc = of(u.pathname.split('/')[3]).loc as Obj
      const l = loc.localization as Obj
      if (b.revision !== l.revision) return ok({ error: 'LOCALIZATION_MANUAL_CONFLICT' }, 409)
      for (const p of b.patches as Obj[]) {
        if (p.language !== l.sourceLanguage) continue
        loc[p.field as string] = p.value
      }
      l.revision = (l.revision as number) + 1
      return ok({ storyChat: loc })
    }
    return ok({}, 404)
  })
  return { io: { read, write, send: async () => ok({}) }, read, write, calls, bodies, s: works }
}

describe('알플레이 허용 주소', () => {
  it('편집기가 쓰는 주소와 쿼리만 허용한다', () => {
    const r = rplayWorks.readAllowed
    const acct = '&platformType=rplay&lang=ko&requestorOid=' + ME + '&loginType=rplay'
    const opts =
      '&options=' + encodeURIComponent('{"withIsCompiling":true,"preferMainCanvas":true}')
    expect(r(CHAT + '/chat-content?contentOid=' + W + opts + '&omitComments=true' + acct)).toBe(
      true
    )
    // 계정 값 없이도 (공용 코드가 계정을 아직 넘기지 않을 때)
    expect(
      r(
        CHAT +
          '/chat-content?contentOid=' +
          W +
          opts +
          '&omitComments=true&platformType=rplay&lang=ko'
      )
    ).toBe(true)
    expect(
      r(
        CHAT +
          '/chat-content?contentOid=' +
          W +
          '&options=%7B%22withComments%22%3Atrue%7D&omitComments=true' +
          acct
      )
    ).toBe(false)
    expect(r(CHAT + '/chat-content?contentOid=abc' + opts + '&omitComments=true' + acct)).toBe(
      false
    )
    expect(
      r(
        CHAT +
          '/chat-content?contentOid=' +
          W +
          opts +
          '&omitComments=true&platformType=rplay&lang=ko&requestorOid=' +
          ME
      )
    ).toBe(false)
    expect(r(CHAT + '/chat-canvas?canvasOid=' + CANVAS + '&includeMetadata=true' + acct)).toBe(true)
    expect(r(CHAT + '/chat-canvas?canvasOid=' + CANVAS + '&includeMetadata=true&x=1' + acct)).toBe(
      false
    )
    expect(r(CHAT + '/chat-canvas/export?canvasOid=' + CANVAS + acct)).toBe(false)
    expect(r(CHAT + '/localization/' + W + '?platformType=rplay&lang=ko')).toBe(true)
    expect(r(CHAT + '/localization/' + W + '/edit?platformType=rplay&lang=ko')).toBe(false)
    expect(r(CHAT + '/image-hashes?contentOid=' + W + acct)).toBe(true)
    expect(
      r(
        API +
          '/account/getuser?userOid=' +
          ME +
          '&filter[]=work_in_progress_storyChat&filter[]=publishedStoryChat' +
          acct
      )
    ).toBe(true)
    expect(r(API + '/account/getuser?userOid=' + ME + '&filter[]=email' + acct)).toBe(false)
    expect(r(API + '/account/getuser?userOid=' + ME + acct)).toBe(false)
    expect(
      r(
        'https://api.storyengine.live/story-chat/chat-canvas?canvasOid=' +
          CANVAS +
          '&includeMetadata=true' +
          acct
      )
    ).toBe(false)

    const w = rplayWorks.writeAllowed!
    expect(w('POST', CHAT + '/chat-content')).toBe(true)
    expect(w('POST', CHAT + '/chat-canvas')).toBe(true)
    expect(w('POST', CHAT + '/chat-canvas/metadata')).toBe(true)
    expect(w('POST', CHAT + '/localization/' + W + '/edit')).toBe(true)
    expect(w('POST', CHAT + '/localization/' + W + '/reserve')).toBe(false)
    expect(w('POST', CHAT + '/chat-canvas/import')).toBe(false)
    expect(w('POST', CHAT + '/compile-node')).toBe(false)
    expect(w('POST', CHAT + '/chat-content?x=1')).toBe(false)
    expect(w('PUT', CHAT + '/chat-content')).toBe(false)
    expect(w('POST', 'https://api.rplay.live/content/comment')).toBe(false)
    expect(rplayWorks.sendRule).toBeUndefined()
  })
})

describe('알플레이 읽기', () => {
  it('목록: 작업 중·업로드 묶음을 겹침 없이 최신순으로', async () => {
    const s = site()
    ;(s.s as Record<string, Obj>)[DRAFT] = {
      ...state(),
      content: { _id: DRAFT, canvasOid: hx(201), title: '초안', status: 'wip' }
    }
    const works = await rplayWorks.list(s.read)
    expect(works.map((w) => [w.id, w.title, w.visibility, w.status])).toEqual([
      [DRAFT, '초안', 'private', 'wip'],
      [W, '시험 작품', 'public', 'published']
    ])
    expect(s.calls[0]).toContain('filter[]=work_in_progress_storyChat&filter[]=publishedStoryChat')
    await expect(rplayWorks.list(site({ account: false }).read)).rejects.toThrow(
      'RPLAY_ACCOUNT_REQUIRED'
    )
  })

  it('작품 정보 → 언어 상태 → 캔버스 순서로 읽어 공통 모양으로 옮긴다', async () => {
    const s = site()
    const body = rplayWorks.normalize(await rplayWorks.readRaw(s.read, W))
    expect(s.calls.map((c) => c.split('?')[0])).toEqual([
      'GET ' + CHAT + '/chat-content',
      'GET ' + CHAT + '/localization/' + W,
      'GET ' + CHAT + '/chat-canvas'
    ])
    expect(body.fields).toEqual({
      title: '시험 작품',
      subtitle: '짧은 소개',
      description: '상세 설명',
      main: '메인 프롬프트',
      creator_comment: '공지'
    })
    expect(body.visibility).toBe('public')
    // 스토리는 표기 순서(sort)대로, 지운 노드는 빼고
    expect(
      body.startScenarios.map((x) => [x.id, x.title, x.isDefault, x.content, x.subPrompt])
    ).toEqual([
      ['u-s1', '첫 이야기', true, '시작 메시지', ''],
      ['u-s2', '둘째 이야기', false, '둘째 시작', '둘째 프롬프트']
    ])
    expect(body.startScenarios[0]).toMatchObject({
      situation: '이어쓰기 지침',
      description: '참고 자료'
    })
    expect(body.characters).toEqual([
      {
        id: 'u-c1',
        name: '하나',
        isMain: false,
        order: null,
        details: '상세',
        info: '핵심',
        imageCount: 1
      }
    ])
    expect(body.lorebook).toEqual([
      {
        title: '장소',
        keys: '학교, 교실',
        content: '학교 설명',
        mode: 'keyword',
        offKeys: [],
        turnRange: 3,
        offTurnRange: null
      },
      {
        title: '장소',
        keys: '',
        content: '늘 켜짐',
        mode: 'always',
        offKeys: [],
        turnRange: 1,
        offTurnRange: null
      }
    ])
    expect(rplayWorks.imageGroups!(await rplayWorks.readRaw(s.read, W))[0]).toMatchObject({
      character: 0,
      images: [{ url: 'https://pb3.rplay.live/x/ccccc.webp', isDefault: true }]
    })
    await expect(rplayWorks.readRaw(s.read, 'abc')).rejects.toThrow('BAD_WORK_ID')
  })
})

describe('알플레이 고치기', () => {
  it('노드 내용·새 노드·구조·제목을 편집기 순서로 저장하고 다시 읽으면 같다', async () => {
    const s = site()
    const raw = await rplayWorks.readRaw(s.read, W)
    const next = rplayWorks.applyChanges!(raw, {
      fields: { title: '새 제목', main: '새 메인' },
      startScenarios: [{ index: 1, content: '둘째 새 시작', subPrompt: '둘째 새 프롬프트' }],
      startScenariosAdd: [{ title: '셋째', content: '셋째 시작', subPrompt: '셋째 프롬프트' }],
      characters: [{ index: 0, info: '새 핵심' }],
      charactersAdd: [{ name: '두리', details: '두리 상세' }],
      lorebookPatch: [{ index: 0, keys: '학교, 강당', turnRange: 2 }],
      lorebookRemove: [1],
      lorebookAdd: [
        {
          title: '사건',
          keys: '비',
          content: '비 오는 날',
          mode: null,
          offKeys: [],
          turnRange: null,
          offTurnRange: null
        }
      ]
    })
    const expected = rplayWorks.normalize(next)
    s.calls.length = 0
    await rplayWorks.save!(s.write, W, next, s.io)
    const posts = s.calls.filter((c) => c.startsWith('POST')).map((c) => c.slice(5 + CHAT.length))
    expect(posts).toEqual([
      '/chat-canvas/metadata', // 첫 스토리 coreContext
      '/chat-canvas/metadata', // 둘째 스토리
      '/chat-canvas/metadata', // 인물
      '/chat-canvas/metadata', // 매크로 항목
      '/chat-canvas/metadata', // 새 스토리 만들기
      '/chat-canvas/metadata', // 새 인물 만들기
      '/chat-canvas/metadata', // 새 매크로 노드 만들기
      '/chat-canvas', // 노드·연결 (새 노드가 캔버스에 들어간 뒤에 내용을 채운다)
      '/chat-canvas/metadata', // 새 스토리 내용
      '/chat-canvas/metadata', // 새 인물 내용
      '/chat-canvas/metadata', // 새 매크로 노드 내용
      '/chat-canvas/metadata', // story-sort
      '/localization/' + W + '/edit'
    ])
    // 새 인물 해시를 이미지 해시와 견줘 본 뒤에 쓴다
    expect(s.calls[0]).toContain('/image-hashes?contentOid=' + W)
    // 있던 노드는 캔버스 순서대로 (둘째 스토리 노드가 캔버스에서 먼저다)
    expect(s.bodies.slice(0, 4).map((b) => b.oid)).toEqual([S2, S1, C1, L1])
    const first = s.bodies[1]
    expect(first).toMatchObject({
      oid: S1,
      schemaType: 'story',
      update: { coreContext: '새 메인' },
      canvasOid: CANVAS,
      needsCompilation: true,
      imageCountDelta: 0,
      platformType: 'rplay',
      requestorOid: ME,
      loginType: 'rplay'
    })
    expect(Object.keys(first.update as Obj).sort()).toEqual(['coreContext', 'version'])
    expect(s.bodies[4]).toMatchObject({
      oid: null,
      schemaType: null,
      update: { type: 'story', isStart: true, useTokenBlock: true }
    })
    const canvas = s.bodies[7]
    expect(canvas).toMatchObject({
      requestType: 'update',
      canvasOid: CANVAS,
      loadMetadata: false,
      returnNewCanvas: false
    })
    const data = canvas.updateData as Obj
    expect((data.dirtyMetadataIds as string[]).length).toBe(7)
    expect((data.nodes as Obj[]).filter((n) => String(n.metadataOid).startsWith('new:'))).toEqual(
      []
    )
    // 새 스토리는 첫 스토리로 들어오던 연결(인물·매크로)을 받고, 새 인물·새 매크로는 모든 스토리에 이어진다
    const conns = data.connections as Obj[]
    const story3 = (data.nodes as Obj[]).find(
      (n) => n.type === 'story' && !['u-s1', 'u-s2', 'u-old'].includes(n.uid as string)
    )!
    expect(conns.filter((c) => c.targetNodeId === story3.uid).length).toBe(4)
    expect(s.bodies[11]).toMatchObject({ schemaType: 'story-sort' })
    expect(s.bodies[12]).toMatchObject({
      revision: 3,
      patches: [{ language: 'ko', field: 'title', value: '새 제목' }]
    })

    const after = rplayWorks.normalize(await rplayWorks.readRaw(s.read, W))
    expect({ ...after, updatedAt: null }).toEqual({ ...expected, updatedAt: null })
    expect(after.startScenarios.map((x) => x.title)).toEqual(['첫 이야기', '둘째 이야기', '셋째'])
    expect(after.lorebook.map((e) => [e.title, e.keys, e.turnRange])).toEqual([
      ['장소', '학교, 강당', 2],
      ['사건', '비', 1]
    ])
  })

  it('시작 상황·캐릭터 지우기와 공개 여부', async () => {
    const s = site()
    const raw = await rplayWorks.readRaw(s.read, W)
    const next = rplayWorks.applyChanges!(raw, {
      visibility: 'private',
      startScenariosRemove: [1],
      charactersRemove: [0]
    })
    s.calls.length = 0
    await rplayWorks.save!(s.write, W, next, s.io)
    const canvas = s.bodies.find((b) => b.requestType === 'update')!
    const data = canvas.updateData as Obj
    expect((data.nodes as Obj[]).map((n) => n.uid)).toEqual(['u-s1', 'u-l1', 'u-old'])
    expect(data.connections).toEqual([
      {
        uid: 'k2',
        sourceNodeId: 'u-l1',
        targetNodeId: 'u-s1',
        connectionType: 'lorebook',
        targetInputIndex: 3
      }
    ])
    expect(s.bodies.at(-1)).toMatchObject({
      requestType: 'save',
      data: { _id: W, isPrivate: true }
    })
    const after = rplayWorks.normalize(await rplayWorks.readRaw(s.read, W))
    expect(after.visibility).toBe('private')
    expect(after.characters).toEqual([])
    expect(after.startScenarios).toHaveLength(1)
  })

  it('편집기 규칙', async () => {
    const raw = await rplayWorks.readRaw(site().read, W)
    const change = (c: Parameters<typeof rplayApplyChanges>[1]): unknown =>
      rplayApplyChanges(raw, c)
    expect(() => change({ visibility: 'link' })).toThrow('BAD_VISIBILITY')
    expect(() => change({ fields: { title: ' ' } })).toThrow('BAD_FIELD')
    expect(() => change({ fields: { subtitle: '가'.repeat(41) } })).toThrow('BAD_FIELD')
    expect(() => change({ fields: { creator_comment: '가'.repeat(501) } })).toThrow('BAD_FIELD')
    expect(() => change({ fields: { persistent_context: 'x' } })).toThrow('BAD_FIELD')
    expect(() => change({ startScenariosRemove: [0] })).toThrow('KEEP_DEFAULT')
    expect(() => change({ startScenarios: [{ index: 0, subPrompt: 'x' }] })).toThrow('BAD_CHANGES')
    expect(() => change({ startScenarios: [{ index: 1, dialogue: 'x' }] })).toThrow('BAD_CHANGES')
    expect(() => change({ startScenarios: [{ index: 1, title: '' }] })).toThrow('BAD_START')
    expect(() => change({ lorebookPatch: [{ index: 0, title: '다른 노드' }] })).toThrow(
      'BAD_LOREBOOK'
    )
    expect(() => change({ lorebookPatch: [{ index: 0, turnRange: 6 }] })).toThrow('BAD_LOREBOOK')
    expect(() => change({ lorebookPatch: [{ index: 0, offKeys: ['x'] }] })).toThrow('BAD_LOREBOOK')
    expect(() => change({ lorebookPatch: [{ index: 0, keys: 'a,b,c,d,e,f' }] })).toThrow(
      'BAD_LOREBOOK'
    )
    expect(() => change({ characters: [{ index: 0, name: ' ' }] })).toThrow('EMPTY_FIELD')
    // 업로드 전 작품은 여기서 공개하지 않는다
    const draft = structuredClone(raw) as { content: Obj }
    draft.content.status = 'wip'
    expect(() => rplayApplyChanges(draft, { visibility: 'public' })).toThrow('NOT_PUBLISHED')
    // 전체 교체: 같은 노드 이름이면 앞에서부터 고친다
    const whole = rplayWorks.normalize(
      change({
        lorebook: [
          {
            title: '장소',
            keys: '학교',
            content: 'A',
            mode: null,
            offKeys: [],
            turnRange: null,
            offTurnRange: null
          }
        ]
      })
    )
    expect(whole.lorebook).toEqual([
      {
        title: '장소',
        keys: '학교',
        content: 'A',
        mode: 'keyword',
        offKeys: [],
        turnRange: 1,
        offTurnRange: null
      }
    ])
  })

  it('계정이 없거나 해시가 겹치면 쓰지 않는다', async () => {
    const plain = site({ account: false })
    const raw = await rplayWorks.readRaw(plain.read, W)
    const next = rplayWorks.applyChanges!(raw, { fields: { main: 'x' } })
    await expect(rplayWorks.save!(plain.write, W, next, plain.io)).rejects.toThrow(
      'RPLAY_ACCOUNT_REQUIRED'
    )
    const s = site()
    const raw2 = await rplayWorks.readRaw(s.read, W)
    const added = rplayWorks.applyChanges!(raw2, { charactersAdd: [{ name: '셋' }] }) as {
      canvas: { nodes: Obj[] }
    }
    const hash = added.canvas.nodes.at(-1)!.hash as string
    const clash = site({ hashes: [hash] })
    clash.calls.length = 0
    await expect(rplayWorks.save!(clash.write, W, added, clash.io)).rejects.toThrow(
      'HASH_COLLISION'
    )
    expect(clash.calls.filter((c) => c.startsWith('POST'))).toEqual([])
  })

  it('삭제는 requestType delete와 내 계정 번호', async () => {
    const s = site()
    await rplayWorks.remove!(s.write, W, s.io)
    expect(s.bodies[0]).toMatchObject({ requestType: 'delete', userOid: ME, contentOid: W })
    await expect(rplayWorks.readRaw(s.read, W)).rejects.toThrow('WORK_NOT_FOUND')
    const otp: WorkWrite = Object.assign(async () => ok({ code: 'OTP_REQUIRED' }, 403), {
      rplayAccount: () => ACCOUNT
    })
    await expect(rplayWorks.remove!(otp, W)).rejects.toThrow('OTP_REQUIRED')
  })
})

describe('알플레이 새 작품', () => {
  const draft = {
    title: '새 작품',
    main: '메인',
    adult: true,
    subtitle: '소개',
    hashtags: ['#순애', '순애', '학원'],
    characters: [{ name: '하나', info: '핵심' }],
    startScenarios: [{ title: '시작', content: '첫 메시지' }],
    lorebook: [
      {
        title: '규칙',
        keys: '',
        content: '항상',
        mode: 'always',
        offKeys: [],
        turnRange: null,
        offTurnRange: null
      }
    ]
  }

  it('빈 스토리챗을 만들고 비공개로 둔 뒤 노드를 채운다', async () => {
    const s = site()
    const id = await rplayWorks.create!(s.write, draft, s.read, s.io)
    expect(s.bodies[0]).toMatchObject({ requestType: 'create', isLiteMode: false })
    expect(s.bodies[1]).toMatchObject({
      requestType: 'save',
      data: { _id: id, isPrivate: true, isAdultContent: true, hashtags: ['순애', '학원'] }
    })
    const body = rplayWorks.normalize(await rplayWorks.readRaw(s.read, id))
    expect(body.title).toBe('새 작품')
    expect(body.visibility).toBe('private')
    expect(body.fields.main).toBe('메인')
    expect(body.startScenarios.map((x) => [x.title, x.content])).toEqual([['시작', '첫 메시지']])
    expect(body.characters.map((c) => [c.name, c.info])).toEqual([['하나', '핵심']])
    expect(body.lorebook.map((e) => [e.title, e.mode])).toEqual([['규칙', 'always']])
  })

  it('규격을 먼저 본다', () => {
    rplayWorks.checkDraft!(draft)
    expect(() => rplayWorks.checkDraft!({ ...draft, title: '' })).toThrow('BAD_DRAFT')
    expect(() => rplayWorks.checkDraft!({ ...draft, categories: ['a'] })).toThrow('BAD_DRAFT')
    expect(() => rplayWorks.checkDraft!({ ...draft, subtitle: '가'.repeat(41) })).toThrow(
      'BAD_FIELD'
    )
    expect(() =>
      rplayWorks.checkDraft!({ ...draft, startScenarios: [{ content: 'x', dialogue: 'y' }] })
    ).toThrow('BAD_CHANGES')
  })
})
