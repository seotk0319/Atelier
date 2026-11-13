import { describe, expect, it } from 'vitest'
import { rplayApplyChanges, rplayWorks } from '../src/main/works/rplay'
import type { LoreEntry, WorkFetch, WorkIo, WorkWrite } from '../src/main/works/types'

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
    // 캔버스 내보내기는 열었다 (rplay-canvas.ts, 자세한 시험은 works-rplay-canvas.test.ts)
    expect(r(CHAT + '/chat-canvas/export?canvasOid=' + CANVAS + acct)).toBe(true)
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
    expect(w('POST', CHAT + '/chat-canvas/import')).toBe(true)
    expect(w('POST', CHAT + '/compile-node')).toBe(false)
    expect(w('POST', CHAT + '/chat-content?x=1')).toBe(false)
    expect(w('PUT', CHAT + '/chat-content')).toBe(false)
    expect(w('POST', 'https://api.rplay.live/content/comment')).toBe(false)
    // 파일 보내기는 API가 이번에 내준 업로드 주소만 (아직 받은 주소가 없으면 아무것도)
    expect(rplayWorks.sendRule!('PUT', 'https://bucket.example.com/x.json')).toBeNull()
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
    // 전체 교체: 제목이 같은 옛 항목과 짝지어 고친다. 안 준 값(null)은 옛 값 그대로 (예전에는 keyword·1턴으로 되돌렸다)
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
        turnRange: 3,
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

// 바꾸려던 칸만 바뀌고 나머지는 원본 그대로 가는지 (모든 값은 지어낸 것)
type Raw = {
  content: Obj
  localization: Obj
  canvas: { nodes: Obj[]; connections: Obj[] }
  metadataSet: Record<string, Obj>
}
const metaOf = (raw: unknown, oid: string): Obj => (raw as Raw).metadataSet[oid]

