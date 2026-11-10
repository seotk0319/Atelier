import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { workSendRule } from '../src/main/works/adapters'
import { rplayWorks } from '../src/main/works/rplay'
import { canvasTiming, rplayCheckCanvas, rplayCompareCanvas } from '../src/main/works/rplay-canvas'
import { createWorkTools, toolMessage } from '../src/main/works/tools'
import type { WorkFetch, WorkRequest, WorkSend, WorkWrite } from '../src/main/works/types'

// 가짜 응답 모양은 2026-11-10 rplay.live 편집기 스크립트(DNLa6r8FjI·DYgrp5b9Hb·C4epbjDN3r)와
// 사람이 받아 둔 실제 내보내기 파일의 키를 따른다:
//   내보내기 = {exportVersion:2, exportedAt, sourceContentOid, sourceCanvasOid, bucketRegion, canvas{canvasLanguage…},
//              storyChat{advancedSettings}, nodes[{uid,hash,coordinates,name,type}], connections[], annotations[],
//              metadataSet{[노드 uid]:{type,nodeUid,…}}}
//   업로드 주소 응답 data = 주소 글, 가져오기 응답 {isImporting:true, importRunId}, 409 {error, changedKeys, currentSettings}
type Obj = Record<string, unknown>
const hx = (n: number): string => '65f0a1b2c3d4e5f6' + n.toString(16).padStart(8, '0')
const ME = hx(1)
const W = hx(100)
const CANVAS = hx(200)
const API = 'https://api.rplay.live'
const CHAT = 'https://chat-api.rplay.live/story-chat'
const ACCOUNT = { oid: ME, loginType: 'rplay' }
const STORAGE =
  'https://bucket.example.com/story-chat/canvas-import/' + CANVAS + '.json?X-Amz-Signature=abc'
const acct = '&platformType=rplay&lang=ko&requestorOid=' + ME + '&loginType=rplay'

const ok = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function canvasFile(extra: { story?: string; language?: string; liteMode?: boolean } = {}): Obj {
  return {
    exportVersion: 2,
    exportedAt: '2026-11-10T00:00:00.000Z',
    sourceContentOid: W,
    sourceCanvasOid: CANVAS,
    bucketRegion: 'ap-northeast-2',
    canvas: {
      canvasLanguage: extra.language ?? 'ko',
      compilerVersion: 3,
      useKRJPGuidelines: false
    },
    storyChat: {
      advancedSettings: { liteMode: extra.liteMode ?? false, disableDialogueCue: false }
    },
    nodes: [
      {
        uid: 'u-user',
        hash: 'aaaaa',
        coordinates: { x: 0, y: 0 },
        name: 'user-node',
        type: 'user'
      },
      {
        uid: 'u-s1',
        hash: 'bbbbb',
        coordinates: { x: 100, y: 100 },
        name: 'story-node',
        type: 'story'
      },
      {
        uid: 'u-c1',
        hash: 'ccccc',
        coordinates: { x: 700, y: 100 },
        name: 'character-node',
        type: 'character'
      }
    ],
    connections: [
      {
        uid: 'k1',
        sourceNodeId: 'u-c1',
        sourceOutputPortName: 'character',
        targetNodeId: 'u-s1',
        targetInputPortName: 'characters',
        targetInputIndex: 1,
        connectionType: 'character'
      },
      {
        uid: 'k2',
        sourceNodeId: 'u-user',
        sourceOutputPortName: 'user',
        targetNodeId: 'u-s1',
        targetInputPortName: 'characters',
        targetInputIndex: 1,
        connectionType: 'character'
      }
    ],
    annotations: [],
    metadataSet: {
      'u-user': {
        type: 'user',
        nodeUid: 'u-user',
        name: '유저',
        text: '유저 설정',
        useTokenBlock: true
      },
      'u-s1': {
        type: 'story',
        nodeUid: 'u-s1',
        title: '첫 이야기',
        coreContext: extra.story ?? '중요 정보',
        prologue: '시작',
        sort: 0,
        isStart: true,
        coreContextTokenCount: 3,
        advancedSettings: { liteMode: false }
      },
      'u-c1': { type: 'character', nodeUid: 'u-c1', name: '하나', text: '설정', priority: 1 }
    }
  }
}

