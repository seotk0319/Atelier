import { describe, expect, it } from 'vitest'
import { workSendRule, workWriteAllowed } from '../src/main/works/adapters'
import { edenWorks } from '../src/main/works/eden'
import { babeWorks } from '../src/main/works/babe'
import { babeUploadImage } from '../src/main/works/babe-media'
import { coverTarget, loadImage } from '../src/main/works/media-tools'
import { createWorkTools, toolMessage, type WorkToolDeps } from '../src/main/works/tools'
import type {
  FormField,
  LocalImage,
  WorkFetch,
  WorkRequest,
  WorkSend,
  WorkWrite
} from '../src/main/works/types'

type Obj = Record<string, unknown>
const O = 'https://www.eden-chat.com'
const STORE = 'https://jhbfalszdxacwjnrrvms.supabase.co'
const W = '11111111-2222-4333-8444-555555555555'
const C1 = 'aaaaaaaa-0000-4000-8000-000000000001'
const C2 = 'aaaaaaaa-0000-4000-8000-000000000002'
const I1 = 'bbbbbbbb-0000-4000-8000-000000000001'
const I2 = 'bbbbbbbb-0000-4000-8000-000000000002'
const IMG = O + '/api/works/' + W + '/characters/' + C1 + '/images'
const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.signed-upload-token'

const ok = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

