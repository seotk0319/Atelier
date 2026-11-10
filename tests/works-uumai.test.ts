import { describe, expect, it } from 'vitest'
import { uumaiCreateBody, uumaiWorks } from '../src/main/works/uumai'
import { arrangeLorebooks, uumaiSaveBody } from '../src/main/works/uumai-core'
import { uumaiSendRule } from '../src/main/works/uumai-media'
import type {
  LocalImage,
  WorkFetch,
  WorkIo,
  WorkRequest,
  WorkSend,
  WorkWrite
} from '../src/main/works/types'

// 가짜 응답 모양은 2026-11-10 우마이 공개 스크립트에서 읽은 필드를 따른다
// (스냅샷 목록 {snapshots, draftSnapshotId, publishedSnapshotId}, 스냅샷 = CreatorWorkDraftItem, 저장 응답 {workId, snapshotId}).
const API = 'https://api.uumm.ai/v1'
const W = '019f70d3-98e9-7681-a519-e5c483e49c29'
const DRAFT = '019f70d3-0000-7000-8000-000000000001'
const PUB = '019f70d3-0000-7000-8000-000000000002'
const IMG = '019f70d3-0000-7000-8000-0000000000aa'
type Obj = Record<string, unknown>

const ok = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const image = (name: string, size = 10): LocalImage => ({
  name,
  type: 'image/webp',
  data: new Uint8Array(size)
})

function snapshot(): Obj {
  return {
    id: DRAFT,
    workId: W,
    title: '시험 작품',
    description: '짧은 소개',
    detailDescription: '<p>상세</p>',
    prompt: '상세 프롬프트',
    intros: [
      {
        name: '기본',
        content: '첫 인트로',
        prompt: '',
        promptMaxTurn: 5,
        recommends: ['안녕', ' ']
      },
      { name: '둘째', content: '둘째 인트로', prompt: '둘째 전용', recommends: [] }
    ],
    notepad: '메모',
    isAdult: true,
    publishStatus: 2,
    genderTendency: 1,
    allowComment: true,
    imagePromptEnabled: true,
    creatorStyleEnabled: false,
    playGuide: '가이드',
    isDerivativeWork: false,
    hashtags: ['태그'],
    thumbnail: { imageId: IMG, url: 'https://img.uumm.ai/thumb.webp' },
    images: [
      {
        imageId: IMG,
        url: 'https://img.uumm.ai/a.webp',
        isPublic: true,
        keyword: '웃음',
        slug: 'ab12c'
      }
    ],
    audios: [],
    lorebookFolders: [{ id: 'f0000000-0000-4000-8000-000000000001', name: '인물', color: 1 }],
    lorebooks: [
      {
        id: 'l0000000-0000-4000-8000-000000000001',
        name: '폴더 안',
        keywords: ['가'],
        content: '폴더 안 내용',
        folderId: 'f0000000-0000-4000-8000-000000000001',
        introSequences: [1],
        scanTurns: 2
      },
      {
        id: 'l0000000-0000-4000-8000-000000000002',
        name: '폴더 밖',
        keywords: ['나', '다'],
        content: '폴더 밖 내용',
        isConstant: true,
        notKeywords: ['라'],
        folderId: null,
        dependsOnIds: ['l0000000-0000-4000-8000-000000000001', 'gone']
      }
    ],
    skills: [],
    dice: [],
    jsx: [],
    updatedAt: '2026-11-10T10:00:00Z'
  }
}

function reader(index: Obj, body: Obj, seen: string[] = []): WorkFetch {
  return async (url) => {
    seen.push(url)
    if (url === API + '/creator/work/' + W + '/snapshot') return ok(index)
    if (url.startsWith(API + '/creator/work/' + W + '/snapshot/')) return ok(body)
    return ok({}, 404)
  }
}
const draftOnly = { snapshots: [], draftSnapshotId: DRAFT, publishedSnapshotId: null }