/** 서버가 가져온 뒤 내보낼 때 붙이는 값 (사람 메모: createdAt·updatedAt·textTokenCount) */
function served(file: Obj): Obj {
  const out = structuredClone(file)
  out.exportedAt = new Date().toISOString()
  for (const m of Object.values(out.metadataSet as Record<string, Obj>)) {
    m.createdAt = '2026-11-10T01:00:00.000Z'
    m.updatedAt = '2026-11-10T01:00:00.000Z'
    m.textTokenCount = 7
  }
  return out
}

interface Site {
  read: WorkFetch
  write: WorkWrite
  send: WorkSend
  calls: string[]
  bodies: Obj[]
  sent: WorkRequest[]
  state: { exported: Obj; isImporting: boolean; polls: number; language: string }
}

function site(
  opts: {
    settingsChoice?: boolean
    importStatus?: number
    neverEnds?: boolean
    applyAs?: (uploaded: Obj) => Obj
  } = {}
): Site {
  const calls: string[] = []
  const bodies: Obj[] = []
  const sent: WorkRequest[] = []
  const state = {
    exported: served(canvasFile({ story: '예전 중요 정보' })),
    isImporting: false,
    polls: 0,
    language: 'ko'
  }
  let uploaded: Uint8Array | null = null
  let asked = false
  const withAccount = <T extends object>(fn: T): T =>
    Object.assign(fn, { rplayAccount: () => ACCOUNT })

  const read: WorkFetch = withAccount(async (url: string) => {
    calls.push('GET ' + url)
    if (!rplayWorks.readAllowed(url)) throw new Error('UNAPPROVED_READ_ROUTE ' + url)
    const u = new URL(url)
    const q = u.searchParams
    if (u.pathname === '/story-chat/chat-content')
      return ok({ _id: W, canvasOid: CANVAS, status: 'wip', creatorOid: ME })
    if (u.pathname === '/story-chat/chat-canvas/export') {
      if (q.get('canvasOid') !== CANVAS) return ok({ error: 'not-found' }, 404)
      return ok({ ...state.exported, exportedAt: new Date().toISOString() })
    }
    if (u.pathname === '/story-chat/chat-canvas') {
      expect(q.get('includeMetadata')).toBe('false')
      if (state.isImporting && ++state.polls >= 2 && !opts.neverEnds) {
        // 가져오기가 끝났다: 올린 파일이 캔버스가 된다
        const file = JSON.parse(new TextDecoder().decode(uploaded!)) as Obj
        state.exported = served(opts.applyAs ? opts.applyAs(file) : file)
        state.isImporting = false
      }
      return ok({
        canvas: { _id: CANVAS, isImporting: state.isImporting, canvasLanguage: state.language }
      })
    }
    if (u.pathname === '/upload') return ok(STORAGE)
    return ok({}, 404)
  })

  const write: WorkWrite = withAccount(async (method: string, url: string, body?: unknown) => {
    calls.push(method + ' ' + url)
    if (!rplayWorks.writeAllowed!(method, url)) throw new Error('UNAPPROVED_WRITE_ROUTE ' + url)
    const b = (body ?? {}) as Obj
    bodies.push(b)
    if (new URL(url).pathname === '/story-chat/chat-canvas/import') {
      if (opts.importStatus) return ok({ error: 'boom' }, opts.importStatus)
      if (!uploaded) return ok({ error: 'IMPORT_FILE_MISSING' }, 400)
      const hash = createHash('sha256').update(uploaded).digest('hex')
      if (b.sourceHash !== hash) return ok({ error: 'IMPORT_FILE_CHANGED' }, 409)
      if (opts.settingsChoice && !b.settingsChoice) {
        asked = true
        return ok(
          {
            error: 'IMPORT_SETTINGS_CHOICE_REQUIRED',
            changedKeys: ['liteMode'],
            currentSettings: { liteMode: false },
            importedSettings: { liteMode: true }
          },
          409
        )
      }
      if (opts.settingsChoice) expect(asked).toBe(true)
      state.isImporting = true
      return ok({ isImporting: true, importRunId: 'run-1' })
    }
    return ok({}, 404)
  })

  const send: WorkSend = withAccount(async (request: WorkRequest) => {
    // collector와 같은 허용 검사 (주소·본문 종류·헤더 이름)
    const rule = workSendRule('rplay', request)
    expect(rule.auth).toBe('none')
    sent.push(request)
    calls.push(request.method + ' ' + request.url)
    uploaded = request.bytes!.data
    return new Response('', { status: 200 })
  })
  return { read, write, send, calls, bodies, sent, state }
}

