import { describe, expect, it } from 'vitest'
import { teapotCreateSnapshot, teapotWorks, type TeapotRaw } from '../src/main/works/teapot'
import { listQuery, listUrl } from '../src/main/works/teapot-core'
import type { WorkDraft, WorkFetch, WorkReadInit, WorkWrite } from '../src/main/works/types'

// 가짜 응답 모양은 2026-11-10 티팟 공개 스크립트에서 읽은 필드를 따른다:
//   호출형 함수 응답 {result:…} (함수 SDK), listCheckpoints {success, summary_only, checkpoints[{id,name,cp_status,time_saved}]},
//   getCheckpoint {checkpoint:{…, snapshot}}, snapshot = 편집기 폼(64408 모듈) 필드,
//   Firestore runQuery 응답 [{document:{name, fields:{x:{stringValue}}, createTime, updateTime}, readTime}].
const W = 'AbCdEf0123456789wxyz'
const UID = 'User0123456789abcdefABCDEF12'
const FN = 'https://asia-northeast3-chat-ai-7a275.cloudfunctions.net/'
type Obj = Record<string, unknown>

const ok = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function snapshot(): Obj {
  return {
    image:
      'https://firebasestorage.googleapis.com/v0/b/chat-ai-7a275.firebasestorage.app/o/main.webp?alt=media&token=t&v=1',
    char_name: '시험 작품',
    creator_uid: UID,
    oneline_description: '한 줄 소개',
    detail_description: '캐릭터 소개',
    prompt: '메인 프롬프트',
    worldview: '세계관',
    secret: '',
    output_format_prompt: '출력 형식',
    recommended_answer_prompt: '추천 답변',
    publicity: '1',
    prompt_mode: 'simple',
    keyword_books: [
      { title: '학교', keys: ['학교', '교실'], info: '학교 설명', indexLabel: 1 },
      { title: '마을', keys: ['마을'], info: '마을 설명', indexLabel: 2 }
    ],
    start_settings: [
      {
        setting_name: '시작 상황 1',
        start_circumstance: '배경',
        start_message: '첫 메시지',
        recommended_answers: ['a', 'b'],
        additional_prompt: '추가',
        additional_worldview: '',
        additional_secret: '',
        additional_example_dialogues: [],
        additional_output_format: ''
      },
      {
        setting_name: '둘째',
        start_circumstance: '',
        start_message: '둘째 메시지',
        recommended_answers: [],
        additional_prompt: '',
        additional_worldview: '',
        additional_secret: '',
        additional_example_dialogues: [],
        additional_output_format: ''
      }
    ],
    characters: [{ name: '유나', image: '', description: '조연', _sortKey: 'k1' }],
    circumstance_images: [
      { id: 'si-1', name: '1', circumstance: '교실', image: ['https://x/1.png'] }
    ]
  }
}

const summaries = (status: string | null = 'ACCEPTED'): Obj[] => [
  {
    id: 'cpOld',
    name: '제목없음 1',
    cp_status: null,
    time_saved: { _seconds: 100, _nanoseconds: 0 }
  },
  {
    id: 'cpNew',
    name: '제목없음 2',
    cp_status: status,
    time_saved: { _seconds: 200, _nanoseconds: 0 }
  },
  {
    id: 'cpAuto',
    name: '자동 저장',
    cp_status: 'AUTO_SAVED',
    time_saved: '1970-01-01T00:01:00.000Z'
  }
]

function reader(status: string | null = 'ACCEPTED'): {
  read: WorkFetch
  calls: [string, WorkReadInit | undefined][]
} {
  const calls: [string, WorkReadInit | undefined][] = []
  const read: WorkFetch = async (url, init) => {
    calls.push([url, init])
    if (init?.method === 'POST') expect(teapotWorks.readPostAllowed!(url, init)).toBe(true)
    if (url === FN + 'listCheckpoints')
      return ok({ result: { success: true, summary_only: true, checkpoints: summaries(status) } })
    if (url === FN + 'getCheckpoint') {
      const id = (JSON.parse(String(init?.body)) as { data: Obj }).data.checkpointId
      return ok({
        result: {
          success: true,
          checkpoint: { id, name: '제목없음 2', cp_status: status, snapshot: snapshot() }
        }
      })
    }
    return ok({}, 404)
  }
  return { read, calls }
}