describe('우마이 작품 연결부 — 주소', () => {
  it('편집기가 쓰는 주소만 읽고 쓴다', () => {
    const r = uumaiWorks.readAllowed
    expect(r(API + '/creator/work?sort=latest')).toBe(true)
    expect(r(API + '/creator/work?sort=latest&after=abc123')).toBe(true)
    expect(r(API + '/creator/work')).toBe(false)
    expect(r(API + '/creator/work?sort=likeCount')).toBe(false)
    expect(r(API + '/creator/work?sort=latest&publish=1')).toBe(false)
    expect(r(API + '/creator/work/' + W + '/snapshot')).toBe(true)
    expect(r(API + '/creator/work/' + W + '/snapshot/' + DRAFT)).toBe(true)
    expect(r(API + '/creator/work/' + W + '/snapshot?x=1')).toBe(false)
    expect(r('https://evil.example/v1/creator/work/' + W + '/snapshot')).toBe(false)
    const w = uumaiWorks.writeAllowed!
    expect(w('POST', API + '/creator/work/save')).toBe(true)
    expect(w('POST', API + '/image/upload-url')).toBe(true)
    expect(w('DELETE', API + '/creator/work/' + W)).toBe(true)
    expect(w('PUT', API + '/creator/work/save')).toBe(false)
    expect(w('DELETE', API + '/creator/work/' + W + '/snapshot/' + DRAFT)).toBe(false)
    expect(w('POST', API + '/creator/work/' + W + '/duplicate')).toBe(false)
  })

  it('목록은 정렬을 고정하고 다음 표시로 넘기며 번호 중복과 되도는 표시를 걸러 낸다', async () => {
    const seen: string[] = []
    const read: WorkFetch = async (url) => {
      seen.push(url)
      if (url === API + '/creator/work?sort=latest')
        return ok({
          data: [
            { id: W, title: '하나', publishStatus: 1, publishedAt: '2026-10-01T00:00:00Z' },
            { id: DRAFT, title: '초안', publishStatus: 2, draftSavedAt: '2026-11-01T00:00:00Z' }
          ],
          meta: { next: 'c2' }
        })
      if (url === API + '/creator/work?sort=latest&after=c2')
        return ok({ data: [{ id: W, title: '하나 중복' }], meta: { next: 'c2' } })
      return ok({}, 500)
    }
    const items = await uumaiWorks.list(read)
    expect(seen).toHaveLength(2)
    expect(items.map((i) => [i.id, i.visibility, i.status])).toEqual([
      [W, 'public', 'published'],
      [DRAFT, 'private', 'draft']
    ])
  })
})

describe('우마이 작품 연결부 — 읽기', () => {
  it('초안이 있으면 초안 스냅샷을 읽고 공통 모양으로 옮긴다', async () => {
    const seen: string[] = []
    const raw = await uumaiWorks.readRaw(
      reader({ snapshots: [], draftSnapshotId: DRAFT, publishedSnapshotId: PUB }, snapshot(), seen),
      W
    )
    expect(seen[1]).toBe(API + '/creator/work/' + W + '/snapshot/' + DRAFT)
    const body = uumaiWorks.normalize(raw)
    expect(body.status).toBe('published')
    expect(body.updatedAt).toContain('발행 안 된 초안')
    expect(body.visibility).toBe('private')
    expect(body.fields).toEqual({
      title: '시험 작품',
      subtitle: '짧은 소개',
      description: '<p>상세</p>',
      main: '상세 프롬프트',
      play_guide: '가이드'
    })
    // 편집기처럼 폴더 없는 항목이 먼저 온다
    expect(body.lorebook.map((l) => [l.title, l.keys, l.mode, l.turnRange])).toEqual([
      ['폴더 밖', '나, 다', 'always', null],
      ['폴더 안', '가', 'keyword', 2]
    ])
    expect(body.startScenarios.map((s) => [s.title, s.content, s.subPrompt, s.isDefault])).toEqual([
      ['기본', '첫 인트로', '', true],
      ['둘째', '둘째 인트로', '둘째 전용', false]
    ])
    expect(body.characters).toEqual([])
  })

  it('한 번도 발행하지 않은 작품은 draft', async () => {
    const raw = await uumaiWorks.readRaw(reader(draftOnly, snapshot()), W)
    expect(uumaiWorks.normalize(raw).status).toBe('draft')
  })
})

