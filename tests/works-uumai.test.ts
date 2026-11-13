import { describe, expect, it } from 'vitest'
import { uumaiCreateBody, uumaiWorks } from '../src/main/works/uumai'
import { arrangeLorebooks, uumaiSaveBody } from '../src/main/works/uumai-core'
import { uumaiSendRule } from '../src/main/works/uumai-media'
import type {
  LocalImage,
  LoreEntry,
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
        promptMaxTurn: 7,
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
    // 스냅샷에 칸이 없던 promptMaxTurn은 편집기 기본값 5 (있던 값은 그대로)
    expect(intros[0].promptMaxTurn).toBe(7)
    expect(intros[1].promptMaxTurn).toBe(5)
    expect(intros[1].bgmAudioId).toBeNull()
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

// 지어낸 값만 쓴다. 저장 때 손대지 않은 값이 바뀌거나 사라지지 않는지 본다.
const lore = (title: string, over: Partial<LoreEntry> = {}): LoreEntry => ({
  title,
  keys: title + '키',
  content: title + ' 내용',
  mode: null,
  offKeys: [],
  turnRange: null,
  offTurnRange: null,
  ...over
})
const L = (n: number): string => 'l0000000-0000-4000-8000-00000000000' + n
function loreSnapshot(): Obj {
  const s = snapshot()
  s.lorebookFolders = []
  s.lorebooks = ['가', '나', '다'].map((name, i) => ({
    id: L(i + 1),
    name,
    keywords: [name + '키'],
    content: name + ' 내용',
    folderId: null,
    isConstant: false,
    introSequences: [i % 2],
    priority: i + 3,
    group: 'g' + i,
    dependsOnIds: i === 1 ? [L(1)] : []
  }))
  return s
}
const rawOf = async (s: Obj): Promise<unknown> => uumaiWorks.readRaw(reader(draftOnly, s), W)
const loresOf = (next: unknown): Obj[] => (next as { work: Obj }).work.lorebooks as Obj[]

describe('우마이 작품 연결부 — 손대지 않은 값 보존', () => {
  it('로어북 전체 교체는 제목이 같은 옛 항목의 번호·숨은 설정을 잇고, 끼운 항목은 새 항목이다', async () => {
    const raw = await rawOf(loreSnapshot())
    // 맨 앞에 새 항목을 끼운다 (자리로 잇던 때는 새 항목이 '가'의 번호·설정을 받았다)
    const next = uumaiWorks.applyChanges!(raw, {
      lorebook: [lore('새'), lore('가'), lore('나'), lore('다')]
    })
    const byName = Object.fromEntries(loresOf(next).map((l) => [l.name, l]))
    expect(byName['가']).toMatchObject({ id: L(1), priority: 3, introSequences: [0], group: 'g0' })
    expect(byName['나']).toMatchObject({ id: L(2), priority: 4, dependsOnIds: [L(1)] })
    expect(byName['다']).toMatchObject({ id: L(3), priority: 5, introSequences: [0] })
    expect(byName['새'].id).not.toBe(L(1))
    expect([L(1), L(2), L(3)]).not.toContain(byName['새'].id)
    expect(byName['새']).toMatchObject({ priority: 0, group: '', dependsOnIds: [] })
    expect(byName['새'].introSequences).toBeUndefined()
    // 저장 본문에서도 같다
    const body = uumaiSaveBody((next as { work: Obj }).work, { isPublish: false, workId: W })
    expect((body.lorebooks as Obj[]).map((l) => [l.name, l.id === L(1)])).toContainEqual(['가', true])
  })

  it('로어북 전체 교체에서 뺀 항목의 번호가 다음 항목으로 넘어가지 않는다', async () => {
    const raw = await rawOf(loreSnapshot())
    const next = uumaiWorks.applyChanges!(raw, { lorebook: [lore('가'), lore('다')] })
    const byName = Object.fromEntries(loresOf(next).map((l) => [l.name, l]))
    // 자리로 이으면 '다'가 빠진 '나'의 번호(2)와 의존 관계를 받는다
    expect(byName['다']).toMatchObject({ id: L(3), dependsOnIds: [] })
    expect(loresOf(next)).toHaveLength(2)
  })

  it('쉼표가 든 키워드와 앞뒤 공백이 든 제외 키워드는 읽은 그대로 되돌리면 그대로 남는다', async () => {
    const s = loreSnapshot()
    ;(s.lorebooks as Obj[])[0].keywords = ['a,b', 'c']
    ;(s.lorebooks as Obj[])[0].notKeywords = [' 공백 ']
    const raw = await rawOf(s)
    const read = uumaiWorks.normalize(raw).lorebook
    expect(read[0].keys).toBe('a,b, c')
    const next = uumaiWorks.applyChanges!(raw, {
      lorebook: [
        { ...read[0], content: '내용만 고침' },
        lore('나'),
        lore('다')
      ]
    })
    expect(loresOf(next)[0]).toMatchObject({
      keywords: ['a,b', 'c'],
      notKeywords: [' 공백 '],
      content: '내용만 고침'
    })
    // 키워드를 바꾸면 그때는 쉼표로 나눈다
    const patched = uumaiWorks.applyChanges!(raw, { lorebookPatch: [{ index: 0, keys: 'x, y' }] })
    expect(loresOf(patched)[0].keywords).toEqual(['x', 'y'])
  })

  it('저장 본문은 칸이 없을 때만 예전 기본값을 쓰고, 있는 값은 그대로 둔다', () => {
    const s = snapshot()
    delete s.allowComment
    s.imagePromptEnabled = false
    delete s.creatorStyleEnabled
    s.isDerivativeWork = true
    ;(s.intros as Obj[])[0].promptMaxTurn = null
    ;(s.intros as Obj[])[0].bgmAudioId = 'bgm-1'
    ;(s.images as Obj[])[0].isPublic = false
    ;(s.lorebooks as Obj[])[1].priority = undefined
    ;(s.lorebooks as Obj[])[1].group = undefined
    ;(s.lorebooks as Obj[])[0].bgmStop = false
    ;(s.lorebooks as Obj[])[0].priority = 4
    ;(s.lorebooks as Obj[])[0].group = '그룹'
    ;(s.lorebooks as Obj[])[0].activateOnIntro = true
    s.dice = [
      { id: 'd1', bands: [] },
      { id: 'd2', name: ' 주사위 ', count: 3, sides: 6, bands: [] }
    ]
    const achievement = {
      achievementId: 'a1',
      name: '업적',
      description: '설명',
      imageId: IMG,
      isHidden: false,
      hint: '힌트',
      rewardAmount: 1,
      conditionType: 'x',
      threshold: 2
    }
    s.achievements = [achievement, { ...achievement, achievementId: 'a2', hint: undefined }]
    const body = uumaiSaveBody(s, { isPublish: false, workId: W })
    expect(body.allowComment).toBe(true)
    expect(body.imagePromptEnabled).toBe(false)
    expect(body.creatorStyleEnabled).toBe(false)
    expect(body.isDerivativeWork).toBe(true)
    expect((body.intros as Obj[])[0].promptMaxTurn).toBeNull()
    expect((body.intros as Obj[])[0].bgmAudioId).toBe('bgm-1')
    expect((body.images as Obj[])[0].isPublic).toBe(false)
    const lores = body.lorebooks as Obj[]
    // 폴더 밖 항목이 앞(0번), 폴더 안 항목이 1번이다
    expect(lores[0].priority).toBe(0)
    expect(lores[0].group).toBe('')
    expect(lores[0].activateOnIntro).toBe(false)
    expect(lores[1]).toMatchObject({ priority: 4, group: '그룹', activateOnIntro: true })
    // bgmStop은 원본에 있는 값(거짓 포함)만 보낸다
    expect(lores[0].bgmStop).toBeUndefined()
    expect(lores[1].bgmStop).toBe(false)
    expect(body.dice).toEqual([
      { id: 'd1', name: '', count: 1, sides: 20, bands: [] },
      { id: 'd2', name: ' 주사위 ', count: 3, sides: 6, bands: [] }
    ])
    const achievements = body.achievements as Obj[]
    expect(achievements[0].hint).toBe('힌트')
    expect(achievements[1].hint).toBeNull()
  })

  it('값을 모르는 이미지 공개 여부는 공개로 지어 보내지 않는다', () => {
    const s = snapshot()
    delete (s.images as Obj[])[0].isPublic
    const body = uumaiSaveBody(s, { isPublish: false, workId: W })
    expect((body.images as Obj[])[0].isPublic).toBeUndefined()
  })

  it('성인 여부를 모르거나 인트로가 하나도 없는 원본은 지어내지 않고 멈춘다', async () => {
    const s = snapshot()
    delete s.isAdult
    expect(() => uumaiSaveBody(s, { isPublish: false })).toThrow('WORK_SHAPE isAdult')
    const noIntro = snapshot()
    noIntro.intros = []
    expect(() => uumaiSaveBody(noIntro, { isPublish: false })).toThrow('WORK_SHAPE intros')
    // 계획 단계에서 이미 막힌다
    expect(() => uumaiWorks.applyChanges!(rawFrom(noIntro), { fields: { main: '바뀜' } })).toThrow(
      'WORK_SHAPE intros'
    )
  })
})

// readRaw를 거치지 않고 읽은 모양의 원본을 만든다
function rawFrom(work: Obj): unknown {
  return { id: W, snapshotId: DRAFT, draftSnapshotId: DRAFT, publishedSnapshotId: null, work }
}

describe('우마이 작품 연결부 — 바뀐 곳만 검사', () => {
  it('손대지 않은 옛 글 칸이 한도를 넘어도 다른 칸을 고칠 수 있고, 바꾼 칸은 검사한다', () => {
    const s = snapshot()
    s.playGuide = 'x'.repeat(5001)
    const raw = rawFrom(s)
    const apply = uumaiWorks.applyChanges!
    const next = apply(raw, { fields: { title: '새 제목', main: '새 프롬프트' } }) as { work: Obj }
    expect(next.work.playGuide).toBe('x'.repeat(5001))
    expect(uumaiSaveBody(next.work, { isPublish: false }).playGuide).toBe('x'.repeat(5001))
    expect(() => apply(raw, { fields: { play_guide: 'y'.repeat(5001) } })).toThrow('BAD_FIELD')
    expect(() => apply(raw, { fields: { title: 'x'.repeat(21) } })).toThrow('BAD_FIELD')
  })

  it('손대지 않은 옛 로어북이 한도를 넘어도 다른 항목을 고칠 수 있고, 바꾼 항목은 검사한다', () => {
    const s = loreSnapshot()
    ;(s.lorebooks as Obj[])[0].content = 'x'.repeat(10_001)
    const raw = rawFrom(s)
    const apply = uumaiWorks.applyChanges!
    const next = apply(raw, { lorebookPatch: [{ index: 1, mode: 'always' }] })
    expect(loresOf(next)[0].content).toBe('x'.repeat(10_001))
    // 넘는 항목을 손대지 않고 전체 교체로 되돌려 보내도 같다
    const read = uumaiWorks.normalize(raw).lorebook
    expect(() =>
      apply(raw, { lorebook: [{ ...read[0], mode: 'always' }, lore('나'), lore('다')] })
    ).not.toThrow()
    expect(() =>
      apply(raw, { lorebookPatch: [{ index: 0, content: 'y'.repeat(10_001) }] })
    ).toThrow('BAD_LOREBOOK')
    expect(() => apply(raw, { lorebookAdd: [lore('라', { content: 'y'.repeat(10_001) })] })).toThrow(
      'BAD_LOREBOOK'
    )
  })

  it('손대지 않은 옛 인트로가 한도를 넘어도 다른 인트로를 고칠 수 있고, 개수는 늘 때만 본다', () => {
    const s = snapshot()
    ;(s.intros as Obj[])[1].content = 'q'.repeat(5001)
    const raw = rawFrom(s)
    const apply = uumaiWorks.applyChanges!
    const next = apply(raw, { startScenarios: [{ index: 0, title: '새 제목' }] }) as { work: Obj }
    expect((next.work.intros as Obj[])[1].content).toBe('q'.repeat(5001))
    expect(() => apply(raw, { startScenarios: [{ index: 1, title: '새 제목' }] })).not.toThrow()
    expect(() =>
      apply(raw, { startScenarios: [{ index: 1, content: 'w'.repeat(5001) }] })
    ).toThrow('BAD_START')

    // 옛 작품이 이미 11개여도 그 안에서 고치는 것은 막지 않지만 더 늘리지는 못한다
    const many = snapshot()
    many.intros = Array.from({ length: 11 }, (_, i) => ({ name: '인트로' + i, content: '', prompt: '' }))
    const rawMany = rawFrom(many)
    expect(() => apply(rawMany, { startScenarios: [{ index: 3, title: '고침' }] })).not.toThrow()
    expect(() => apply(rawMany, { startScenariosAdd: [{ title: '더함' }] })).toThrow('START_LIMIT')
  })

  it('JSX 개수 상한은 파일을 새로 더할 때만 본다', () => {
    const s = snapshot()
    s.jsx = Array.from({ length: 21 }, (_, i) => ({
      fileName: 'F' + i,
      sourceCode: 'export function Comp' + i + '(){ return null }',
      compiledCode: 'x',
      components: ['Comp' + i]
    }))
    const raw = rawFrom(s)
    const apply = uumaiWorks.applyChanges!
    expect(() =>
      apply(raw, { fields: { 'jsx:F0': 'export function Comp0(){ return 1 }' } })
    ).not.toThrow()
    expect(() =>
      apply(raw, { fields: { 'jsx:Fnew': 'export function Fresh(){ return null }' } })
    ).toThrow('BAD_JSX count')
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

describe('우마이 작품 연결부 — 기능 표·숨은 설정', () => {
  it('기능 표는 22개 열쇠를 모두 갖고 값과 설명 길이가 규격 안이다', () => {
    const features = uumaiWorks.features!
    expect(Object.keys(features).sort()).toEqual([...FEATURE_KEYS].sort())
    for (const f of Object.values(features)) {
      expect(['yes', 'no', 'unknown']).toContain(f.site)
      expect(['yes', 'no', 'partial']).toContain(f.read)
      expect(['yes', 'no', 'partial', 'blocked']).toContain(f.write)
      expect(['yes', 'no', 'partial']).toContain(f.verified)
      expect((f.note ?? '').length).toBeLessThanOrEqual(40)
    }
    expect(features.characters).toMatchObject({ site: 'no', read: 'no', write: 'no' })
    expect(features.language_editions.site).toBe('no')
    expect(features.tags.read).toBe('yes')
  })

  it('원본에 있는 설정을 짧은 값·개수로 싣고 글·주소는 싣지 않는다', async () => {
    const s = snapshot()
    s.recommendedLlmModelId = 36
    s.blindStatus = 1
    s.createdAt = '2026-10-13T01:44:04.000Z'
    s.hashtags = ['태그', '둘']
    s.genderTendency = 2
    ;(s.lorebooks as Obj[])[1].andKeywords = ['라']
    const raw = await uumaiWorks.readRaw(
      reader({ snapshots: [], draftSnapshotId: DRAFT, publishedSnapshotId: PUB }, s),
      W
    )
    const body = uumaiWorks.normalize(raw)
    expect(body.extras).toEqual({
      hashtags: ['태그', '둘'],
      is_adult: true,
      gender_tendency: 'female',
      allow_comment: true,
      image_prompt_enabled: true,
      creator_style_enabled: false,
      is_derivative_work: false,
      recommended_llm_model_id: 36,
      has_cover: true,
      blind_status: 1,
      created_at: '2026-10-13T01:44:04.000Z',
      has_published_version: true,
      has_unpublished_draft: true,
      intro_count: 2,
      lorebook_count: 2,
      lorebook_folder_count: 1,
      image_count: 1,
      audio_count: 0,
      skill_count: 0,
      dice_count: 0,
      jsx_count: 0,
      notepad_length: 2,
      intro_recommend_count: 1,
      intro_max_turn_count: 1,
      intro_bgm_count: 0,
      lorebook_activate_on_intro_count: 0,
      lorebook_and_keyword_count: 1,
      lorebook_dependency_count: 1,
      lorebook_intro_limited_count: 1
    })
    const dumped = JSON.stringify(body.extras)
    for (const secret of ['가이드', '메모', '상세 프롬프트', 'https://', IMG, W, DRAFT])
      expect(dumped).not.toContain(secret)
    // 읽을 때마다 달라질 수 있는 통계는 싣지 않는다 (계획 뒤 변화 검사가 깨진다)
    expect(dumped).not.toMatch(/like|chat_count|view|comment_count/)
    // 같은 원본은 늘 같은 값이다
    expect(JSON.stringify(uumaiWorks.normalize(raw).extras)).toBe(dumped)
  })

  it('원본에 없는 칸은 싣지 않고 표지·초안 표시는 있음/없음으로 싣는다', async () => {
    const s = snapshot()
    delete s.allowComment
    delete s.isAdult
    delete s.genderTendency
    delete s.hashtags
    delete s.thumbnail
    const body = uumaiWorks.normalize(await uumaiWorks.readRaw(reader(draftOnly, s), W))
    const extras = body.extras!
    for (const key of [
      'allow_comment',
      'is_adult',
      'gender_tendency',
      'hashtags',
      'hashtag_count',
      'recommended_llm_model_id',
      'blind_status',
      'created_at',
      'has_bgm_cover'
    ])
      expect(extras).not.toHaveProperty(key)
    expect(extras).toMatchObject({
      has_cover: false,
      has_published_version: false,
      has_unpublished_draft: false
    })
    // 길거나 많은 해시태그는 개수만
    s.hashtags = Array.from({ length: 21 }, (_, i) => 't' + i)
    const many = uumaiWorks.normalize(await uumaiWorks.readRaw(reader(draftOnly, s), W))
    expect(many.extras).toMatchObject({ hashtag_count: 21 })
    expect(many.extras).not.toHaveProperty('hashtags')
  })

  it('읽지 못하는 칸을 적고, 읽게 된 칸은 적지 않는다', async () => {
    const body = uumaiWorks.normalize(await uumaiWorks.readRaw(reader(draftOnly, snapshot()), W))
    expect(body.unsupported).toEqual(
      expect.arrayContaining(['로어북 고급 설정', '스킬', '주사위', '업적', '메모장'])
    )
    for (const gone of ['태그', '해시태그', '등장인물', '캐릭터'])
      expect(body.unsupported).not.toContain(gone)
  })

  it('extras·unsupported가 있어도 저장 본문과 계획 비교 칸은 그대로다', async () => {
    const raw = await uumaiWorks.readRaw(reader(draftOnly, snapshot()), W)
    const body = uumaiWorks.normalize(raw)
    const { extras, unsupported, ...rest } = body
    expect(extras).toBeDefined()
    expect(unsupported).toBeDefined()
    expect(Object.keys(rest).sort()).toEqual(
      ['characters', 'fields', 'id', 'lorebook', 'startScenarios', 'status', 'title', 'updatedAt', 'visibility'].sort()
    )
    const next = uumaiWorks.applyChanges!(raw, { fields: { title: '새 제목' } })
    const saved = uumaiSaveBody((next as { work: Obj }).work, { isPublish: false, workId: W })
    expect(saved).not.toHaveProperty('extras')
    expect(saved).not.toHaveProperty('unsupported')
  })
})

describe('우마이 작품 연결부 — 로어북 전체 교체에서 안 준 칸', () => {
  const given = (entry: LoreEntry, names: string[]): LoreEntry => ({ ...entry, given: names })

  it('given에 없는 제외 키워드는 옛 항목 값을 두고, 있으면 받은 값(빈 값 포함)으로 바꾼다', async () => {
    const s = loreSnapshot()
    ;(s.lorebooks as Obj[])[0].notKeywords = ['옛1', '옛2']
    ;(s.lorebooks as Obj[])[1].notKeywords = ['옛3']
    ;(s.lorebooks as Obj[])[2].notKeywords = ['옛4']
    const raw = await rawOf(s)
    const next = uumaiWorks.applyChanges!(raw, {
      lorebook: [
        // 제외 키워드를 안 줬다 (공통 도구가 빈 목록을 채워 넣는다)
        given(lore('가', { content: '고침' }), ['title', 'keys', 'content']),
        // 빈 목록을 실제로 줬다 → 비운다
        given(lore('나', { offKeys: [] }), ['title', 'keys', 'content', 'offKeys']),
        // 새 값을 줬다
        given(lore('다', { offKeys: ['새'] }), ['title', 'keys', 'content', 'offKeys'])
      ]
    })
    const byName = Object.fromEntries(loresOf(next).map((l) => [l.name, l]))
    expect(byName['가']).toMatchObject({ notKeywords: ['옛1', '옛2'], content: '고침' })
    expect(byName['나'].notKeywords).toEqual([])
    expect(byName['다'].notKeywords).toEqual(['새'])
  })

  it('given이 없는 옛 호출은 지금 동작 그대로다', async () => {
    const s = loreSnapshot()
    ;(s.lorebooks as Obj[])[0].notKeywords = ['옛1']
    const next = uumaiWorks.applyChanges!(await rawOf(s), {
      lorebook: [lore('가'), lore('나'), lore('다')]
    })
    expect(loresOf(next)[0].notKeywords).toEqual([])
  })

  it('mode·turnRange는 given에 없으면 옛 값을 두고, 있으면 바꾼다', async () => {
    const s = loreSnapshot()
    ;(s.lorebooks as Obj[])[0].isConstant = true
    ;(s.lorebooks as Obj[])[0].scanTurns = 3
    const raw = await rawOf(s)
    const kept = uumaiWorks.applyChanges!(raw, {
      lorebook: [given(lore('가'), ['title', 'keys', 'content']), lore('나'), lore('다')]
    })
    expect(loresOf(kept)[0]).toMatchObject({ isConstant: true, scanTurns: 3 })
    const set = uumaiWorks.applyChanges!(raw, {
      lorebook: [
        given(lore('가', { mode: 'keyword', turnRange: 1 }), ['title', 'keys', 'content', 'mode', 'turnRange']),
        lore('나'),
        lore('다')
      ]
    })
    expect(loresOf(set)[0]).toMatchObject({ isConstant: false, scanTurns: 1 })
  })

  it('given에 없는 키워드는 옛 항목 값을 두고, 있으면 받은 값(빈 값 포함)으로 바꾼다', async () => {
    const raw = await rawOf(loreSnapshot())
    const next = uumaiWorks.applyChanges!(raw, {
      lorebook: [
        // 키워드를 안 줬다 (공통 도구가 빈 글을 채워 넣는다)
        given(lore('가', { keys: '', content: '고침' }), ['title', 'content']),
        // 빈 키워드를 실제로 줬다 → 비운다
        given(lore('나', { keys: '' }), ['title', 'keys', 'content']),
        // 새 키워드를 줬다
        given(lore('다', { keys: '새1, 새2' }), ['title', 'keys', 'content'])
      ]
    })
    const byName = Object.fromEntries(loresOf(next).map((l) => [l.name, l]))
    expect(byName['가']).toMatchObject({ keywords: ['가키'], content: '고침' })
    expect(byName['나'].keywords).toEqual([])
    expect(byName['다'].keywords).toEqual(['새1', '새2'])
  })
})

describe('우마이 작품 연결부 — 검토 반영', () => {
  const known = [L(1), L(2), L(3)]

  it('제목을 고친 항목과 끼움·삭제가 겹치면 옛 항목의 숨은 설정을 다른 항목에 붙이지 않는다', async () => {
    const raw = await rawOf(loreSnapshot())
    // 가, 새, 나2(나의 제목을 고침), 다
    const a = uumaiWorks.applyChanges!(raw, {
      lorebook: [lore('가'), lore('새'), lore('나2'), lore('다')]
    })
    const byA = Object.fromEntries(loresOf(a).map((l) => [l.name, l]))
    expect(byA['가'].id).toBe(L(1))
    expect(byA['다'].id).toBe(L(3))
    for (const name of ['새', '나2']) {
      expect(known).not.toContain(byA[name].id)
      expect(byA[name]).toMatchObject({ priority: 0, group: '', dependsOnIds: [] })
      expect(byA[name].introSequences).toBeUndefined()
    }
    // 나2, 다 ('가'를 지우고 '나'의 제목을 고침)
    const b = uumaiWorks.applyChanges!(raw, { lorebook: [lore('나2'), lore('다')] })
    const byB = Object.fromEntries(loresOf(b).map((l) => [l.name, l]))
    expect(byB['다'].id).toBe(L(3))
    expect(known).not.toContain(byB['나2'].id)
    expect(byB['나2']).toMatchObject({ priority: 0, group: '' })
    // 제자리에서 제목만 고친 것은 옛 항목을 잇는다
    const c = uumaiWorks.applyChanges!(raw, { lorebook: [lore('가'), lore('나2'), lore('다')] })
    const byC = Object.fromEntries(loresOf(c).map((l) => [l.name, l]))
    expect(byC['나2']).toMatchObject({ id: L(2), priority: 4, dependsOnIds: [L(1)] })
  })

  it('새 로어북 항목은 bgmStop 칸을 보내지 않는다 (원본에 있는 값만 보낸다)', async () => {
    const raw = await rawOf(loreSnapshot())
    const next = uumaiWorks.applyChanges!(raw, {
      lorebookAdd: [lore('새')],
      lorebookPatch: [{ index: 0, content: '고침' }]
    })
    const fresh = loresOf(next).find((l) => l.name === '새')!
    expect(fresh).not.toHaveProperty('bgmStop')
    const body = uumaiSaveBody((next as { work: Obj }).work, { isPublish: false, workId: W })
    const sent = (body.lorebooks as Obj[]).find((l) => l.name === '새')!
    expect(sent.bgmStop).toBeUndefined()
    expect(sent.isConstant).toBe(false)
    const created = uumaiCreateBody({
      title: 'x',
      main: 'y',
      adult: false,
      characters: [],
      lorebook: [lore('새')]
    })
    expect((created.lorebooks as Obj[])[0].bgmStop).toBeUndefined()
    // 원본에 거짓으로 있던 값은 그대로 간다
    const s = loreSnapshot()
    ;(s.lorebooks as Obj[])[0].bgmStop = false
    const kept = uumaiSaveBody(s, { isPublish: false })
    expect((kept.lorebooks as Obj[])[0].bgmStop).toBe(false)
    expect((kept.lorebooks as Obj[])[1].bgmStop).toBeUndefined()
  })

  it('발행본이 있는 작품에 지금과 같은 공개 상태를 주면 초안을 발행하지 않는다', () => {
    const index = { draftSnapshotId: DRAFT, publishedSnapshotId: PUB }
    const raw = { id: W, snapshotId: DRAFT, ...index, work: snapshot() }
    const apply = uumaiWorks.applyChanges!
    // 같은 값 + 다른 칸 수정: 초안 저장으로만 나간다
    const same = apply(raw, { visibility: 'private', fields: { play_guide: '새 가이드' } }) as {
      work: Obj
      publish?: boolean
    }
    expect(same.publish).toBeUndefined()
    expect(same.work.publishStatus).toBe(2)
    expect(same.work.playGuide).toBe('새 가이드')
    expect(uumaiWorks.normalize(same).updatedAt).toContain('발행 안 된 초안')
    // 같은 값만 주면 바뀌는 것이 없다
    const only = apply(raw, { visibility: 'private' }) as { publish?: boolean }
    expect(only.publish).toBeUndefined()
    // 다른 값은 발행한다
    expect((apply(raw, { visibility: 'public' }) as { publish?: boolean }).publish).toBe(true)
    // 한 번도 발행하지 않은 작품에 주면 발행한다 (계획에서 상태가 draft → published로 보인다)
    const never = { ...raw, publishedSnapshotId: null }
    expect((apply(never, { visibility: 'private' }) as { publish?: boolean }).publish).toBe(true)
  })

  it('이미지 저장은 작품 저장 본문을 못 만들면 파일을 올리기 전에 멈춘다', async () => {
    const s = snapshot()
    delete s.isAdult
    const raw = rawFrom(s)
    const calls: string[] = []
    const io: WorkIo = {
      read: async () => ok({}, 404),
      write: async (_m, url) => {
        calls.push('write ' + url)
        return ok({})
      },
      send: async () => {
        calls.push('send')
        return new Response(null, { status: 204 })
      }
    }
    await expect(uumaiWorks.applyImages!(io, W, raw, { main: image('cover.png') })).rejects.toThrow(
      'WORK_SHAPE isAdult'
    )
    expect(calls).toEqual([])
  })

  it('extras에는 통계·계정·시각 값이 실리지 않고, 통계가 변해도 값이 같다', async () => {
    const stats = {
      likeCount: 12345,
      viewCount: 67890,
      chatCount: 4242,
      commentCount: 777,
      bookmarkCount: 31337,
      email: 'owner@example.test',
      ownerId: 'acct-99',
      author: { id: 'acct-99', email: 'owner@example.test', nickname: '작가' },
      draftSavedAt: '2026-11-12T00:00:00Z',
      publishedAt: '2026-11-11T00:00:00Z'
    }
    const read = async (extra: Obj): Promise<ReturnType<typeof uumaiWorks.normalize>> =>
      uumaiWorks.normalize(
        await uumaiWorks.readRaw(
          reader(draftOnly, { ...snapshot(), ...stats, ...extra }),
          W
        )
      )
    const first = await read({})
    const later = await read({ likeCount: 99999, viewCount: 1, chatCount: 5, commentCount: 8 })
    const dumped = JSON.stringify(first.extras)
    for (const secret of ['12345', '67890', '4242', '777', '31337', 'owner@', 'acct-99', '작가', '2026-11-12', '2026-11-11'])
      expect(dumped).not.toContain(secret)
    expect(Object.keys(first.extras!).join(' ')).not.toMatch(
      /like|view|chat_count|comment_count|bookmark|email|owner|author|account|saved_at|published_at/
    )
    expect(JSON.stringify(later.extras)).toBe(dumped)
    expect(JSON.stringify({ ...later, updatedAt: null })).toBe(
      JSON.stringify({ ...first, updatedAt: null })
    )
  })
})