function writer(
  reply: (url: string, body: Obj) => Response = () => ok({ result: { success: true } })
): {
  write: WorkWrite
  calls: [string, string, Obj][]
} {
  const calls: [string, string, Obj][] = []
  const write: WorkWrite = async (method, url, body) => {
    expect(teapotWorks.writeAllowed!(method, url)).toBe(true)
    calls.push([method, url, body as Obj])
    return reply(url, body as Obj)
  }
  return { write, calls }
}

async function load(status: string | null = 'ACCEPTED'): Promise<TeapotRaw> {
  return teapotWorks.readRaw(reader(status).read, W)
}

describe('티팟 허용 주소', () => {
  it('읽기는 정해진 함수·본문 모양과 계정 문서 아래 목록 조회만 허용한다', () => {
    const json = 'application/json'
    const allow = (url: string, body: string, contentType = json): boolean =>
      teapotWorks.readPostAllowed!(url, { method: 'POST', body, contentType })
    expect(
      allow(FN + 'listCheckpoints', JSON.stringify({ data: { characterId: W, summaryOnly: true } }))
    ).toBe(true)
    expect(
      allow(FN + 'getCheckpoint', JSON.stringify({ data: { characterId: W, checkpointId: 'cp1' } }))
    ).toBe(true)
    // 다른 함수, 다른 모양, 다른 종류는 막는다
    expect(allow(FN + 'submitCharacter', JSON.stringify({ data: { characterId: W } }))).toBe(false)
    expect(allow(FN + 'listCheckpoints', JSON.stringify({ data: { characterId: W } }))).toBe(false)
    expect(
      allow(
        FN + 'listCheckpoints',
        JSON.stringify({ data: { characterId: '../x', summaryOnly: true } })
      )
    ).toBe(false)
    expect(
      allow(
        FN + 'getCheckpoint',
        JSON.stringify({ data: { characterId: W, checkpointId: 'a', x: 1 } })
      )
    ).toBe(false)
    expect(
      allow(
        FN + 'listCheckpoints',
        JSON.stringify({ data: { characterId: W, summaryOnly: true } }),
        'text/plain'
      )
    ).toBe(false)
    expect(allow(listUrl(UID), listQuery('OC_draft'))).toBe(true)
    expect(allow(listUrl(UID), listQuery('OC_buffer'))).toBe(true)
    expect(allow(listUrl(UID) + '?x=1', listQuery('OC_buffer'))).toBe(false)
    expect(allow(listUrl('a/b'), listQuery('OC_buffer'))).toBe(false)
    expect(allow(listUrl(UID), listQuery('OC_buffer').replace('OC_buffer', 'chats'))).toBe(false)
    expect(
      allow(
        'https://firestore.googleapis.com/v1/projects/chat-ai-7a275/databases/(default)/documents:runQuery',
        listQuery('OC_buffer')
      )
    ).toBe(false)
    expect(teapotWorks.readAllowed(FN + 'listCheckpoints')).toBe(false)
  })

  it('쓰기는 임시저장·새 초안·삭제 함수 POST만 허용한다 (등록 submitCharacter는 막는다)', () => {
    for (const n of ['createCheckpoint', 'updateCheckpoint', 'createDraft', 'deleteNewCharacter'])
      expect(teapotWorks.writeAllowed!('POST', FN + n)).toBe(true)
    for (const n of [
      'submitCharacter',
      'cloneNewCharacter',
      'autoSaveCheckpoint',
      'deleteCheckpoint'
    ])
      expect(teapotWorks.writeAllowed!('POST', FN + n)).toBe(false)
    expect(teapotWorks.writeAllowed!('PUT', FN + 'createCheckpoint')).toBe(false)
    expect(
      teapotWorks.writeAllowed!(
        'POST',
        'https://us-central1-chat-ai-7a275.cloudfunctions.net/createCheckpoint'
      )
    ).toBe(false)
    expect(teapotWorks.writeAllowed!('POST', FN + 'createCheckpoint?x=1')).toBe(false)
  })
})