// 앞머리만 진짜인 작은 시험 파일
const bytes = (head: number[], size = 64): Uint8Array => {
  const data = new Uint8Array(size)
  data.set(head)
  return data
}
const WEBP = bytes([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])
const PNG = bytes([0x89, 0x50, 0x4e, 0x47])
const GIF = bytes([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
const image = (name: string, data = WEBP, type = 'image/webp'): LocalImage => ({ name, type, data })

/** 로컬 파일 흉내: 경로 → 바이트 */
function disk(files: Record<string, Uint8Array>): Pick<WorkToolDeps, 'readBinary' | 'listFolder'> {
  return {
    async readBinary(path, maxBytes) {
      const data = files[path]
      if (!data || data.byteLength > maxBytes) throw new Error('ENOENT')
      return data
    },
    async listFolder(folder) {
      const names = Object.keys(files)
        .filter((p) => p.startsWith(folder + '/'))
        .map((p) => p.slice(folder.length + 1))
      if (!names.length) throw new Error('ENOENT')
      return names
    }
  }
}

describe('허용 요청: 파일·저장소 통로', () => {
  const send = (
    platform: string,
    request: Partial<WorkRequest> & { method: string; url: string }
  ): unknown => {
    try {
      return workSendRule(platform, request as WorkRequest)
    } catch (error) {
      return (error as Error).message
    }
  }
  const form: FormField[] = [{ name: 'images', file: image('a.webp') }]

  it('에덴: 이미지 올리기·지우기는 그 캐릭터 이미지 주소로만', () => {
    expect(send('eden', { method: 'POST', url: IMG, form })).toEqual({
      auth: 'session',
      body: 'form'
    })
    expect(send('eden', { method: 'DELETE', url: IMG + '?imageId=' + I1 })).toEqual({
      auth: 'session',
      body: 'none'
    })
    const no = 'UNAPPROVED_WRITE_ROUTE'
    // 지울 이미지 번호가 없거나 모양이 다르면 나가지 않는다
    expect(send('eden', { method: 'DELETE', url: IMG })).toBe(no)
    expect(send('eden', { method: 'DELETE', url: IMG + '?imageId=all' })).toBe(no)
    expect(send('eden', { method: 'DELETE', url: IMG + '?imageId=' + I1 + '&force=1' })).toBe(no)
    expect(send('eden', { method: 'POST', url: IMG + '?imageId=' + I1, form })).toBe(no)
    // 본문 종류가 규칙과 다르거나 허용 안 된 헤더가 붙어도 막는다
    expect(send('eden', { method: 'POST', url: IMG, json: {} })).toBe(no)
    expect(send('eden', { method: 'POST', url: IMG, form, json: {} })).toBe(no)
    expect(send('eden', { method: 'POST', url: IMG, form, headers: { cookie: 'x' } })).toBe(no)
    expect(send('eden', { method: 'PUT', url: IMG, form })).toBe(no)
    expect(send('eden', { method: 'POST', url: O + '/api/works/' + W + '/images', form })).toBe(no)
    expect(send('eden', { method: 'POST', url: O + '/api/user/avatar', form })).toBe(no)
    expect(send('eden', { method: 'POST', url: IMG.replace('www.', 'evil.'), form })).toBe(no)
    expect(send('luna', { method: 'POST', url: IMG, form })).toBe(no)
  })

  it('에덴: 저장소는 표지 올리기 주소 하나, 에덴 로그인 쿠키는 붙지 않는다', () => {
    const put = STORE + '/storage/v1/object/upload/sign/work-covers/u1/' + W + '/c.webp?token='
    expect(send('eden', { method: 'PUT', url: put + TOKEN, form })).toEqual({
      auth: 'origin',
      body: 'form',
      headers: ['x-upsert']
    })
    expect(
      send('eden', { method: 'PUT', url: put + TOKEN, form, headers: { 'X-Upsert': 'false' } })
    ).toMatchObject({ auth: 'origin' })
    const no = 'UNAPPROVED_WRITE_ROUTE'
    expect(send('eden', { method: 'PUT', url: put.replace('?token=', ''), form })).toBe(no)
    expect(send('eden', { method: 'PUT', url: put + TOKEN + '&x=1', form })).toBe(no)
    expect(send('eden', { method: 'POST', url: put + TOKEN, form })).toBe(no)
    expect(send('eden', { method: 'PUT', url: put + TOKEN, json: {} })).toBe(no)
    expect(
      send('eden', { method: 'PUT', url: put + TOKEN, form, headers: { authorization: 'x' } })
    ).toBe(no)
    // 다른 저장 칸·다른 저장소·위로 올라가는 경로
    for (const url of [
      STORE + '/storage/v1/object/upload/sign/avatars/a.webp?token=' + TOKEN,
      STORE + '/storage/v1/object/work-covers/a.webp?token=' + TOKEN,
      STORE + '/storage/v1/object/upload/sign/work-covers/../avatars/a.webp?token=' + TOKEN,
      STORE + '/storage/v1/object/upload/sign/work-covers/a%2F..%2Fb.webp?token=' + TOKEN,
      STORE + '/rest/v1/works?token=' + TOKEN,
      'https://other.supabase.co/storage/v1/object/upload/sign/work-covers/a.webp?token=' + TOKEN
    ])
      expect(send('eden', { method: 'PUT', url, form })).toBe(no)
  })

  it('에덴: 표지·판본 JSON 요청은 열고, 자동 번역 주소는 닫아 둔다', () => {
    const base = O + '/api/works/' + W
    expect(workWriteAllowed('eden', 'POST', base + '/upload-cover/signed-url')).toBe(true)
    expect(workWriteAllowed('eden', 'POST', base + '/upload-cover')).toBe(true)
    expect(workWriteAllowed('eden', 'POST', base + '/translations/zh-TW/cover')).toBe(true)
    expect(workWriteAllowed('eden', 'PUT', base + '/translations/en')).toBe(true)
    expect(workWriteAllowed('eden', 'PUT', IMG + '/reorder')).toBe(true)
    // 돈이 드는 자동 번역과 그 주변
    expect(workWriteAllowed('eden', 'POST', base + '/translations/en')).toBe(false)
    expect(workWriteAllowed('eden', 'POST', base + '/translation-drafts')).toBe(false)
    expect(workWriteAllowed('eden', 'PATCH', base + '/translation-drafts/1')).toBe(false)
    expect(workWriteAllowed('eden', 'PATCH', base + '/translations/en')).toBe(false)
    expect(workWriteAllowed('eden', 'DELETE', base + '/translations/en')).toBe(false)
    expect(workWriteAllowed('eden', 'PUT', base + '/translations')).toBe(false)
    expect(workWriteAllowed('eden', 'PUT', base + '/translations/en/cover')).toBe(false)
    expect(workWriteAllowed('eden', 'POST', base + '/translations/en/images/' + C1)).toBe(false)
    expect(workWriteAllowed('eden', 'POST', IMG)).toBe(false)
    expect(workWriteAllowed('eden', 'DELETE', IMG)).toBe(false)
  })

  it('베이비챗: 토큰 받기·gif 변환·Blob 저장소 세 곳만, 저장소에는 로그인 정보를 붙이지 않는다', () => {
    const cookie = { name: 'bc__session', domain: 'babechat.ai' }
    expect(
      send('babe', { method: 'POST', url: 'https://babechat.ai/api/upload', json: {} })
    ).toEqual({ auth: 'cookie', body: 'json', cookieFromBearer: cookie })
    expect(
      send('babe', { method: 'POST', url: 'https://babechat.ai/api/convert-gif', form })
    ).toEqual({ auth: 'cookie', body: 'form', cookieFromBearer: cookie })
    const blob = 'https://vercel.com/api/blob/?pathname=' + W + '.webp'
    const data = { data: WEBP, contentType: 'image/webp' }
    expect(
      send('babe', {
        method: 'PUT',
        url: blob,
        bytes: data,
        headers: { authorization: 'Bearer t', 'x-api-version': '13' }
      })
    ).toMatchObject({ auth: 'none', body: 'bytes' })
    const no = 'UNAPPROVED_WRITE_ROUTE'
    expect(send('babe', { method: 'PUT', url: blob, bytes: data, headers: { cookie: 'a' } })).toBe(
      no
    )
    expect(send('babe', { method: 'PUT', url: blob + '&x=1', bytes: data })).toBe(no)
    expect(send('babe', { method: 'PUT', url: blob.replace('.webp', '.html'), bytes: data })).toBe(
      no
    )
    expect(send('babe', { method: 'PUT', url: blob.replace(W, '../' + W), bytes: data })).toBe(no)
    expect(send('babe', { method: 'DELETE', url: blob })).toBe(no)
    expect(
      send('babe', {
        method: 'PUT',
        url: 'https://vercel.com/api/blob/delete?pathname=' + W + '.webp',
        bytes: data
      })
    ).toBe(no)
    expect(
      send('babe', { method: 'POST', url: 'https://babechat.ai/api/upload?x=1', json: {} })
    ).toBe(no)
    expect(
      send('babe', { method: 'POST', url: 'https://babechat.ai/api/payments', json: {} })
    ).toBe(no)
    expect(send('babe', { method: 'POST', url: 'https://evil.ai/api/upload', json: {} })).toBe(no)
    // 에덴 주소를 베이비챗 통로로, 베이비챗 주소를 에덴 통로로 보낼 수 없다
    expect(send('babe', { method: 'POST', url: IMG, form })).toBe(no)
    expect(send('eden', { method: 'POST', url: 'https://babechat.ai/api/upload', json: {} })).toBe(
      no
    )
  })
})

describe('로컬 이미지 읽기 제한', () => {
  const rules = { extensions: ['webp', 'png'], maxBytes: 100 }
  const deps = disk({
    'D:/a/ok.webp': WEBP,
    'D:/a/ok.PNG': PNG,
    'D:/a/fake.webp': PNG,
    'D:/a/big.webp': bytes([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50], 101),
    'D:/a/empty.webp': new Uint8Array(0),
    'D:/a/notes.txt': WEBP,
    'D:/a/anim.gif': GIF
  }) as WorkToolDeps

  it('허용 확장자·크기·실제 종류가 맞을 때만 읽는다', async () => {
    expect(await loadImage('D:/a/ok.webp', deps, rules)).toMatchObject({
      name: 'ok.webp',
      type: 'image/webp'
    })
    expect(
      (await loadImage('D:\\a\\ok.PNG', { ...deps, readBinary: async () => PNG }, rules)).name
    ).toBe('ok.PNG')
    for (const path of [
      'D:/a/fake.webp', // 확장자만 webp
      'D:/a/big.webp', // 한도 초과
      'D:/a/empty.webp',
      'D:/a/notes.txt', // 이미지 확장자가 아님
      'D:/a/anim.gif', // 이 규칙이 받지 않는 종류
      'D:/a/missing.webp',
      'D:/a/',
      42
    ])
      await expect(loadImage(path, deps, rules)).rejects.toThrow('BAD_IMAGE')
  })

  it('표지 파일 이름 → 자리', () => {
    const langs = ['ko', 'en', 'ja', 'zh-TW', 'zh-CN']
    const t = (name: string): string | null => coverTarget(name, langs, 'ko')
    expect(t('eden.webp')).toBe('source')
    expect(t('cover.webp')).toBe('source')
    expect(t('표지.webp')).toBe('source')
    expect(t('ko.webp')).toBe('source')
    expect(t('표지_KO.webp')).toBe('source')
    expect(t('cover_en.webp')).toBe('en')
    expect(t('EN.webp')).toBe('en')
    expect(t('표지-ja.webp')).toBe('ja')
    expect(t('작품 표지 jp.webp')).toBe('ja')
    expect(t('zh-tw.webp')).toBe('zh-TW')
    expect(t('cover_zh-CN.webp')).toBe('zh-CN')
    expect(t('eden-tw.webp')).toBe('zh-TW')
    // 언어 코드로 끝나 보여도 구분 글자가 없으면 판본으로 보지 않는다
    expect(t('garden.webp')).toBeNull()
    expect(t('animation.webp')).toBeNull()
    expect(t('1.webp')).toBeNull()
    // 그 작품에 없는 언어
    expect(t('cover_th.webp')).toBeNull()
  })
})

// ───────────── 에덴 흉내 ─────────────

function eden(): {
  read: WorkFetch
  write: WorkWrite
  send: WorkSend
  calls: string[]
  images: Record<string, Obj[]>
  work: Obj
  editions: Record<string, Obj>
  stored: Record<string, FormField[]>
  failUpload: boolean
} {
  const s = {
    calls: [] as string[],
    failUpload: false,
    work: {
      id: W,
      title: '작품',
      subtitle: '',
      description: '소개',
      scenario_settings: '메인',
      visibility: 'private',
      status: 'draft',
      cover_image_url: 'https://cdn.example/old.webp',
      lorebook: [],
      start_scenarios: [{ id: 1, title: '기본', isDefault: true, detailedSettings: '시작' }]
    } as Obj,
    characters: [
      { id: C1, character_name: '주연', is_main_character: true, character_order: 0 },
      { id: C2, character_name: '조연', is_main_character: false, character_order: 1 }
    ] as Obj[],
    images: {
      [C1]: [
        {
          id: I1,
          url: 'https://cdn.example/1.webp',
          image_code: 'aaaaa',
          visibility: 'public',
          is_default: true
        },
        {
          id: I2,
          url: 'https://cdn.example/2.webp',
          image_code: 'bbbbb',
          visibility: 'public',
          is_default: false
        }
      ],
      [C2]: []
    } as Record<string, Obj[]>,
    editions: {
      en: {
        language_code: 'en',
        exists: true,
        status: 'active',
        stale: false,
        work: {
          title: 'Work',
          scenario_settings: 'Main',
          cover_image_url: 'https://cdn.example/en-old.webp'
        },
        characters: [{ character_id: C1, character_name: 'Lead' }]
      },
      ja: { language_code: 'ja', exists: false, work: {}, characters: [] }
    } as Record<string, Obj>,
    stored: {} as Record<string, FormField[]>
  }
  let made = 0
  const read: WorkFetch = async (url) => {
    if (!edenWorks.readAllowed(url)) throw new Error('UNAPPROVED_READ_ROUTE')
    const path = new URL(url).pathname.replace('/api/works/' + W, '')
    if (path === '') return ok(s.work)
    if (path === '/characters') return ok(s.characters)
    if (path === '/translations')
      return ok({
        items: [
          { language_code: 'ko', is_source: true, exists: true },
          ...Object.values(s.editions).map((e) => ({
            language_code: e.language_code,
            is_source: false,
            exists: e.exists
          }))
        ]
      })
    const edition = /^\/translations\/([A-Za-z-]+)$/.exec(path)
    if (edition) return ok({ item: s.editions[edition[1]] })
    const cid = /^\/characters\/([0-9a-f-]{36})\/images$/.exec(path)
    return cid ? ok(s.images[cid[1]]) : new Response('{}', { status: 404 })
  }
  const write: WorkWrite = async (method, url, body) => {
    if (!edenWorks.writeAllowed!(method, url)) throw new Error('UNAPPROVED_WRITE_ROUTE')
    const path = new URL(url).pathname.replace('/api/works/' + W, '')
    s.calls.push(method + ' ' + path)
    const sent = body as Obj
    if (path === '/upload-cover/signed-url')
      return ok({ path: '/u1/' + W + '/cover-' + ++made + '.webp', token: TOKEN })
    const finalize = /^(?:\/translations\/([A-Za-z-]+)\/cover|\/upload-cover)$/.exec(path)
    if (finalize) {
      const key = String(sent.storagePath).replace(/^\//, '')
      if (!s.stored[key]) return ok({ error: 'not uploaded' }, 400)
      const url = 'https://cdn.example/' + key
      // 원문 표지는 등록만으로 바뀌고, 판본 표지는 번역 저장 본문에 주소가 들어가야 바뀐다
      if (!finalize[1]) s.work.cover_image_url = url
      return ok({ url })
    }
    const edition = /^\/translations\/([A-Za-z-]+)$/.exec(path)
    if (edition) {
      const item = {
        language_code: edition[1],
        exists: true,
        status: 'draft',
        stale: false,
        ...sent
      }
      s.editions[edition[1]] = item
      return ok({ item })
    }
    const order = /^\/characters\/([0-9a-f-]{36})\/images\/reorder$/.exec(path)
    if (order) {
      const ids = sent.imageIds as string[]
      s.images[order[1]] = ids.map((id) => s.images[order[1]].find((i) => i.id === id)!)
      return ok({ success: true })
    }
    return new Response('{}', { status: 404 })
  }
  const send: WorkSend = async (request) => {
    workSendRule('eden', request)
    const u = new URL(request.url)
    s.calls.push(request.method + ' ' + u.host.split('.')[0] + ' ' + (request.form ? 'form' : '-'))
    if (u.origin === STORE) {
      s.stored[u.pathname.split('/work-covers/')[1]] = request.form!
      return ok({ Key: 'work-covers' + u.pathname })
    }
    const cid = /characters\/([0-9a-f-]{36})\/images$/.exec(u.pathname)![1]
    if (request.method === 'DELETE') {
      s.images[cid] = s.images[cid].filter((i) => i.id !== u.searchParams.get('imageId'))
      return ok({ success: true })
    }
    if (s.failUpload) return ok({ error: 'too large' }, 413)
    const field = (name: string): string | undefined => {
      const found = request.form!.find((f) => f.name === name)
      return found && 'value' in found ? found.value : undefined
    }
    const isDefault = field('defaultIndex') === '0'
    if (isDefault) for (const i of s.images[cid]) i.is_default = false
    const made = {
      id: 'cccccccc-0000-4000-8000-00000000000' + s.images[cid].length,
      url: 'https://cdn.example/new' + s.images[cid].length + '.webp',
      image_code: field('preview_codes'),
      description: field('descriptions'),
      visibility: field('visibilities'),
      is_default: isDefault
    }
    s.images[cid].push(made)
    return ok({ success: true, images: [made] })
  }
  return Object.assign(s, { read, write, send })
}

const FILES = {
  'D:/img/smile.webp': WEBP,
  'D:/img/angry.png': PNG,
  'D:/img/notes.txt': WEBP,
  'D:/cover/eden.webp': WEBP,
  'D:/cover/cover_en.webp': bytes([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50], 80),
  'D:/cover/표지-ja.webp': WEBP,
  'D:/cover/animation.webp': WEBP,
  'D:/cover/memo.txt': WEBP,
  'D:/cover/cover_en.png': PNG,
  'D:/two/eden.webp': WEBP,
  'D:/two/cover.webp': WEBP
}

function tools(
  s: { read: WorkFetch; write: WorkWrite; send: WorkSend },
  files: Record<string, Uint8Array> = FILES
): (name: string, args?: Obj) => Promise<Obj> {
  const all = createWorkTools({
    reader: () => s.read,
    writer: () => s.write,
    sender: () => s.send,
    snapshot: async () => 'C:/snap.json',
    readFile: async () => {
      throw new Error('ENOENT')
    },
    ...disk(files)
  })
  return (name, args = {}) => all.find((t) => t.name === name)!.run(args) as Promise<Obj>
}

describe('에덴 캐릭터 이미지', () => {
  it('목록 → 계획(아무것도 안 씀) → 적용: 올리고, 지우고, 다시 읽어 확인', async () => {
    const s = eden()
    const run = tools(s)
    const list = await run('images_list', { site: 'eden', work_id: W })
    expect((list.groups as Obj[]).map((g) => [g.name, (g.images as Obj[]).length])).toEqual([
      ['주연', 2],
      ['조연', 0]
    ])

    const plan = await run('images_plan', {
      site: 'eden',
      work_id: W,
      add: [
        { file: 'D:/img/smile.webp', label: 'smile', default: true },
        { file: 'D:/img/angry.png' }
      ],
      remove: [0]
    })
    expect(s.calls).toEqual([])
    expect((plan.changes as Obj[]).map((c) => c.action)).toEqual(['add', 'add', 'remove'])

    const done = await run('images_apply', { plan_id: plan.plan_id })
    expect(done).toMatchObject({ applied: true, verified: true, backup: 'C:/snap.json' })
    // 올리기가 먼저, 지우기가 나중
    expect(s.calls).toEqual(['POST www form', 'POST www form', 'DELETE www -'])
    expect(s.images[C1].map((i) => [i.image_code, i.is_default, i.description])).toEqual([
      ['bbbbb', false, undefined],
      ['smile', true, 'smile'],
      [expect.stringMatching(/^[a-hj-kmnp-z2-9]{5}$/), false, 'angry']
    ])
    await expect(run('images_apply', { plan_id: plan.plan_id })).rejects.toThrow('PLAN_NOT_FOUND')
  })

  it('순서 바꾸기는 남은 이미지 전부를 적어야 한다', async () => {
    const s = eden()
    const run = tools(s)
    const plan = await run('images_plan', { site: 'eden', work_id: W, order: [1, 0] })
    expect(await run('images_apply', { plan_id: plan.plan_id })).toMatchObject({ verified: true })
    expect(s.images[C1].map((i) => i.id)).toEqual([I2, I1])
    expect(s.calls).toEqual(['PUT /characters/' + C1 + '/images/reorder'])
    for (const order of [[0], [0, 0], [0, 2]])
      await expect(run('images_plan', { site: 'eden', work_id: W, order })).rejects.toThrow(
        'BAD_INDEX'
      )
    await expect(
      run('images_plan', {
        site: 'eden',
        work_id: W,
        order: [1, 0],
        add: [{ file: 'D:/img/smile.webp' }]
      })
    ).rejects.toThrow('BAD_CHANGES')
  })

  it('잘못된 계획은 플랫폼에 닿기 전에 막는다', async () => {
    const s = eden()
    const run = tools(s)
    const plan = (args: Obj): Promise<Obj> =>
      run('images_plan', { site: 'eden', work_id: W, ...args })
    // 대표 이미지만 지우기 (새 대표 없이)
    await expect(plan({ remove: [0] })).rejects.toThrow('KEEP_MAIN_IMAGE')
    // 전부 지우거나 새 대표를 같이 올리면 된다
    expect((await plan({ remove: [0, 1] })).plan_id).toBeTruthy()
    await expect(plan({ remove: [5] })).rejects.toThrow('BAD_INDEX')
    await expect(plan({ remove: [1, 1] })).rejects.toThrow('BAD_INDEX')
    await expect(plan({ character_index: 9, remove: [0] })).rejects.toThrow('BAD_INDEX')
    await expect(plan({})).rejects.toThrow('NO_CHANGES')
    // 이미 쓰는 이미지 코드, 빈 코드, 이미지가 아닌 파일, 없는 파일
    await expect(plan({ add: [{ file: 'D:/img/smile.webp', label: 'aaaaa' }] })).rejects.toThrow(
      'BAD_IMAGE_LABEL'
    )
    await expect(plan({ add: [{ file: 'D:/img/smile.webp', label: 'a b' }] })).rejects.toThrow(
      'BAD_IMAGE_LABEL'
    )
    await expect(plan({ add: [{ file: 'D:/img/notes.txt' }] })).rejects.toThrow('BAD_IMAGE')
    await expect(plan({ add: [{ file: 'D:/img/none.webp' }] })).rejects.toThrow('BAD_IMAGE')
    await expect(
      plan({ add: [{ file: 'D:/img/smile.webp', visibility: 'everyone' }] })
    ).rejects.toThrow('BAD_VISIBILITY')
    await expect(plan({ main_file: 'D:/img/smile.webp' })).rejects.toThrow('BAD_CHANGES')
    expect(s.calls).toEqual([])
    expect(toolMessage(new Error('BAD_IMAGE_LABEL'))).toContain('이미지 코드')
  })

  it('계획 뒤 이미지 목록이 바뀌었으면 적용하지 않고, 올리다 거절되면 지우지 않는다', async () => {
    const s = eden()
    const run = tools(s)
    const stale = await run('images_plan', { site: 'eden', work_id: W, remove: [1] })
    s.images[C1].pop()
    await expect(run('images_apply', { plan_id: stale.plan_id })).rejects.toThrow('PLAN_STALE')
    expect(s.calls).toEqual([])

    const t = eden()
    const run2 = tools(t)
    const plan = await run2('images_plan', {
      site: 'eden',
      work_id: W,
      add: [{ file: 'D:/img/smile.webp' }],
      remove: [1]
    })
    t.failUpload = true
    await expect(run2('images_apply', { plan_id: plan.plan_id })).rejects.toThrow('IMAGE_TOO_LARGE')
    expect(t.images[C1]).toHaveLength(2)
  })
})

describe('에덴 표지', () => {
  it('폴더 → 원문과 판본 표지: 없는 판본은 건너뛰고, 판본 표지는 번역 저장으로 남긴다', async () => {
    const s = eden()
    const run = tools(s)
    const plan = await run('cover_plan', { site: 'eden', work_id: W, folder: 'D:/cover/' })
    expect(plan.uploads).toEqual([
      { target: 'en', file: 'cover_en.webp', bytes: 80 },
      { target: 'source', file: 'eden.webp', bytes: 64 }
    ])
    expect(plan.skipped).toEqual([
      { target: 'ja', file: '표지-ja.webp', reason: '그 언어 판본이 아직 없어요' }
    ])
    expect(plan.ignored).toEqual(['animation.webp', 'cover_en.png', 'memo.txt'])
    expect(plan.current_cover).toBe('https://cdn.example/old.webp')
    expect(s.calls).toEqual([])

    const done = await run('cover_apply', { plan_id: plan.plan_id })
    expect(done).toMatchObject({ uploaded: 2, verified: true, not_done: [] })
    expect(s.calls).toEqual([
      'POST /upload-cover/signed-url',
      'PUT jhbfalszdxacwjnrrvms form',
      'POST /translations/en/cover',
      'PUT /translations/en',
      'POST /upload-cover/signed-url',
      'PUT jhbfalszdxacwjnrrvms form',
      'POST /upload-cover'
    ])
    // 저장소 요청: 경로 앞 빗금을 뗀 자리에 cacheControl과 이름 없는 파일 칸
    const stored = s.stored['u1/' + W + '/cover-1.webp']
    expect(stored[0]).toEqual({ name: 'cacheControl', value: '3600' })
    expect(stored[1]).toMatchObject({
      name: '',
      file: { name: 'cover_en.webp', type: 'image/webp' }
    })
    expect(s.work.cover_image_url).toBe('https://cdn.example/u1/' + W + '/cover-2.webp')
    // 판본에는 표지 주소만 바뀌고 번역된 글은 그대로다
    const en = s.editions.en.work as Obj
    expect(en.cover_image_url).toBe('https://cdn.example/u1/' + W + '/cover-1.webp')
    expect(en.title).toBe('Work')
    expect(en.scenario_settings).toBe('Main')
    expect(s.editions.ja.exists).toBe(false)
  })

  it('files로 직접 짝짓고, 헷갈리는 폴더·없는 판본·잘못된 파일은 올리지 않는다', async () => {
    const s = eden()
    const run = tools(s)
    const plan = (args: Obj): Promise<Obj> =>
      run('cover_plan', { site: 'eden', work_id: W, ...args })
    expect(
      (await plan({ files: { source: 'D:/cover/animation.webp', EN: 'D:/cover/eden.webp' } }))
        .uploads
    ).toEqual([
      { target: 'source', file: 'animation.webp', bytes: 64 },
      { target: 'en', file: 'eden.webp', bytes: 64 }
    ])
    await expect(plan({ folder: 'D:/two' })).rejects.toThrow('COVER_AMBIGUOUS source')
    await expect(plan({ folder: 'D:/none' })).rejects.toThrow('BAD_FILE')
    await expect(plan({ files: { fr: 'D:/cover/eden.webp' } })).rejects.toThrow('BAD_LANGUAGE')
    await expect(plan({ files: { source: 'D:/cover/cover_en.png' } })).rejects.toThrow('BAD_IMAGE')
    // 판본이 없는 언어만 고르면 올릴 것이 없다
    await expect(plan({ files: { ja: 'D:/cover/eden.webp' } })).rejects.toThrow('NO_CHANGES')
    await expect(plan({})).rejects.toThrow('NO_CHANGES')
    await expect(
      run('cover_plan', { site: 'babe', work_id: W, folder: 'D:/cover' })
    ).rejects.toThrow('NO_COVER')
    expect(s.calls).toEqual([])
    // 판본이 없는데 연결부를 직접 불러도 올리지 않는다
    await expect(edenWorks.uploadCover!(s, W, image('a.webp'), 'ja')).rejects.toThrow(
      'EDITION_MISSING'
    )
    expect(s.calls).toEqual([])
  })

  it('계획 뒤 파일이 바뀌면 하나도 올리지 않고, 중간에 실패하면 거기서 멈춘다', async () => {
    const files = { ...FILES }
    const s = eden()
    const run = tools(s, files)
    const plan = await run('cover_plan', { site: 'eden', work_id: W, folder: 'D:/cover' })
    files['D:/cover/eden.webp'] = bytes(
      [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50],
      70
    )
    await expect(run('cover_apply', { plan_id: plan.plan_id })).rejects.toThrow('PLAN_STALE')
    expect(s.calls).toEqual([])

    // 저장소가 거절하는 경우: 첫 표지에서 멈추고 나머지는 올리지 않는다
    const t = eden()
    const send = t.send
    t.send = async (request) =>
      request.url.startsWith(STORE) ? new Response('{}', { status: 403 }) : send(request)
    const run2 = tools(t)
    const p = await run2('cover_plan', { site: 'eden', work_id: W, folder: 'D:/cover' })
    const out = await run2('cover_apply', { plan_id: p.plan_id })
    expect(out).toMatchObject({ uploaded: 0, verified: false, not_done: ['source'] })
    expect((out.results as Obj[])[0]).toMatchObject({
      target: 'en',
      error: 'COVER_FAILED upload 403'
    })
    expect(t.work.cover_image_url).toBe('https://cdn.example/old.webp')
    expect((t.editions.en.work as Obj).cover_image_url).toBe('https://cdn.example/en-old.webp')
  })
})

// ───────────── 베이비챗 흉내 ─────────────

const BW = '22222222-2222-4333-8444-555555555555'
const BLOB_HOST = 'https://py27ckpypvqi2sq0.public.blob.vercel-storage.com/'

function babe(): {
  read: WorkFetch
  write: WorkWrite
  send: WorkSend
  sent: WorkRequest[]
  puts: Obj[]
  edit: Obj
  convertGif: boolean
} {
  const s = {
    sent: [] as WorkRequest[],
    puts: [] as Obj[],
    convertGif: true,
    edit: {
      version: 4,
      name: '시험',
      description: '소개',
      characterDetails: '설정',
      initialTitle: '기본',
      initialAction: '상황',
      initialMessage: '대사',
      visibility: 'private',
      isAdult: false,
      category: 3,
      hashtags: ['순애'],
      targetGender: 'male',
      keywordBooks: [],
      images: [
        { url: BLOB_HOST + 'main.webp', emotion: null, hidden: false, order: 0 },
        { url: BLOB_HOST + 'joy.webp', emotion: 'joy', hidden: false, order: 1 },
        { url: BLOB_HOST + 'sad.webp', emotion: 'sad', hidden: true, order: 2 }
      ]
    } as Obj
  }
  const read: WorkFetch = async (url) => {
    if (!babeWorks.readAllowed(url)) throw new Error('UNAPPROVED_READ_ROUTE')
    return ok(s.edit)
  }
  const write: WorkWrite = async (method, url, body) => {
    if (!babeWorks.writeAllowed!(method, url)) throw new Error('UNAPPROVED_WRITE_ROUTE')
    if (url.endsWith('/preview')) return ok({ baseVersion: s.edit.version, hasChanges: true })
    const sent = body as Obj
    s.puts.push(sent)
    s.edit = {
      ...s.edit,
      version: (s.edit.version as number) + 1,
      images: [{ url: sent.image, emotion: null, hidden: false }, ...(sent.emotionImages as Obj[])]
    }
    return ok({})
  }
  const send: WorkSend = async (request) => {
    workSendRule('babe', request)
    s.sent.push(request)
    if (request.url.endsWith('/api/convert-gif'))
      return s.convertGif
        ? ok({ converted: true, url: 'https://blob.babechat.ai/converted.webp' })
        : ok({ converted: false })
    if (request.url.endsWith('/api/upload'))
      return ok({
        type: 'blob.generate-client-token',
        clientToken: 'vercel_blob_client_py27ckpypvqi2sq0_abc'
      })
    return ok({ url: BLOB_HOST + new URL(request.url).searchParams.get('pathname') })
  }
  return Object.assign(s, { read, write, send })
}

describe('베이비챗 이미지', () => {
  it('올리기: 토큰을 받고 저장소에 올린 뒤 주소를 돌려준다', async () => {
    const s = babe()
    const url = await babeUploadImage(s.send, image('표지.png', PNG, 'image/png'))
    expect(url).toMatch(
      /^https:\/\/py27ckpypvqi2sq0\.public\.blob\.vercel-storage\.com\/[0-9a-f-]{36}\.png$/
    )
    const [ticket, put] = s.sent
    const pathname = url.split('/').pop()
    expect(ticket).toMatchObject({
      method: 'POST',
      url: 'https://babechat.ai/api/upload',
      json: {
        type: 'blob.generate-client-token',
        payload: { pathname, clientPayload: null, multipart: false }
      }
    })
    expect(put.method).toBe('PUT')
    expect(put.url).toBe('https://vercel.com/api/blob/?pathname=' + pathname)
    expect(put.bytes).toEqual({ data: PNG, contentType: 'image/png' })
    expect(put.headers).toMatchObject({
      authorization: 'Bearer vercel_blob_client_py27ckpypvqi2sq0_abc',
      'x-api-version': '13',
      'x-vercel-blob-access': 'public',
      'x-vercel-blob-store-id': 'py27ckpypvqi2sq0'
    })
  })

  it('gif는 변환을 먼저 맡기고, 안 되면 그대로 올린다. 낯선 주소가 돌아오면 쓰지 않는다', async () => {
    const s = babe()
    const gif = image('움짤.gif', GIF, 'image/gif')
    expect(await babeUploadImage(s.send, gif)).toBe('https://blob.babechat.ai/converted.webp')
    expect(s.sent.map((r) => new URL(r.url).pathname)).toEqual(['/api/convert-gif'])
    s.convertGif = false
    expect(await babeUploadImage(s.send, gif)).toMatch(/\.gif$/)

    const evil: WorkSend = async (request) =>
      request.method === 'PUT' ? ok({ url: 'https://evil.example/a.webp' }) : s.send(request)
    await expect(babeUploadImage(evil, image('a.webp'))).rejects.toThrow('IMAGE_UPLOAD_FAILED')
    const signedOut: WorkSend = async () => new Response('{}', { status: 401 })
    await expect(babeUploadImage(signedOut, image('a.webp'))).rejects.toThrow('LOGIN_REQUIRED')
    await expect(babeUploadImage(s.send, image('a.svg'))).rejects.toThrow('BAD_IMAGE')
  })

  it('계획 → 적용: 대표를 바꾸고 감정 이미지를 더하고 빼서 저장한다', async () => {
    const s = babe()
    const run = tools(s)
    const list = await run('images_list', { site: 'babe', work_id: BW })
    expect(((list.groups as Obj[])[0].images as Obj[]).map((i) => [i.label, i.is_default])).toEqual(
      [
        ['', true],
        ['joy', false],
        ['sad', false]
      ]
    )
    const plan = await run('images_plan', {
      site: 'babe',
      work_id: BW,
      main_file: 'D:/img/smile.webp',
      add: [{ file: 'D:/img/angry.png', visibility: 'hidden' }],
      remove: [1]
    })
    expect(s.sent).toEqual([])
    expect(s.puts).toEqual([])
    expect((plan.changes as Obj[]).map((c) => c.action)).toEqual(['main', 'remove', 'add'])

    const done = await run('images_apply', { plan_id: plan.plan_id })
    expect(done).toMatchObject({ applied: true, verified: true })
    expect(s.puts).toHaveLength(1)
    const body = s.puts[0]
    expect(body.baseVersion).toBe(4)
    expect(body.notifyFollowers).toBe(false)
    expect(body.image).toMatch(/\.webp$/)
    expect(body.image).not.toBe(BLOB_HOST + 'main.webp')
    expect((body.emotionImages as Obj[]).map((i) => [i.emotion, i.hidden, i.order])).toEqual([
      ['sad', true, 1],
      ['angry', true, 2]
    ])
    expect(String((body.emotionImages as Obj[])[1].url)).toMatch(/\.png$/)
  })

  it('대표 이미지는 지울 수 없고, 같은 감정 이름은 받지 않는다', async () => {
    const s = babe()
    const run = tools(s)
    const plan = (args: Obj): Promise<Obj> =>
      run('images_plan', { site: 'babe', work_id: BW, ...args })
    await expect(plan({ remove: [0] })).rejects.toThrow('KEEP_MAIN_IMAGE')
    await expect(plan({ add: [{ file: 'D:/img/smile.webp', label: 'joy' }] })).rejects.toThrow(
      'BAD_IMAGE_LABEL'
    )
    // 지우는 이미지의 이름은 다시 써도 된다
    expect(
      (await plan({ remove: [1], add: [{ file: 'D:/img/smile.webp', label: 'joy' }] })).plan_id
    ).toBeTruthy()
    await expect(plan({ character_index: 0, remove: [1] })).rejects.toThrow('BAD_CHANGES')
    await expect(plan({ order: [2, 1] })).rejects.toThrow('BAD_CHANGES')
    await expect(plan({ add: [{ file: 'D:/img/smile.webp', default: true }] })).rejects.toThrow(
      'BAD_CHANGES'
    )
    expect(s.sent).toEqual([])
    expect(s.puts).toEqual([])
  })
})