describe('알플레이 기능 표·숨은 설정·못 읽는 칸', () => {
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
  const U1 = hx(331)
  const readRaw = async (): Promise<Raw> => {
    const s = site()
    return (await rplayWorks.readRaw(s.read, W)) as unknown as Raw
  }

  it('기능 표는 22개 열쇠를 다 갖고 note는 40자 이내다', () => {
    const features = rplayWorks.features!
    expect(Object.keys(features).sort()).toEqual([...KEYS].sort())
    for (const f of Object.values(features)) expect((f.note ?? '').length).toBeLessThanOrEqual(40)
    expect(features.tags).toMatchObject({ read: 'yes', write: 'partial' })
    expect(features.cover).toMatchObject({ read: 'partial', write: 'blocked' })
    expect(features.versioning_review).toMatchObject({ read: 'no', write: 'blocked' })
    // extras가 개수·글자 수를 읽는 칸은 "no"가 아니다
    expect(features.user_persona.read).toBe('partial')
    expect(features.example_dialogue.read).toBe('partial')
    expect(features.language_editions).toMatchObject({ read: 'partial', write: 'no' })
    expect(features.output_rules.site).toBe('no')
  })

  it('원본에 없는 칸은 싣지 않는다', async () => {
    const body = rplayWorks.normalize(await readRaw())
    expect(body.extras).toEqual({
      localization_enabled: false,
      source_language: 'ko',
      later_story_creator_notice_count: 0,
      user_node_count: 0,
      user_text_length: 0,
      image_node_count: 0
    })
  })

  it('짧은 값은 그대로, 긴 글은 글자 수, 목록은 개수로 싣고 본문·통계는 싣지 않는다', async () => {
    const raw = await readRaw()
    Object.assign(raw.content, {
      hashtags: ['태그가', '태그나'],
      generatedHashtags: [],
      isAdultContent: true,
      advancedSettings: { liteMode: false, promptInputExpansionSteps: 6, memo: '문자열은 뺀다' },
      promptInputExpansionSteps: 6,
      thumbnailAsset: { s3Key: 'thumbnail/x.webp', name: '표지 파일' },
      introVideo: null,
      isCanvasPublic: false,
      price: 0,
      onlyForSubscribers: false,
      isOriginalStory: false,
      originalStoryLockedUntil: null,
      collaborators: { a: {} },
      blocked: { isBlocked: false, reason: '' },
      achievements: [{}, {}],
      needsCompilation: true,
      compiled: { version: 2, error: false },
      publishedAt: '2026-01-02T00:00:00.000Z',
      multiLangCanvases: { ko: CANVAS, en: hx(299) },
      mainCanvasLanguage: 'ko',
      // 통계: 읽을 때마다 달라져 계획이 낡은 것으로 보이게 하므로 싣지 않는다
      likes: 12,
      chatCount: 99,
      numComments: 3
    })
    Object.assign(raw.canvas, {
      compilerVersion: 3,
      imageTaggingMethod: 2,
      useKRJPGuidelines: true,
      embeddingModel: 'test/embed-model',
      compiledDate: '2026-01-01T00:00:00.000Z',
      characterSpeechStyles: { a: 1, b: 2 }
    })
    ;(raw.canvas.nodes as Obj[]).push({ uid: 'u-user', type: 'user', metadataOid: U1 })
    raw.metadataSet[U1] = { _id: U1, type: 'user', text: '가나다라마' }
    Object.assign(metaOf(raw, S1), {
      plotSummary: '줄거리 글',
      presetNoteNodes: [],
      statusViewNodes: [{}, {}],
      achievementNodes: [{}]
    })
    metaOf(raw, S2).creatorNotice = '둘째 공지'
    Object.assign(metaOf(raw, C1), {
      simplifiedIntro: '짧은 소개 글',
      startingDialogue: '',
      hoverDescription: '호버 글',
      hiddenInPreview: true
    })
    ;(raw.localization.localization as Obj).entries = { ko: {}, en: {} }
    const body = rplayWorks.normalize(raw)
    expect(body.extras).toEqual({
      hashtag_count: 2,
      hashtags: ['태그가', '태그나'],
      is_adult_content: true,
      advanced_settings: { liteMode: false, promptInputExpansionSteps: 6 },
      prompt_input_expansion_steps: 6,
      canvas_compiler_version: 3,
      image_tagging_method: 2,
      use_kr_jp_guidelines: true,
      embedding_model: 'test/embed-model',
      has_thumbnail: true,
      has_intro_video: false,
      is_canvas_public: false,
      only_for_subscribers: false,
      price: 0,
      is_original_story: false,
      collaborator_count: 1,
      is_blocked: false,
      achievement_count: 2,
      published_at: '2026-01-02T00:00:00.000Z',
      localization_enabled: false,
      source_language: 'ko',
      localization_languages: ['ko', 'en'],
      canvas_languages: ['ko', 'en'],
      main_canvas_language: 'ko',
      story_preset_note_count: 0,
      story_status_view_count: 2,
      story_achievement_node_count: 1,
      story_plot_summary_count: 1,
      later_story_creator_notice_count: 1,
      character_simplified_intro_count: 1,
      character_hover_description_count: 1,
      character_starting_dialogue_count: 0,
      character_hidden_in_preview_count: 1,
      user_node_count: 1,
      user_text_length: 5,
      image_node_count: 0,
      character_speech_style_count: 2
    })
    // 본문·계정 번호·표지 파일 이름·통계는 어디에도 없다
    const dump = JSON.stringify(body.extras)
    for (const leaked of ['메인 프롬프트', '상세 설명', '가나다라마', '둘째 공지', '표지 파일', ME, 'thumbnail/x'])
      expect(dump).not.toContain(leaked)
    for (const k of ['likes', 'chat_count', 'num_comments']) expect(body.extras).not.toHaveProperty(k)
    // 컴파일 상태·시각과 사이트가 만든 해시태그 수는 사이트가 계획과 저장 사이에 바꾸므로 싣지 않는다
    for (const k of [
      'needs_compilation',
      'compiled_version',
      'compile_error',
      'compiled_at',
      'generated_hashtag_count'
    ])
      expect(body.extras).not.toHaveProperty(k)
  })

  it('긴 목록·긴 글은 개수만 싣고 못 읽는 칸을 안내한다', async () => {
    const raw = await readRaw()
    raw.content.hashtags = Array.from({ length: 25 }, (_, i) => '태그' + i)
    raw.content.originalStoryLockedUntil = '가'.repeat(81)
    ;(raw.canvas as Obj).embeddingModel = '나'.repeat(81)
    const body = rplayWorks.normalize(raw)
    expect(body.extras).toMatchObject({ hashtag_count: 25 })
    for (const k of ['hashtags', 'original_story_locked_until', 'embedding_model'])
      expect(body.extras).not.toHaveProperty(k)
    expect(body.unsupported).toEqual(expect.arrayContaining(['댓글', '통계(좋아요·대화 수)', '수정 시각']))
    // 읽게 된 칸은 못 읽는 칸에 없다
    for (const readable of ['태그', '해시태그', '성인 표시', '고급 설정', '작품 고급 설정'])
      expect(body.unsupported).not.toContain(readable)
  })

  it('extras·unsupported를 더해도 계획이 보는 칸과 바뀐 뒤 값은 달라지지 않는다', async () => {
    const raw = await readRaw()
    const before = rplayWorks.normalize(raw)
    const next = rplayApplyChanges(raw, { fields: { title: '새 제목' } })
    const after = rplayWorks.normalize(next)
    expect(after.extras).toEqual(before.extras)
    expect(after.unsupported).toEqual(before.unsupported)
    expect(after.fields.title).toBe('새 제목')
    expect(after.lorebook).toEqual(before.lorebook)
  })

  it('사이트가 읽는 사이에 바꾸는 값(컴파일 상태·시각·통계·생성 태그)이 달라도 계획이 보는 본문은 같다', async () => {
    const raw = await readRaw()
    Object.assign(raw.content, {
      likes: 1,
      chatCount: 1,
      numComments: 1,
      needsCompilation: false,
      compiled: { version: 1, error: false },
      generatedHashtags: []
    })
    Object.assign(raw.canvas, { compiledDate: '2026-01-01T00:00:00.000Z' })
    const first = JSON.stringify({ ...rplayWorks.normalize(raw), updatedAt: null })
    Object.assign(raw.content, {
      likes: 2,
      chatCount: 50,
      numComments: 9,
      needsCompilation: true,
      compiled: { version: 2, error: true },
      generatedHashtags: ['생성 태그']
    })
    Object.assign(raw.canvas, { compiledDate: '2026-01-01T00:02:00.000Z' })
    // work_plan의 frozen()이 이 글을 견준다
    expect(JSON.stringify({ ...rplayWorks.normalize(raw), updatedAt: null })).toBe(first)
  })
})