describe('티팟 목록', () => {
  it('계정 번호 없이는 읽지 않는다', async () => {
    await expect(teapotWorks.list(reader().read)).rejects.toThrow('TEAPOT_UID_REQUIRED')
  })

  it('초안·버퍼를 사이트처럼 고르고 최신 순·중복 없이 돌려준다', async () => {
    const doc = (id: string, fields: Obj): Obj => ({
      document: {
        name: 'projects/chat-ai-7a275/databases/(default)/documents/users/' + UID + '/X/' + id,
        fields,
        createTime: '2026-11-01T00:00:00Z',
        updateTime: '2026-11-02T00:00:00Z'
      },
      readTime: '2026-11-10T00:00:00Z'
    })
    const s = (v: string): Obj => ({ stringValue: v })
    const t = (v: string): Obj => ({ timestampValue: v })
    const read: WorkFetch = async (url, init) => {
      expect(url).toBe(listUrl(UID))
      expect(teapotWorks.readPostAllowed!(url, init!)).toBe(true)
      const body = String(init?.body)
      if (body === listQuery('OC_buffer'))
        return ok([
          doc('pub1', {
            char_name: s('공개작'),
            publicity: s('1'),
            status: s('ACCEPT'),
            time_updated: t('2026-11-05T00:00:00Z')
          }),
          doc('rev1', {
            char_name: s('심사작'),
            publicity: s('3'),
            status: s('MANUAL'),
            time_created: t('2026-11-07T00:00:00Z')
          }),
          { readTime: '2026-11-10T00:00:00Z' }
        ])
      return ok([
        doc('draft1', {
          char_name: s('초안'),
          active_checkpoint_id: s('cp1'),
          time_updated: t('2026-11-08T00:00:00Z')
        }),
        doc('empty1', { char_name: s('빈 초안'), time_updated: t('2026-11-09T00:00:00Z') }),
        doc('pub1', { char_name: s('공개작 초안'), active_checkpoint_id: s('cp9') })
      ])
    }
    const works = await teapotWorks.list(read, { uid: UID })
    expect(works).toEqual([
      {
        id: 'draft1',
        title: '초안',
        visibility: 'private',
        status: 'unregistered',
        updatedAt: '2026-11-08T00:00:00Z',
        characters: null
      },
      {
        id: 'rev1',
        title: '심사작',
        visibility: 'link',
        status: 'PENDING',
        updatedAt: '2026-11-07T00:00:00Z',
        characters: null
      },
      {
        id: 'pub1',
        title: '공개작',
        visibility: 'public',
        status: 'ACCEPT',
        updatedAt: '2026-11-05T00:00:00Z',
        characters: null
      }
    ])
  })
})