describe('우마이 작품 연결부 — 바꾸기·저장', () => {
  it('저장 본문은 편집기 Bx→NG를 거친 모양이다 (임시저장, 인트로·로어북 기본값)', () => {
    const body = uumaiSaveBody(snapshot(), { isPublish: false, workId: W })
    expect(body.isPublish).toBe(false)
    expect(body.workId).toBe(W)
    const intros = body.intros as Obj[]
    expect(intros[0].recommends).toEqual(['안녕'])
    // 스냅샷에 없던 promptMaxTurn은 편집기처럼 5
    expect(intros[1].promptMaxTurn).toBe(5)
    const lores = body.lorebooks as Obj[]
    expect(lores.map((l) => l.name)).toEqual(['폴더 밖', '폴더 안'])
    // 적용 인트로가 없으면 전체 인트로, 있으면 그대로
    expect(lores[0].introSequences).toEqual([0, 1])
    expect(lores[1].introSequences).toEqual([1])
    // 없는 의존 번호는 버린다
    expect(lores[0].dependsOnIds).toEqual(['l0000000-0000-4000-8000-000000000001'])
    expect(lores[0].scanTurns).toBeUndefined()
    expect(body.thumbnail).toEqual({ imageId: IMG })
    expect(body.images).toEqual([{ imageId: IMG, isPublic: true, keyword: '웃음', slug: 'ab12c' }])
    expect(body.achievements).toBeUndefined()
    expect(body).not.toHaveProperty('updateNote')
  })

  it('컴파일 결과가 없는 jsx가 있으면 저장하지 않는다', () => {
    const s = snapshot()
    s.jsx = [{ fileName: 'Card', sourceCode: 'export function Card(){}' }]
    expect(() => uumaiSaveBody(s, { isPublish: false })).toThrow('JSX_UNSUPPORTED')
    s.jsx = [
      {
        fileName: 'Card',
        sourceCode: 'export function Card(){}',
        compiledCode: 'x',
        components: ['Card']
      }
    ]
    expect((uumaiSaveBody(s, { isPublish: false }).jsx as Obj[])[0].compiledCode).toBe('x')
  })

  it('글 칸·로어북·인트로를 고치고, 새 로어북은 null 값 대신 기본값을 쓴다', async () => {
    const raw = await uumaiWorks.readRaw(reader(draftOnly, snapshot()), W)
    const next = uumaiWorks.applyChanges!(raw, {
      fields: { main: '새 프롬프트', play_guide: '새 가이드' },
      lorebookAdd: [
        {
          title: '새 항목',
          keys: '마, 바',
          content: '새 내용',
          mode: null,
          offKeys: [],
          turnRange: null,
          offTurnRange: null
        }
      ],
      lorebookRemove: [1],
      startScenariosRemove: [1],
      startScenariosAdd: [{ title: '셋째', content: '셋째 인트로', subPrompt: '셋째 전용' }]
    })
    const body = uumaiWorks.normalize(next)
    expect(body.fields.main).toBe('새 프롬프트')
    expect(body.fields.play_guide).toBe('새 가이드')
    expect(body.lorebook.map((l) => [l.title, l.mode, l.turnRange])).toEqual([
      ['폴더 밖', 'always', null],
      ['새 항목', 'keyword', null]
    ])
    expect(body.startScenarios.map((s) => s.title)).toEqual(['기본', '셋째'])
    // 원본은 그대로
    expect(uumaiWorks.normalize(raw).lorebook).toHaveLength(2)
  })

  it('인트로를 지우면 로어북 적용 인트로 번호를 당기고, 남는 번호가 없으면 전체 인트로가 된다', async () => {
    const s = snapshot()
    ;(s.lorebooks as Obj[])[0].introSequences = [1]
    ;(s.lorebooks as Obj[])[1].introSequences = [0, 1]
    const raw = await uumaiWorks.readRaw(reader(draftOnly, s), W)
    const next = uumaiWorks.applyChanges!(raw, { startScenariosRemove: [1] }) as { work: Obj }
    const lores = next.work.lorebooks as Obj[]
    const byName = Object.fromEntries(lores.map((l) => [l.name, l.introSequences]))
    expect(byName['폴더 안']).toBeUndefined()
    expect(byName['폴더 밖']).toEqual([0])
  })

  it('없는 칸·기본 인트로 지우기·캐릭터·턴 해제 범위는 막는다', async () => {
    const raw = await uumaiWorks.readRaw(reader(draftOnly, snapshot()), W)
    const apply = uumaiWorks.applyChanges!
    expect(() => apply(raw, { fields: { creator_comment: 'x' } })).toThrow('BAD_FIELD')
    expect(() => apply(raw, { fields: { title: 'x'.repeat(21) } })).toThrow('BAD_FIELD')
    expect(() => apply(raw, { startScenariosRemove: [0] })).toThrow('KEEP_DEFAULT')
    expect(() => apply(raw, { charactersAdd: [{ name: '새' }] })).toThrow('NO_CHARACTERS')
    expect(() => apply(raw, { lorebookPatch: [{ index: 0, offTurnRange: 3 }] })).toThrow(
      'BAD_CHANGES'
    )
    expect(() => apply(raw, { lorebookPatch: [{ index: 0, turnRange: 9 }] })).toThrow(
      'BAD_LOREBOOK'
    )
    expect(() => apply(raw, { startScenarios: [{ index: 0, dialogue: '대사' }] })).toThrow(
      'BAD_CHANGES'
    )
  })

  it('보통 저장은 임시저장, 공개 상태를 바꾸면 발행한다 (발행 칸이 비면 막는다)', async () => {
    const raw = await uumaiWorks.readRaw(reader(draftOnly, snapshot()), W)
    const sent: { method: string; url: string; body: Obj }[] = []
    const write: WorkWrite = async (method, url, body) => {
      sent.push({ method, url, body: body as Obj })
      return ok({ workId: W, snapshotId: DRAFT })
    }
    await uumaiWorks.save!(write, W, uumaiWorks.applyChanges!(raw, { fields: { main: '바뀜' } }))
    expect(sent[0].url).toBe(API + '/creator/work/save')
    expect(sent[0].body.isPublish).toBe(false)
    expect(sent[0].body.prompt).toBe('바뀜')

    const pub = uumaiWorks.applyChanges!(raw, { visibility: 'public' })
    expect(uumaiWorks.normalize(pub).status).toBe('published')
    await uumaiWorks.save!(write, W, pub)
    expect(sent[1].body.isPublish).toBe(true)
    expect(sent[1].body.publishStatus).toBe(1)

    const bare = snapshot()
    bare.hashtags = []
    const rawBare = await uumaiWorks.readRaw(reader(draftOnly, bare), W)
    expect(() => uumaiWorks.applyChanges!(rawBare, { visibility: 'link' })).toThrow(
      'PUBLISH_REQUIREMENTS hashtags'
    )
    expect(() => uumaiWorks.applyChanges!(raw, { visibility: 'unlisted' })).toThrow(
      'BAD_VISIBILITY'
    )
  })

  it('저장이 거절되면 상태 코드를 남기고, 로그인 만료는 LOGIN_REQUIRED', async () => {
    const raw = await uumaiWorks.readRaw(reader(draftOnly, snapshot()), W)
    await expect(
      uumaiWorks.save!(async () => ok({ error: 'InputInvalid' }, 400), W, raw)
    ).rejects.toThrow('SAVE_FAILED 400 InputInvalid')
    await expect(uumaiWorks.save!(async () => ok({}, 401), W, raw)).rejects.toThrow(
      'LOGIN_REQUIRED'
    )
  })

  it('작품 삭제는 DELETE /creator/work/{id}', async () => {
    const sent: string[] = []
    await uumaiWorks.remove!(async (method, url) => {
      sent.push(method + ' ' + url)
      return ok({})
    }, W)
    expect(sent).toEqual(['DELETE ' + API + '/creator/work/' + W])
    await expect(uumaiWorks.remove!(async () => ok({}, 404), W)).rejects.toThrow('WORK_NOT_FOUND')
  })
})