const encode = (v: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(v, null, 2))

function tools(
  s: Site,
  files: Record<string, Uint8Array>
): { run: (name: string, args?: Obj) => Promise<Obj>; snaps: { name: string; raw: unknown }[] } {
  const snaps: { name: string; raw: unknown }[] = []
  const all = createWorkTools({
    reader: () => s.read,
    writer: () => s.write,
    sender: () => s.send,
    snapshot: async (_platform, name, raw) => {
      snaps.push({ name, raw: structuredClone(raw) })
      return 'C:/snap/' + name + '/' + snaps.length + '.json'
    },
    readFile: async () => '',
    readBinary: async (path, max) => {
      const f = files[path]
      if (!f || f.byteLength > max) throw new Error('BAD_FILE')
      return f
    },
    listFolder: async () => []
  })
  return {
    run: (name, args = {}) => all.find((t) => t.name === name)!.run(args) as Promise<Obj>,
    snaps
  }
}

beforeEach(() => {
  canvasTiming.sleep = async () => undefined
})
afterEach(() => {
  canvasTiming.sleep = (ms) => new Promise((done) => setTimeout(done, ms))
  canvasTiming.limit = 10 * 60_000
})

describe('알플레이 캔버스 허용 주소', () => {
  it('내보내기·상태 확인·업로드 주소·가져오기만 연다', () => {
    const r = rplayWorks.readAllowed
    expect(r(CHAT + '/chat-canvas/export?canvasOid=' + CANVAS + acct)).toBe(true)
    expect(r(CHAT + '/chat-canvas/export?canvasOid=' + CANVAS + '&x=1' + acct)).toBe(false)
    expect(r(CHAT + '/chat-canvas?canvasOid=' + CANVAS + '&includeMetadata=false' + acct)).toBe(
      true
    )
    expect(r(CHAT + '/chat-canvas?canvasOid=' + CANVAS + '&includeMetadata=maybe' + acct)).toBe(
      false
    )
    const upload = (key: string, access = 'private', context?: unknown): string =>
      API +
      '/upload?key=' +
      encodeURIComponent(key) +
      '&filetype=application%2Fjson&access=' +
      access +
      '&context=' +
      encodeURIComponent(JSON.stringify(context ?? { uploadType: 'story-chat', contentOid: W })) +
      acct
    expect(r(upload('story-chat/canvas-import/' + CANVAS + '.json'))).toBe(true)
    expect(r(upload('story-chat/canvas-import/' + CANVAS + '.json', 'public'))).toBe(false)
    expect(r(upload('profilePhoto/' + CANVAS + '.json'))).toBe(false)
    expect(r(upload('story-chat/canvas-import/../x.json'))).toBe(false)
    expect(
      r(
        upload('story-chat/canvas-import/' + CANVAS + '.json', 'private', {
          uploadType: 'story-chat',
          contentOid: W,
          getMultipleUrls: true
        })
      )
    ).toBe(false)

    const w = rplayWorks.writeAllowed!
    expect(w('POST', CHAT + '/chat-canvas/import')).toBe(true)
    expect(w('POST', CHAT + '/chat-canvas/export')).toBe(false)
    expect(w('POST', CHAT + '/import-progress/' + CANVAS)).toBe(false)
    // 저장소 PUT은 API가 내준 주소가 아니면 열지 않는다
    expect(rplayWorks.sendRule!('PUT', STORAGE)).toBeNull()
  })
})