describe('티팟 읽기', () => {
  it('최신 저장 파일을 골라 snapshot을 공통 모양으로 옮긴다', async () => {
    const { read, calls } = reader()
    const raw = await teapotWorks.readRaw(read, W)
    expect(calls.map((c) => [c[0].slice(FN.length), JSON.parse(String(c[1]?.body))])).toEqual([
      ['listCheckpoints', { data: { characterId: W, summaryOnly: true } }],
      ['getCheckpoint', { data: { characterId: W, checkpointId: 'cpNew' } }]
    ])
    const body = teapotWorks.normalize(raw)
    expect(body).toMatchObject({
      id: W,
      title: '시험 작품',
      visibility: 'public',
      status: 'ACCEPTED',
      updatedAt: '1970-01-01T00:03:20.000Z',
      fields: {
        title: '시험 작품',
        subtitle: '한 줄 소개',
        description: '캐릭터 소개',
        main: '메인 프롬프트',
        worldview: '세계관',
        secret: '',
        output_format: '출력 형식',
        recommended_answer_prompt: '추천 답변'
      }
    })
    expect(body.lorebook[0]).toEqual({
      title: '학교',
      keys: '학교, 교실',
      content: '학교 설명',
      mode: null,
      offKeys: [],
      turnRange: null,
      offTurnRange: null
    })
    expect(body.startScenarios[0]).toMatchObject({
      title: '시작 상황 1',
      isDefault: true,
      content: '첫 메시지',
      situation: '배경',
      subPrompt: '추가'
    })
    expect(body.characters).toEqual([
      { id: 'k1', name: '유나', isMain: false, order: 0, details: '조연', info: '', imageCount: 0 }
    ])
    expect(teapotWorks.coverUrl!(raw)).toContain('main.webp')
    const groups = teapotWorks.imageGroups!(raw)
    expect(groups[0].images.map((i) => [i.label, i.isDefault])).toEqual([
      ['대표 이미지', true],
      ['교실', false]
    ])
  })

  it('저장 파일 칸에 없는 글 칸은 보여 주지 않는다', async () => {
    const raw = await load()
    delete raw.snapshot.worldview
    expect(teapotWorks.normalize(raw).fields.worldview).toBeUndefined()
  })

  it('다른 계정의 저장 파일이면 멈추고, 작품 번호 모양과 실패 응답을 확인한다', async () => {
    await expect(teapotWorks.readRaw(reader().read, W, { uid: 'other' })).rejects.toThrow(
      'NOT_OWNER'
    )
    await expect(teapotWorks.readRaw(reader().read, 'a/b')).rejects.toThrow('BAD_WORK_ID')
    const fail =
      (status: number, err: string): WorkFetch =>
      async () =>
        ok({ error: { status: err, message: 'x' } }, status)
    await expect(teapotWorks.readRaw(fail(404, 'NOT_FOUND'), W)).rejects.toThrow('WORK_NOT_FOUND')
    await expect(teapotWorks.readRaw(fail(403, 'PERMISSION_DENIED'), W)).rejects.toThrow(
      'LOGIN_REQUIRED'
    )
    const none: WorkFetch = async () => ok({ result: { success: true, checkpoints: [] } })
    await expect(teapotWorks.readRaw(none, W)).rejects.toThrow('TEAPOT_NO_CHECKPOINT')
    const odd: WorkFetch = async () => ok({ result: { list: [] } })
    await expect(teapotWorks.readRaw(odd, W)).rejects.toThrow('WORK_SHAPE checkpoints')
  })
})