describe('우마이 작품 연결부 — 새 작품', () => {
  it('항상 임시저장·비공개로 만들고 workId를 돌려준다', async () => {
    const body = uumaiCreateBody({
      title: '새 작품',
      main: '프롬프트',
      adult: false,
      subtitle: '소개',
      hashtags: ['태그'],
      characters: [],
      startScenarios: [{ title: '시작', content: '첫 장면' }],
      options: { gender_tendency: 'all' }
    })
    expect(body.isPublish).toBe(false)
    expect(body.publishStatus).toBe(2)
    expect(body.genderTendency).toBe(3)
    expect(body).not.toHaveProperty('workId')
    expect(body.achievements).toEqual([])
    expect((body.intros as Obj[])[0]).toMatchObject({ name: '시작', content: '첫 장면' })
    const id = await uumaiWorks.create!(async () => ok({ workId: W, snapshotId: DRAFT }), {
      title: '새',
      main: '본문',
      adult: false,
      characters: []
    })
    expect(id).toBe(W)
    expect(() =>
      uumaiCreateBody({ title: 'x', main: 'y', adult: false, characters: [{ name: '캐릭' }] })
    ).toThrow('NO_CHARACTERS')
    expect(() =>
      uumaiCreateBody({
        title: 'x',
        main: 'y',
        adult: false,
        characters: [],
        options: { gender_tendency: 'teen' }
      })
    ).toThrow('BAD_DRAFT')
  })
})