describe('알플레이 캔버스 규격 검사와 대조', () => {
  it('내보내기 파일 모양이면 문제 없음, 어긋나면 어디인지', () => {
    const good = rplayCheckCanvas(canvasFile())
    expect(good.problems).toEqual([])
    expect(good.summary).toMatchObject({
      version: 2,
      language: 'ko',
      nodes: 3,
      nodeTypes: { user: 1, story: 1, character: 1 },
      connections: 2,
      metadata: 3,
      sourceWorkId: W
    })

    const bad = canvasFile()
    bad.exportVersion = 3
    ;(bad.nodes as Obj[]).push({
      uid: 'u-s1',
      hash: 'x',
      coordinates: { x: 0 },
      name: '',
      type: 'story'
    })
    ;(bad.connections as Obj[]).push({ uid: 'k1', sourceNodeId: 'nope', targetNodeId: 'u-s1' })
    const meta = bad.metadataSet as Record<string, Obj>
    meta['u-ghost'] = { type: 'story' }
    meta['u-c1'].type = 'story'
    delete (bad.canvas as Obj).canvasLanguage
    const problems = rplayCheckCanvas(bad).problems.join('\n')
    expect(problems).toContain('exportVersion 3')
    expect(problems).toContain('canvas.canvasLanguage 없음')
    expect(problems).toContain('nodes[3].uid 겹침')
    expect(problems).toContain('nodes[3].coordinates')
    expect(problems).toContain('connections[2].uid 겹침')
    expect(problems).toContain('connections[2].sourceNodeId 노드 없음')
    expect(problems).toContain('metadataSet[u-ghost] 맞는 노드 uid 없음')
    expect(problems).toContain('metadataSet[u-c1].type이 노드 type과 다름')
    expect(rplayCheckCanvas([]).problems).toEqual(['JSON 맨 위가 객체가 아님'])
  })

  it('서버가 붙이는 값은 빼고, 연결은 번호 없이 양 끝으로 견준다', () => {
    const file = canvasFile()
    const back = served(file)
    ;(back.connections as Obj[]).forEach((c, i) => (c.uid = 'server-' + i))
    ;(back.metadataSet as Record<string, Obj>)['u-s1']._id = hx(9)
    expect(rplayCompareCanvas(file, back)).toEqual([])

    const changed = served(file)
    ;(changed.metadataSet as Record<string, Obj>)['u-s1'].coreContext = '잘림'
    ;(changed.nodes as Obj[]).pop()
    ;(changed.connections as Obj[]).pop()
    ;((changed.storyChat as Obj).advancedSettings as Obj).liteMode = true
    const out = rplayCompareCanvas(file, changed)
    expect(out).toContain('metadataSet u-s1 .coreContext')
    expect(out).toContain('nodes u-c1 없음')
    expect(out).toContain('connections 파일에만 1개')
    expect(out).toContain('storyChat.advancedSettings.liteMode')
    expect(rplayCompareCanvas(file, changed, { keepCurrentSettings: true })).not.toContain(
      'storyChat.advancedSettings.liteMode'
    )
  })
})