describe('티팟 임시저장', () => {
  it('등록된 저장 파일을 고치면 새 저장 파일을 만든다 (등록·공개도는 그대로)', async () => {
    const raw = await load('ACCEPTED')
    const next = teapotWorks.applyChanges!(raw, {
      fields: { main: '새 프롬프트' },
      lorebookPatch: [{ index: 1, content: '마을 새 설명', keys: '마을, 광장' }],
      lorebookRemove: [0],
      lorebookAdd: [
        {
          title: '숲',
          keys: '숲',
          content: '숲 설명',
          mode: null,
          offKeys: [],
          turnRange: null,
          offTurnRange: null
        }
      ],
      startScenarios: [{ index: 1, content: '고친 둘째', situation: '둘째 배경' }],
      startScenariosAdd: [{ content: '셋째' }],
      characters: [{ index: 0, details: '주요 조연' }],
      charactersAdd: [{ name: '민지' }]
    }) as TeapotRaw
    expect(raw.snapshot.prompt).toBe('메인 프롬프트')
    expect(next.checkpoint).toEqual({ id: null, name: '제목없음 3', cp_status: null })
    const body = teapotWorks.normalize(next)
    expect(body.status).toBe('DRAFT')
    expect(body.visibility).toBe('public')
    expect(next.snapshot.keyword_books).toEqual([
      { title: '마을', keys: ['마을', '광장'], info: '마을 새 설명', indexLabel: 1 },
      { title: '숲', keys: ['숲'], info: '숲 설명', indexLabel: 2 }
    ])
    expect(body.startScenarios.map((s) => [s.title, s.content, s.situation])).toEqual([
      ['시작 상황 1', '첫 메시지', '배경'],
      ['둘째', '고친 둘째', '둘째 배경'],
      ['시작 상황 3', '셋째', '']
    ])
    expect(body.characters.map((c) => [c.name, c.details])).toEqual([
      ['유나', '주요 조연'],
      ['민지', '']
    ])

    const { write, calls } = writer(() =>
      ok({ result: { success: true, checkpoint: { id: 'cpMade' } } })
    )
    await teapotWorks.save!(write, W, next)
    expect(calls).toHaveLength(1)
    const [method, url, sent] = calls[0]
    expect([method, url]).toEqual(['POST', FN + 'createCheckpoint'])
    const data = sent.data as Obj
    expect(Object.keys(data)).toEqual(['characterId', 'name', 'snapshot'])
    expect(data.characterId).toBe(W)
    expect(data.name).toBe('제목없음 3')
    const snap = data.snapshot as Obj
    expect(snap.prompt).toBe('새 프롬프트')
    expect(snap.publicity).toBe('1')
    // 편집기처럼 characters를 맨 뒤로 옮길 뿐 다른 칸은 그대로 보낸다
    expect(Object.keys(snap).at(-1)).toBe('characters')
    expect(snap.circumstance_images).toEqual(snapshot().circumstance_images)
  })

  it('제출 전 수동 저장 파일이면 그 파일을 고친다', async () => {
    const raw = await load(null)
    const next = teapotWorks.applyChanges!(raw, { fields: { subtitle: '새 소개' } }) as TeapotRaw
    expect(next.checkpoint.id).toBe('cpNew')
    const { write, calls } = writer()
    await teapotWorks.save!(write, W, next)
    expect(calls[0][1]).toBe(FN + 'updateCheckpoint')
    expect(Object.keys(calls[0][2].data as Obj)).toEqual(['characterId', 'cpId', 'snapshot'])
    expect((calls[0][2].data as Obj).cpId).toBe('cpNew')
  })

  it('바뀐 것이 없으면 저장 파일을 정하지 않는다', async () => {
    const raw = await load('ACCEPTED')
    const next = teapotWorks.applyChanges!(raw, { fields: { main: '메인 프롬프트' } })
    expect(teapotWorks.normalize(next)).toEqual(teapotWorks.normalize(raw))
  })

  it('공개도·규격 밖 값·없는 기능은 막는다', async () => {
    const raw = await load()
    const bad =
      (changes: Parameters<NonNullable<typeof teapotWorks.applyChanges>>[1]): (() => unknown) =>
      () =>
        teapotWorks.applyChanges!(raw, changes)
    expect(bad({ visibility: 'private' })).toThrow('TEAPOT_VISIBILITY_NEEDS_SUBMIT')
    expect(bad({ fields: { title: 'x'.repeat(31) } })).toThrow('BAD_FIELD title')
    expect(bad({ fields: { title: ' ' } })).toThrow('BAD_FIELD title')
    expect(bad({ fields: { subtitle: 'x'.repeat(36) } })).toThrow('BAD_FIELD subtitle')
    expect(bad({ fields: { creator_comment: 'x' } })).toThrow('BAD_FIELD')
    expect(bad({ lorebookPatch: [{ index: 0, mode: 'always' }] })).toThrow('BAD_CHANGES')
    expect(bad({ lorebookPatch: [{ index: 0, offKeys: ['x'] }] })).toThrow('BAD_CHANGES')
    expect(
      bad({
        lorebookPatch: [{ index: 0, keys: Array.from({ length: 11 }, (_, i) => 'k' + i).join(',') }]
      })
    ).toThrow('BAD_LOREBOOK')
    expect(bad({ lorebookPatch: [{ index: 0, content: 'x'.repeat(2501) }] })).toThrow(
      'BAD_LOREBOOK'
    )
    expect(bad({ startScenarios: [{ index: 0, title: 'x'.repeat(21) }] })).toThrow('BAD_START')
    expect(bad({ startScenarios: [{ index: 0, dialogue: '대사' }] })).toThrow('BAD_CHANGES')
    expect(bad({ startScenariosRemove: [0] })).toThrow('KEEP_DEFAULT')
    expect(bad({ startScenarios: [{ index: 5, content: 'x' }] })).toThrow('BAD_INDEX')
    expect(bad({ charactersAdd: [{ name: 'a', info: 'b' }] })).toThrow('BAD_CHANGES')
  })

  it('수동 저장 파일이 49개면 새 저장 파일을 만들지 않는다', async () => {
    const raw = await load('ACCEPTED')
    raw.checkpoints = Array.from({ length: 49 }, (_, i) => ({
      id: 'c' + i,
      name: 'n',
      cp_status: null
    }))
    expect(() => teapotWorks.applyChanges!(raw, { fields: { main: '바뀜' } })).toThrow(
      'CHECKPOINT_LIMIT'
    )
  })

  it('저장 응답 모양이 다르면 짧은 오류로 멈춘다', async () => {
    const raw = await load('ACCEPTED')
    const next = teapotWorks.applyChanges!(raw, { fields: { main: '바뀜' } })
    await expect(
      teapotWorks.save!(writer(() => ok({ result: {} })).write, W, next)
    ).rejects.toThrow('SAVE_FAILED createCheckpoint SHAPE checkpoint.id')
    await expect(
      teapotWorks.save!(
        writer(() => ok({ error: { status: 'INVALID_ARGUMENT' } }, 400)).write,
        W,
        next
      )
    ).rejects.toThrow('SAVE_FAILED createCheckpoint 400 INVALID_ARGUMENT')
    await expect(teapotWorks.save!(writer().write, 'Other123', next)).rejects.toThrow('WORK_SHAPE')
  })
})