describe('우마이 작품 연결부 — 이미지', () => {
  it('업로드 주소를 받아 저장소에 올리고 초안으로 저장한다. 받은 주소만 보낼 수 있다', async () => {
    const raw = await uumaiWorks.readRaw(reader(draftOnly, snapshot()), W)
    const storage = 'https://uumm-images.s3.ap-northeast-2.amazonaws.com/'
    expect(uumaiSendRule('POST', storage)).toBeNull()
    const writes: { url: string; body: Obj }[] = []
    let n = 0
    const write: WorkWrite = async (_m, url, body) => {
      writes.push({ url, body: body as Obj })
      if (url.endsWith('/image/upload-url'))
        return ok({
          data: [
            {
              imageId: '019f70d3-0000-7000-8000-00000000010' + n++,
              uploadUrl: storage,
              uploadFields: { key: 'k', policy: 'p' }
            }
          ]
        })
      return ok({ workId: W, snapshotId: DRAFT })
    }
    const sent: WorkRequest[] = []
    const send: WorkSend = async (request) => {
      // collector처럼 규칙을 먼저 본다
      expect(uumaiSendRule(request.method, request.url)).toEqual({ auth: 'none', body: 'form' })
      sent.push(request)
      return new Response(null, { status: 204 })
    }
    const io: WorkIo = { read: async () => ok({}, 404), write, send }
    const changes = {
      main: image('cover.png'),
      add: [{ file: image('a.webp'), description: '울음' }],
      remove: [1]
    }
    expect(uumaiWorks.planImages!(raw, changes).map((l) => l.action)).toEqual([
      'main',
      'remove',
      'add'
    ])
    await uumaiWorks.applyImages!(io, W, raw, changes)
    expect(writes[0].body.data).toMatchObject([
      { originalImagename: 'cover.png', originalSizeBytes: 10 }
    ])
    expect(sent).toHaveLength(2)
    expect(sent[0].form!.map((f) => f.name)).toEqual(['key', 'policy', 'file'])
    const saved = writes.at(-1)!.body
    expect(saved.isPublish).toBe(false)
    expect(saved.thumbnail).toEqual({ imageId: '019f70d3-0000-7000-8000-000000000100' })
    const images = saved.images as Obj[]
    expect(images).toHaveLength(1)
    expect(images[0]).toMatchObject({ keyword: '울음', isPublic: true })
    expect(String(images[0].slug)).toMatch(/^[a-z0-9]{5}$/)
  })

  it('표지는 지울 수 없고, 받지 않는 파일과 겹치는 참조키는 막는다', async () => {
    const raw = await uumaiWorks.readRaw(reader(draftOnly, snapshot()), W)
    expect(() => uumaiWorks.planImages!(raw, { remove: [0] })).toThrow('KEEP_MAIN_IMAGE')
    expect(() => uumaiWorks.planImages!(raw, { add: [{ file: image('a.bmp') }] })).toThrow(
      'BAD_IMAGE'
    )
    expect(() =>
      uumaiWorks.planImages!(raw, { add: [{ file: image('a.webp'), label: 'ab12c' }] })
    ).toThrow('BAD_IMAGE_LABEL')
    expect(() =>
      uumaiWorks.planImages!(raw, { add: [{ file: image('a.webp', 0xa00001) }] })
    ).toThrow('IMAGE_TOO_LARGE')
  })

  it('로어북 줄 세우기는 폴더 없는 것 먼저, order는 1부터', () => {
    const out = arrangeLorebooks(
      [
        { id: 'a', folderId: 'f' },
        { id: 'b', folderId: null },
        { id: 'c', folderId: 'missing' }
      ],
      [{ id: 'f' }]
    )
    expect(out.map((l) => [l.id, l.order, l.folderId])).toEqual([
      ['b', 1, null],
      ['c', 2, null],
      ['a', 3, 'f']
    ])
  })
})