describe('알플레이 캔버스 도구', () => {
  it('sites_list에 can_canvas, 캔버스 없는 플랫폼은 분명한 오류', async () => {
    const s = site()
    const { run } = tools(s, {})
    const sites = (await run('sites_list')).sites as Obj[]
    expect(sites.find((x) => x.site === 'rplay')).toMatchObject({ can_canvas: true })
    expect(sites.find((x) => x.site === 'eden')).toMatchObject({ can_canvas: false })
    await expect(run('canvas_export', { site: 'eden', work_id: W })).rejects.toThrow('NO_CANVAS')
    expect(toolMessage(new Error('NO_CANVAS'))).toContain('can_canvas')
  })

  it('canvas_export는 읽기만 하고 내보낸 JSON을 파일로 남긴다', async () => {
    const s = site()
    const { run, snaps } = tools(s, {})
    const out = await run('canvas_export', { site: '알플', work_id: W })
    expect(out).toMatchObject({
      site: 'rplay',
      canvas_id: CANVAS,
      file: 'C:/snap/' + W + '__canvas/1.json',
      summary: { nodes: 3, connections: 2, language: 'ko' }
    })
    expect(snaps[0].raw).toMatchObject({ exportVersion: 2, sourceCanvasOid: CANVAS })
    expect(s.calls.every((c) => c.startsWith('GET '))).toBe(true)
    expect(s.calls.some((c) => c.includes('/chat-canvas/export?canvasOid=' + CANVAS))).toBe(true)
  })

  it('계획은 쓰지 않고, 적용은 업로드 주소 → PUT → 가져오기 → 상태 확인 → 다시 내보내 대조', async () => {
    const s = site()
    const next = canvasFile({ story: '새 중요 정보' })
    // BOM이 붙은 파일도 편집기처럼 BOM을 빼고 올린다
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...encode(next)])
    const { run, snaps } = tools(s, { 'D:/work/canvas.json': withBom })

    const plan = await run('canvas_plan', {
      site: 'rplay',
      work_id: W,
      file: 'D:/work/canvas.json'
    })
    expect(plan.plan_id).toMatch(/^[0-9a-f]{8}$/)
    expect(plan).toMatchObject({
      target: { canvas_id: CANVAS, language: 'ko' },
      changes: { nodes_kept: 3, nodes_added: 0, nodes_removed: 0, different_places: 1 }
    })
    expect((plan.changes as Obj).preview).toEqual(['metadataSet u-s1 .coreContext'])
    expect(s.calls.every((c) => c.startsWith('GET '))).toBe(true)
    expect(s.sent).toHaveLength(0)

    const done = await run('canvas_apply', { plan_id: plan.plan_id })
    expect(done).toMatchObject({
      imported: true,
      verified: true,
      mismatch_count: 0,
      run_id: 'run-1',
      backup: 'C:/snap/' + W + '__canvas/1.json'
    })
    // 백업은 가져오기 직전 캔버스
    expect((snaps[0].raw as Obj).metadataSet).toMatchObject({
      'u-s1': { coreContext: '예전 중요 정보' }
    })

    const order = s.calls
      .filter((c) => !c.includes('/chat-content?'))
      .map((c) => c.replace(/\?.*$/, ''))
      .slice(-7)
    expect(order).toEqual([
      'GET ' + CHAT + '/chat-canvas',
      'GET ' + API + '/upload',
      'PUT ' + STORAGE.replace(/\?.*$/, ''),
      'POST ' + CHAT + '/chat-canvas/import',
      'GET ' + CHAT + '/chat-canvas',
      'GET ' + CHAT + '/chat-canvas',
      'GET ' + CHAT + '/chat-canvas/export'
    ])
    // 올린 바이트 = BOM 뺀 글, 해시는 그 바이트의 SHA-256 16진수, 저장소에는 Content-Type·platform-type 헤더만
    const put = s.sent[0]
    expect(put).toMatchObject({
      method: 'PUT',
      url: STORAGE,
      bytes: { contentType: 'application/json' },
      headers: { 'content-type': 'application/json', 'platform-type': 'rplay' }
    })
    expect(Array.from(put.bytes!.data)).toEqual(Array.from(encode(next)))
    const body = s.bodies.at(-1)!
    expect(body).toEqual({
      canvasOid: CANVAS,
      debugLog: false,
      sourceHash: createHash('sha256').update(encode(next)).digest('hex'),
      platformType: 'rplay',
      lang: 'ko',
      requestorOid: ME,
      loginType: 'rplay'
    })
    const upload = new URL(s.calls.find((c) => c.includes('/upload?'))!.slice(4))
    expect(upload.searchParams.get('key')).toBe('story-chat/canvas-import/' + CANVAS + '.json')
    expect(JSON.parse(upload.searchParams.get('context')!)).toEqual({
      uploadType: 'story-chat',
      contentOid: W
    })
    // 계획은 한 번만
    await expect(run('canvas_apply', { plan_id: plan.plan_id })).rejects.toThrow('PLAN_NOT_FOUND')
  })

  it('계획 뒤 파일이나 캔버스가 바뀌면 PLAN_STALE로 멈춘다', async () => {
    const s = site()
    const files = { 'D:/a.json': encode(canvasFile({ story: '하나' })) }
    const { run } = tools(s, files)
    const p1 = await run('canvas_plan', { site: 'rplay', work_id: W, file: 'D:/a.json' })
    files['D:/a.json'] = encode(canvasFile({ story: '둘' }))
    await expect(run('canvas_apply', { plan_id: p1.plan_id })).rejects.toThrow('PLAN_STALE')

    const p2 = await run('canvas_plan', { site: 'rplay', work_id: W, file: 'D:/a.json' })
    ;(s.state.exported.metadataSet as Record<string, Obj>)['u-c1'].name = '다른 사람이 고침'
    await expect(run('canvas_apply', { plan_id: p2.plan_id })).rejects.toThrow('PLAN_STALE')
    expect(s.calls.some((c) => c.startsWith('POST') || c.startsWith('PUT'))).toBe(false)
  })

  it('규격에 안 맞는 파일은 plan_id 없이 문제만 돌려준다', async () => {
    const s = site()
    const bad = canvasFile()
    delete (bad.metadataSet as Obj)['u-c1']
    const { run } = tools(s, {
      'D:/bad.json': encode(bad),
      'D:/x.txt': encode(bad),
      'D:/j.json': new TextEncoder().encode('{nope')
    })
    const out = await run('canvas_plan', { site: 'rplay', work_id: W, file: 'D:/bad.json' })
    expect(out.plan_id).toBeNull()
    expect(out.problems).toEqual(['nodes uid u-c1 의 metadataSet 없음'])
    await expect(
      run('canvas_plan', { site: 'rplay', work_id: W, file: 'D:/x.txt' })
    ).rejects.toThrow('BAD_CANVAS_FILE')
    await expect(
      run('canvas_plan', { site: 'rplay', work_id: W, file: 'D:/j.json' })
    ).rejects.toThrow('BAD_CANVAS_FILE JSON')
  })

  it('언어가 다르면 use_current_language, 고급 설정이 다르면 settings_choice가 있어야 한다', async () => {
    const s = site({ settingsChoice: true })
    const { run } = tools(s, {
      'D:/en.json': encode(canvasFile({ language: 'en' })),
      'D:/lite.json': encode(canvasFile({ liteMode: true }))
    })
    await expect(
      run('canvas_plan', { site: 'rplay', work_id: W, file: 'D:/en.json' })
    ).rejects.toThrow('IMPORT_LANGUAGE_MISMATCH en→ko')
    await expect(
      run('canvas_plan', { site: 'rplay', work_id: W, file: 'D:/lite.json' })
    ).rejects.toThrow('IMPORT_SETTINGS_CHOICE_REQUIRED liteMode')

    // 지금 설정 유지: 서버가 409로 물으면 settingsChoice와 서버가 준 currentSettings를 붙여 한 번 더 보낸다
    const plan = await run('canvas_plan', {
      site: 'rplay',
      work_id: W,
      file: 'D:/lite.json',
      settings_choice: 'current'
    })
    const done = await run('canvas_apply', { plan_id: plan.plan_id })
    expect(done).toMatchObject({ imported: true })
    const posts = s.bodies.filter((b) => b.sourceHash)
    expect(posts).toHaveLength(2)
    expect(posts[1]).toMatchObject({ settingsChoice: 'current', settingsBase: { liteMode: false } })

    // 언어: 지금 캔버스 언어로 넣기
    const s2 = site()
    const t2 = tools(s2, { 'D:/en.json': encode(canvasFile({ language: 'en' })) })
    const p2 = await t2.run('canvas_plan', {
      site: 'rplay',
      work_id: W,
      file: 'D:/en.json',
      use_current_language: true
    })
    expect(p2.warnings as string[]).toContainEqual(expect.stringContaining('지금 캔버스 언어(ko)'))
    // 서버는 지금 캔버스 언어로 넣는다
    const s2done = await t2.run('canvas_apply', { plan_id: p2.plan_id })
    expect(s2.bodies.at(-1)).toMatchObject({ languageMismatchAction: 'use-target-language' })
    expect(s2done).toMatchObject({ imported: true })
  })

  it('서버가 일부만 넣으면 verified false와 다른 곳', async () => {
    const s = site({
      applyAs: (f) => {
        const out = structuredClone(f)
        ;(out.metadataSet as Record<string, Obj>)['u-s1'].coreContext = '잘린 글'
        return out
      }
    })
    const { run } = tools(s, { 'D:/a.json': encode(canvasFile({ story: '긴 글' })) })
    const plan = await run('canvas_plan', { site: 'rplay', work_id: W, file: 'D:/a.json' })
    const done = await run('canvas_apply', { plan_id: plan.plan_id })
    expect(done).toMatchObject({
      imported: true,
      verified: false,
      mismatches: ['metadataSet u-s1 .coreContext']
    })
  })

  it('가져오기가 거절되면 imported false와 캔버스가 그대로인지', async () => {
    const s = site({ importStatus: 500 })
    const { run } = tools(s, { 'D:/a.json': encode(canvasFile({ story: '새 글' })) })
    const plan = await run('canvas_plan', { site: 'rplay', work_id: W, file: 'D:/a.json' })
    const done = await run('canvas_apply', { plan_id: plan.plan_id })
    expect(done).toMatchObject({ imported: false, canvas_changed: false })
    expect(String(done.error)).toMatch(/^IMPORT_UNCONFIRMED 500/)

    const s2 = site({ importStatus: 409 })
    const t2 = tools(s2, { 'D:/a.json': encode(canvasFile({ story: '새 글' })) })
    const p2 = await t2.run('canvas_plan', { site: 'rplay', work_id: W, file: 'D:/a.json' })
    expect(await t2.run('canvas_apply', { plan_id: p2.plan_id })).toMatchObject({
      imported: false,
      error: 'IMPORT_FAILED 409 boom',
      canvas_changed: false
    })
  })

  it('끝나지 않으면 한도에서 멈추고 확인하지 못했다고 알린다', async () => {
    canvasTiming.limit = 0
    const s = site({ neverEnds: true })
    const { run } = tools(s, { 'D:/a.json': encode(canvasFile({ story: '새 글' })) })
    const plan = await run('canvas_plan', { site: 'rplay', work_id: W, file: 'D:/a.json' })
    const done = await run('canvas_apply', { plan_id: plan.plan_id })
    expect(done).toMatchObject({ imported: false, error: 'IMPORT_TIMEOUT' })
    expect(toolMessage(new Error('IMPORT_TIMEOUT'))).toContain('canvas_export')
  })
})