describe('티팟 삭제·새 작품', () => {
  it('삭제는 작품 관리 화면과 같은 함수를 부른다', async () => {
    const { write, calls } = writer()
    await teapotWorks.remove!(write, W)
    expect(calls).toEqual([['POST', FN + 'deleteNewCharacter', { data: { characterId: W } }]])
  })

  const draft = (more: Partial<WorkDraft> = {}): WorkDraft => ({
    title: '새 작품',
    main: '본문',
    adult: false,
    subtitle: '소개',
    characters: [],
    lorebook: [
      {
        title: '용어',
        keys: '용어',
        content: '설명',
        mode: null,
        offKeys: [],
        turnRange: null,
        offTurnRange: null
      }
    ],
    startScenarios: [{ title: '처음', content: '안녕', situation: '배경' }],
    hashtags: ['순애', ' 순애 '],
    ...more
  })

  it('새 초안 번호를 받아 비공개 첫 저장 파일을 만든다', async () => {
    const { write, calls } = writer((url) =>
      url.endsWith('createDraft')
        ? ok({ result: { draftId: 'NewDraft01' } })
        : ok({ result: { checkpoint: { id: 'cp1' } } })
    )
    expect(await teapotWorks.create!(write, draft())).toBe('NewDraft01')
    expect(calls.map((c) => c[1].slice(FN.length))).toEqual(['createDraft', 'createCheckpoint'])
    expect(calls[0][2]).toEqual({ data: {} })
    const data = calls[1][2].data as Obj
    expect(data.characterId).toBe('NewDraft01')
    expect(data.name).toBe('제목없음 1')
    const snap = data.snapshot as Obj
    expect(snap).toMatchObject({
      char_name: '새 작품',
      prompt: '본문',
      is_nsfw: false,
      publicity: '0',
      hash_tags: ['순애'],
      keyword_books: [{ title: '용어', keys: ['용어'], info: '설명', indexLabel: 1 }]
    })
    expect((snap.start_settings as Obj[])[0]).toMatchObject({
      setting_name: '처음',
      start_message: '안녕',
      start_circumstance: '배경'
    })
    expect(snap.creator_uid).toBeUndefined()
  })

  it('첫 저장 파일이 실패하면 남은 초안 번호를 알려 준다', async () => {
    const { write } = writer((url) =>
      url.endsWith('createDraft') ? ok({ result: { draftId: 'NewDraft01' } }) : ok({}, 500)
    )
    await expect(teapotWorks.create!(write, draft())).rejects.toThrow(
      'CREATE_FAILED draft NewDraft01'
    )
  })

  it('규격 밖 초안은 만들기 전에 막는다', () => {
    expect(() => teapotWorks.checkDraft!(draft({ title: '' }))).toThrow('BAD_FIELD title')
    expect(() => teapotWorks.checkDraft!(draft({ characters: [{ name: 'a' }] }))).toThrow(
      'NO_CHARACTERS'
    )
    expect(() => teapotWorks.checkDraft!(draft({ categories: ['로맨스'] }))).toThrow(
      'BAD_DRAFT categories'
    )
    expect(() => teapotWorks.checkDraft!(draft({ startScenarios: [{ dialogue: 'x' }] }))).toThrow(
      'BAD_CHANGES'
    )
    // 시작 상황을 주지 않으면 편집기 새 폼처럼 하나를 둔다
    expect(
      (teapotCreateSnapshot(draft({ startScenarios: [] })).start_settings as Obj[])[0].setting_name
    ).toBe('시작 상황 1')
  })
})