describe('알플레이 저장은 바꾼 칸만 건드린다', () => {
  const read = async (): Promise<{ raw: Raw; s: ReturnType<typeof site> }> => {
    const s = site()
    return { raw: (await rplayWorks.readRaw(s.read, W)) as unknown as Raw, s }
  }
  const whole = (body: ReturnType<typeof rplayWorks.normalize>): Parameters<typeof rplayApplyChanges>[1] => ({
    lorebook: body.lorebook
  })

  it('전체 교체: 앞에 새 항목을 끼워도 옛 항목의 숨은 값이 엉뚱한 항목에 붙지 않는다', async () => {
    const { raw } = await read()
    const old = structuredClone(metaOf(raw, L1).entries)
    const body = rplayWorks.normalize(raw)
    const next = rplayApplyChanges(raw, {
      lorebook: [
        {
          title: '사건',
          keys: '비',
          content: '비 오는 날',
          mode: null,
          offKeys: [],
          turnRange: null,
          offTurnRange: null
        },
        ...body.lorebook.map((e) => ({ ...e, mode: null, turnRange: null }))
      ]
    })
    // 짝 있는 옛 항목: 우선순위·토큰 수·발동 방식·유지 턴이 그대로
    expect(metaOf(next, L1).entries).toEqual(old)
    // 짝 없는 새 항목: 옛 항목을 물려받지 않고 새 노드의 새 항목
    const made = (next.canvas.nodes as Obj[]).filter((n) => n.type === 'lorebook' && n.uid !== 'u-l1')
    expect(made).toHaveLength(1)
    expect(metaOf(next, String(made[0].metadataOid))).toMatchObject({
      title: '사건',
      entries: [
        {
          key: '비',
          patterns: ['비'],
          text: '비 오는 날',
          priority: 1,
          durationTurns: 1,
          activationMode: 'keyword'
        }
      ]
    })
    expect(metaOf(next, String(made[0].metadataOid)).entries).not.toContainEqual(
      expect.objectContaining({ tokenCount: 5 })
    )
  })

  it('전체 교체: 안 준 발동 방식·유지 턴·발동 단어는 옛 값 그대로', async () => {
    const { raw } = await read()
    const next = rplayApplyChanges(raw, {
      lorebook: [
        {
          title: '장소',
          keys: '',
          content: '학교 설명 고침',
          mode: null,
          offKeys: [],
          turnRange: null,
          offTurnRange: null
        },
        {
          title: '장소',
          keys: '',
          content: '늘 켜짐',
          mode: null,
          offKeys: [],
          turnRange: null,
          offTurnRange: null
        }
      ]
    })
    const [a, b] = metaOf(next, L1).entries as Obj[]
    expect(a).toMatchObject({
      patterns: ['학교', '교실'],
      key: '학교|교실',
      text: '학교 설명 고침',
      durationTurns: 3,
      priority: 2,
      tokenCount: 5
    })
    expect(b).toMatchObject({ activationMode: 'always', text: '늘 켜짐', durationTurns: 1 })
  })

  it('전체 교체: 제목만 고친 자리는 옛 항목의 숨은 값을 이어 새 이름 노드로 옮긴다', async () => {
    const { raw } = await read()
    const body = rplayWorks.normalize(raw)
    const next = rplayApplyChanges(raw, {
      lorebook: [{ ...body.lorebook[0], title: '교정', mode: null, turnRange: null }]
    })
    const made = (next.canvas.nodes as Obj[]).find((n) => n.type === 'lorebook' && n.uid !== 'u-l1')!
    const m = metaOf(next, String(made.metadataOid))
    expect(m.title).toBe('교정')
    expect(m.entries).toMatchObject([{ priority: 2, tokenCount: 5, durationTurns: 3 }])
    // 옛 노드에는 항목이 남지 않는다
    expect(metaOf(next, L1).entries).toEqual([])
    // 새 노드는 옛 노드가 이어져 있던 곳(첫 스토리)에만 이어진다. 모든 스토리에 잇지 않는다
    const links = (next.canvas.connections as Obj[]).filter((c) => c.sourceNodeId === made.uid)
    expect(links.map((c) => [c.targetNodeId, c.connectionType, c.targetInputIndex])).toEqual([
      ['u-s1', 'lorebook', 3]
    ])
  })

  it('전체 교체: 지우고 새로 넣은 항목은 같은 자리 옛 항목의 값을 물려받지 않는다', async () => {
    const { raw } = await read()
    const body = rplayWorks.normalize(raw)
    // 둘째 옛 항목(늘 켜짐, always)을 지우고 같은 자리에 다른 제목의 새 항목을 넣는다 (mode·turn_range 안 적음)
    const next = rplayApplyChanges(raw, {
      lorebook: [
        { ...body.lorebook[0], mode: null, turnRange: null },
        {
          title: '인물',
          keys: '비',
          content: '전혀 다른 글',
          mode: null,
          offKeys: [],
          turnRange: null,
          offTurnRange: null,
          given: ['title', 'keys', 'content']
        }
      ]
    })
    const made = (next.canvas.nodes as Obj[]).find((n) => n.type === 'lorebook' && n.uid !== 'u-l1')!
    expect(metaOf(next, String(made.metadataOid))).toMatchObject({
      title: '인물',
      entries: [
        {
          key: '비',
          patterns: ['비'],
          text: '전혀 다른 글',
          tokenCount: 0,
          priority: 1,
          durationTurns: 1,
          activationMode: 'keyword'
        }
      ]
    })
    expect(metaOf(next, L1).entries).toHaveLength(1)
  })

  /** 실제 원본처럼: 한 노드(같은 제목)에 항목 다섯 개, key는 항목 이름, 발동 단어는 따로, 우선순위 55~51 */
  const sameTitle = (raw: Raw): Obj[] => {
    const entries = [1, 2, 3, 4, 5].map((n) => ({
      key: '항목 이름 ' + n,
      patterns: ['p' + n],
      text: '글 ' + n,
      tokenCount: n * 10,
      priority: 56 - n,
      durationTurns: n,
      activationMode: n % 2 ? 'keyword' : 'always'
    }))
    metaOf(raw, L1).entries = entries
    return structuredClone(entries)
  }
  const entry = (n: number, over: Partial<LoreEntry> = {}): LoreEntry => ({
    title: '장소',
    keys: 'p' + n,
    content: '글 ' + n,
    mode: null,
    offKeys: [],
    turnRange: null,
    offTurnRange: null,
    ...over
  })

  it('전체 교체: 같은 노드 안에서 항목을 끼우거나 빼거나 순서를 바꿔도 숨은 값이 따라간다', async () => {
    const { raw } = await read()
    const old = sameTitle(raw)
    const get = (next: Raw): Obj[] => metaOf(next, L1).entries as Obj[]
    // 끼우기
    const inserted = rplayApplyChanges(raw, {
      lorebook: [entry(1), entry(9, { keys: 'p9', content: '새 글' }), entry(2), entry(3), entry(4), entry(5)]
    }) as unknown as Raw
    expect(get(inserted).map((e) => [e.text, e.priority])).toEqual([
      ['글 1', 55],
      ['새 글', 1],
      ['글 2', 54],
      ['글 3', 53],
      ['글 4', 52],
      ['글 5', 51]
    ])
    // 빼기
    const removed = rplayApplyChanges(raw, {
      lorebook: [entry(1), entry(2), entry(4), entry(5)]
    }) as unknown as Raw
    expect(get(removed)).toEqual([old[0], old[1], old[3], old[4]])
    // 순서 바꾸기
    const swapped = rplayApplyChanges(raw, {
      lorebook: [entry(5), entry(4), entry(3), entry(2), entry(1)]
    }) as unknown as Raw
    expect(get(swapped)).toEqual([old[4], old[3], old[2], old[1], old[0]])
    // 내용을 고치면서 끼워도: 고친 항목은 발동 단어가 같은 옛 항목의 값을 잇고, 새 항목은 옛 항목을 가로채지 않는다
    const both = rplayApplyChanges(raw, {
      lorebook: [
        entry(1),
        entry(9, { keys: 'p9', content: '새 글' }),
        entry(2, { content: '글 2 고침' }),
        entry(3),
        entry(4),
        entry(5)
      ]
    }) as unknown as Raw
    expect(get(both).map((e) => [e.text, e.priority, e.key])).toEqual([
      ['글 1', 55, '항목 이름 1'],
      ['새 글', 1, 'p9'],
      ['글 2 고침', 54, '항목 이름 2'],
      ['글 3', 53, '항목 이름 3'],
      ['글 4', 52, '항목 이름 4'],
      ['글 5', 51, '항목 이름 5']
    ])
  })

  it('전체 교체: 발동 단어는 쪼갠 목록으로 견주고, 바뀌어도 항목 이름(key)은 덮지 않는다', async () => {
    const { raw } = await read()
    const old = sameTitle(raw)
    metaOf(raw, L1).entries = [{ ...old[0], patterns: ['a', 'b'] }]
    const first = (next: unknown): Obj => (metaOf(next, L1).entries as Obj[])[0]
    // 쉼표 뒤 공백만 다르면 아무것도 안 바뀐다
    const same = rplayApplyChanges(raw, { lorebook: [entry(1, { keys: 'a,b' })] })
    expect(first(same)).toEqual({ ...old[0], patterns: ['a', 'b'] })
    // 발동 단어를 정말 바꿔도 이름은 그대로
    const changed = rplayApplyChanges(raw, { lorebook: [entry(1, { keys: 'a, b, c' })] })
    expect(first(changed)).toEqual({ ...old[0], patterns: ['a', 'b', 'c'] })
    // 같은 값이면 5개 넘는 옛 값도 막지 않는다
    metaOf(raw, L1).entries = [{ ...old[0], patterns: ['a', 'b', 'c', 'd', 'e', 'f'] }]
    const six = rplayApplyChanges(raw, { lorebook: [entry(1, { keys: 'a,b,c,d,e,f' })] })
    expect(first(six).patterns).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
    // key가 옛 발동 단어를 이은 값이면(파생값) 따라 바뀐다
    const plain = (await read()).raw
    const derived = rplayApplyChanges(plain, { lorebookPatch: [{ index: 0, keys: '학교, 강당' }] })
    expect(first(derived)).toMatchObject({ patterns: ['학교', '강당'], key: '학교|강당' })
  })

  it('전체 교체: given에 keys가 있으면 빈 값은 발동 단어를 비운다 (없으면 옛 값 그대로)', async () => {
    const { raw } = await read()
    const first = (next: unknown): Obj => (metaOf(next, L1).entries as Obj[])[0]
    const row = { title: '장소', content: '학교 설명', offKeys: [], offTurnRange: null, mode: null, turnRange: null }
    const cleared = rplayApplyChanges(raw, {
      lorebook: [{ ...row, keys: '', given: ['title', 'keys', 'content'] }]
    })
    expect(first(cleared)).toMatchObject({ patterns: [], key: '' })
    const kept = rplayApplyChanges(raw, {
      lorebook: [{ ...row, keys: '', given: ['title', 'content'] }]
    })
    expect(first(kept)).toMatchObject({ patterns: ['학교', '교실'], key: '학교|교실' })
  })

  it('옛 값이 편집기 규칙 밖이어도 손대지 않은 칸은 막지 않고 그대로 둔다', async () => {
    const { raw } = await read()
    const lore = metaOf(raw, L1).entries as Obj[]
    lore[0].patterns = ['a', 'b', 'c', 'd', 'e', 'f']
    lore[0].key = 'a|b|c|d|e|f'
    lore[0].durationTurns = 9
    metaOf(raw, S1).useTokenBlock = false
    metaOf(raw, S1).prologue = '가'.repeat(1200)
    metaOf(raw, S1).creatorNotice = '나'.repeat(600)
    raw.localization.simpleIntro = '다'.repeat(60)
    const body = rplayWorks.normalize(raw)
    const before = structuredClone(raw.metadataSet)
    // 읽은 값을 그대로 돌려줘도 막히지 않고, 아무 칸도 바뀌지 않는다
    const same = rplayApplyChanges(raw, {
      ...whole(body),
      fields: { subtitle: body.fields.subtitle, creator_comment: body.fields.creator_comment },
      startScenarios: [{ index: 0, content: body.startScenarios[0].content }]
    })
    expect(same.metadataSet).toEqual(before)
    // 다른 칸만 고치면 그 칸만 바뀐다 (옛 prologue·공지가 길어도 막히지 않는다)
    const edited = rplayApplyChanges(raw, {
      startScenarios: [{ index: 0, situation: '새 이어쓰기' }],
      lorebookPatch: [{ index: 0, content: '본문만 고침' }]
    })
    expect(metaOf(edited, S1)).toEqual({ ...before[S1], prologueGuide: '새 이어쓰기' })
    expect((metaOf(edited, L1).entries as Obj[])[0]).toEqual({
      ...(before[L1].entries as Obj[])[0],
      text: '본문만 고침'
    })
    // 바꾼 칸은 여전히 검사한다
    expect(() =>
      rplayApplyChanges(raw, { startScenarios: [{ index: 0, content: '라'.repeat(1201) }] })
    ).toThrow('BAD_START')
    expect(() => rplayApplyChanges(raw, { fields: { creator_comment: '마'.repeat(601) } })).toThrow(
      'BAD_FIELD'
    )
    expect(() => rplayApplyChanges(raw, { fields: { subtitle: '바'.repeat(61) } })).toThrow(
      'BAD_FIELD'
    )
    expect(() =>
      rplayApplyChanges(raw, { lorebookPatch: [{ index: 0, keys: 'a, b, c, d, e, f, g' }] })
    ).toThrow('BAD_LOREBOOK')
    expect(() => rplayApplyChanges(raw, { lorebookPatch: [{ index: 0, turnRange: 6 }] })).toThrow(
      'BAD_LOREBOOK'
    )
  })

  it('읽은 값을 그대로 돌려주면 없던 칸에 빈 글이 채워지지 않고 요청도 나가지 않는다', async () => {
    const { raw, s } = await read()
    const before = structuredClone(raw)
    const body = rplayWorks.normalize(raw)
    const next = rplayApplyChanges(raw, {
      visibility: body.visibility ?? undefined,
      fields: body.fields,
      startScenarios: body.startScenarios.map((x, index) => ({
        index,
        title: x.title,
        content: x.content,
        subPrompt: x.subPrompt,
        dialogue: x.dialogue,
        situation: x.situation,
        description: x.description
      })),
      characters: body.characters.map((c, index) => ({
        index,
        name: c.name,
        details: c.details,
        info: c.info
      })),
      ...whole(body)
    }) as unknown as Raw
    expect(next.metadataSet).toEqual(before.metadataSet)
    expect(next.canvas).toEqual(before.canvas)
    s.calls.length = 0
    await rplayWorks.save!(s.write, W, next, s.io)
    expect(s.calls.filter((c) => c.startsWith('POST'))).toEqual([])
  })

  it('작업 중 작품에 읽은 공개 여부(private)를 돌려줘도 isPrivate를 바꾸지 않는다', async () => {
    const { raw } = await read()
    raw.content.status = 'wip'
    raw.content.isPrivate = false
    expect(rplayWorks.normalize(raw).visibility).toBe('private')
    const next = rplayApplyChanges(raw, { visibility: 'private' }) as unknown as Raw
    expect(next.content.isPrivate).toBe(false)
    expect(() => rplayApplyChanges(raw, { visibility: 'public' })).toThrow('NOT_PUBLISHED')
  })

  it('바꾼 글 칸만 노드에 쓴다: 둘째 스토리의 없던 칸에 빈 글을 채우지 않는다', async () => {
    const { raw } = await read()
    const next = rplayApplyChanges(raw, {
      startScenarios: [{ index: 1, content: '둘째 새 시작', situation: '', description: '' }]
    })
    expect(metaOf(next, S2)).not.toHaveProperty('prologueGuide')
    expect(metaOf(next, S2)).not.toHaveProperty('text')
    expect(metaOf(next, S2).prologue).toBe('둘째 새 시작')
  })

  it('전체 교체: given에 없는 칸은 옛 값 그대로, 있는 칸은 받은 값으로 바꾼다', async () => {
    const { raw } = await read()
    const base = {
      title: '장소',
      keys: '',
      offKeys: [],
      offTurnRange: null
    }
    // 제목·본문만 적은 호출: 발동 방식(always)·유지 턴(3)은 안 건드린다. 값이 뭐든 given에 없으면 무시
    const kept = rplayApplyChanges(raw, {
      lorebook: [
        { ...base, content: '학교 설명', mode: 'always', turnRange: 5, given: ['title', 'content'] },
        { ...base, content: '늘 켜짐', mode: 'keyword', turnRange: 4, given: ['title', 'content'] }
      ]
    })
    const [a, b] = metaOf(kept, L1).entries as Obj[]
    expect(a).toMatchObject({ activationMode: 'keyword', durationTurns: 3 })
    expect(b).toMatchObject({ activationMode: 'always', durationTurns: 1 })
    // 적어 준 칸은 받은 값으로: mode·turnRange를 적으면 바뀐다
    const set = rplayApplyChanges(raw, {
      lorebook: [
        {
          ...base,
          content: '학교 설명',
          mode: 'always',
          turnRange: 5,
          given: ['title', 'content', 'mode', 'turnRange']
        },
        {
          ...base,
          content: '늘 켜짐',
          mode: 'keyword',
          turnRange: 2,
          given: ['title', 'content', 'mode', 'turnRange']
        }
      ]
    })
    const [c, d] = metaOf(set, L1).entries as Obj[]
    expect(c).toMatchObject({ activationMode: 'always', durationTurns: 5, priority: 2, tokenCount: 5 })
    expect(d).toMatchObject({ activationMode: 'keyword', durationTurns: 2 })
    // 빈 값(null)으로 적었으면 알플레이 기본값(keyword·1턴)으로 돌린다
    const reset = rplayApplyChanges(raw, {
      lorebook: [
        { ...base, content: '학교 설명', mode: null, turnRange: null, given: ['title', 'content', 'mode', 'turnRange'] },
        { ...base, content: '늘 켜짐', mode: null, turnRange: null, given: ['title', 'content', 'mode', 'turnRange'] }
      ]
    })
    const [e, f] = metaOf(reset, L1).entries as Obj[]
    expect(e).toMatchObject({ activationMode: 'keyword', durationTurns: 1 })
    expect(f).toMatchObject({ activationMode: 'keyword', durationTurns: 1 })
    // given 없는 옛 호출: null은 "안 줌"이라 옛 값 그대로, 값이 있으면 그 값
    const legacy = rplayApplyChanges(raw, {
      lorebook: [
        { ...base, content: '학교 설명', mode: null, turnRange: 4 },
        { ...base, content: '늘 켜짐', mode: null, turnRange: null }
      ]
    })
    const [g, h] = metaOf(legacy, L1).entries as Obj[]
    expect(g).toMatchObject({ activationMode: 'keyword', durationTurns: 4 })
    expect(h).toMatchObject({ activationMode: 'always', durationTurns: 1 })
    // 새 항목(짝 없음)은 given과 상관없이 기본값에서 시작한다
    const added = rplayApplyChanges(raw, {
      lorebookAdd: [{ ...base, title: '새 장소', content: '새 글', mode: null, turnRange: null, given: ['title', 'content'] }]
    })
    const made = (added.canvas.nodes as Obj[]).find((n) => n.type === 'lorebook' && n.uid !== 'u-l1')!
    expect(metaOf(added, String(made.metadataOid)).entries).toMatchObject([
      { activationMode: 'keyword', durationTurns: 1, priority: 1 }
    ])
  })

  it('원본 없이 저장하면 성공으로 돌려주지 않는다', async () => {
    const { raw, s } = await read()
    s.calls.length = 0
    await expect(rplayWorks.save!(s.write, W, raw, s.io)).rejects.toThrow('NO_BASE')
    expect(s.calls).toEqual([])
  })

  it('언어 상태의 revision을 모르면 0으로 짐작하지 않고 멈춘다', async () => {
    const { raw, s } = await read()
    delete (raw.localization.localization as Obj).revision
    // 제목과 노드 내용을 함께 바꿔도 노드 내용이 먼저 나간 채 멈추지 않는다 (아무것도 쓰지 않는다)
    const next = rplayApplyChanges(raw, { fields: { title: '새 제목', main: '새 메인' } })
    s.calls.length = 0
    await expect(rplayWorks.save!(s.write, W, next, s.io)).rejects.toThrow('LOCALIZATION_MISSING')
    expect(s.calls.filter((c) => c.startsWith('POST'))).toEqual([])
    expect(((s.s[W] as Obj).meta as Record<string, Obj>)[S1].coreContext).toBe('메인 프롬프트')
  })
})
