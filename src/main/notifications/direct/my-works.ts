// 플랫폼별 "내 작품" 목록. 로그인한 계정으로 읽기만 하고, 작품마다 최초 공개일과 링크를 꺼낸다.
// 주소와 필드는 2026-10-23에 각 플랫폼 응답으로 확인했다.
// 공개일 필드가 따로 있는 곳(에덴·엘린·젠잇·티팟)은 그 값을, 없는 곳은 등록일을 쓴다(atKind로 구분).
// 수정 시각(updatedAt)은 이미 받는 응답에 들어 있는 값만 꺼낸다. 요청을 더 하지 않는다.
// 필드 이름은 같은 주소를 읽는 작품 연결부(src/main/works)를 따랐다. 에덴은 다른 주소
// (/api/creators/{id}/works)라 updated_at이 오는지 확인하지 못했다(없으면 null).
// 베이비챗·루나는 목록에 수정 시각이 없다(루나 char_datetime은 이미 등록일로 쓴다).
import type { InboxWork } from '../../../shared/inbox'

export interface WorkReadInit {
  method?: 'GET' | 'POST'
  body?: string
  contentType?: string
}
export type WorkRead = (url: string, init?: WorkReadInit) => Promise<Response>

/** 플랫폼마다 내 작품을 읽을 수 있는 주소 (이 밖으로는 요청하지 않는다) */
export const MY_WORK_ORIGINS: Record<string, string[]> = {
  eden: ['https://www.eden-chat.com'],
  babe: ['https://api.babechatapi.com'],
  luna: ['https://lunatalk.chat'],
  elyn: ['https://api.elyn.ai'],
  neko: ['https://www.nekochat.xyz'],
  teapot: ['https://firestore.googleapis.com'],
  crack: ['https://crack-api.wrtn.ai'],
  genit: ['https://api.genit.ai'],
  // 목록은 로그인 API, 제목·공개일은 공개 작품 API
  rplay: ['https://api.rplay.live', 'https://chat-api.rplay.live'],
  uumai: ['https://api.uumm.ai'],
  chatple: ['https://api.chatple.live']
}

export function myWorksReadAllowed(platform: string, url: string): boolean {
  const origins = MY_WORK_ORIGINS[platform]
  if (!origins) return false
  try {
    const u = new URL(url)
    return origins.includes(u.origin) && !u.username && !u.password
  } catch {
    return false
  }
}

const MAX_PAGES = 30
type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
const list = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter(isObj) : [])

/** 날짜 문자열 → ISO. 시간대가 없는 값은 한국 시각으로 본다 (루나). */
export function isoDate(v: unknown): string | null {
  const s = str(v)
  if (!s) return null
  const local = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(s)
  const t = Date.parse(local ? s.replace(' ', 'T') + '+09:00' : s)
  return Number.isFinite(t) ? new Date(t).toISOString() : null
}

function https(v: unknown, base?: string): string | null {
  const s = str(v)
  if (!s) return null
  try {
    const u = new URL(s, base)
    return u.protocol === 'https:' && !u.username && !u.password ? u.href : null
  } catch {
    return null
  }
}

async function json(res: Response): Promise<unknown> {
  if (res.status === 401 || res.status === 403) throw new Error('LOGIN_REQUIRED')
  if (!res.ok) throw new Error('WORKS_FAILED ' + res.status)
  return res.json()
}

function work(
  platform: string,
  id: unknown,
  title: unknown,
  url: string | null,
  published: unknown,
  created: unknown,
  isPublic: boolean,
  image: string | null,
  updated: unknown = null
): InboxWork | null {
  const wid = str(typeof id === 'number' ? String(id) : id)
  const name = str(title)
  if (!wid || !name || !url) return null
  const pub = isoDate(published)
  return {
    platform,
    id: wid,
    title: name,
    url,
    at: pub ?? isoDate(created),
    atKind: pub ? 'published' : 'created',
    updatedAt: isoDate(updated),
    isPublic,
    image
  }
}

const enc = encodeURIComponent
const CHATPLE_SITE = 'https://ko.chatple.live/'

export interface WorkContext {
  /** 티팟 파이어베이스 사용자 번호 */
  teapotUid?: string | null
  /** 알플레이 계정 번호 */
  rplayOid?: string | null
}
type Lister = (read: WorkRead, ctx: WorkContext) => Promise<(InboxWork | null)[]>

export const MY_WORK_LISTS: Record<string, Lister> = {
  async rplay(read, ctx) {
    const me = ctx.rplayOid
    if (!me || !/^[a-f0-9]{24}$/.test(me)) throw new Error('LOGIN_REQUIRED')
    // 계정 확인을 먼저 한다 (인증이 만료됐으면 여기서 갱신된다)
    await json(
      await read(
        'https://api.rplay.live/account/getuser?userOid=' + me + '&requestorOid=' + me + '&lang=ko'
      )
    )
    const body = await json(
      await read(
        'https://api.rplay.live/content/creator/all-content-oids?creatorOid=' +
          me +
          '&requestorOid=' +
          me
      )
    )
    const byType = isObj(body) && isObj(body.contentsByType) ? body.contentsByType : {}
    const raw = Array.isArray(byType.storyChats) ? byType.storyChats : []
    const oids = [
      ...new Set(
        raw
          .map((v) => (isObj(v) ? str(v._id) || str(v.oid) || str(v.contentOid) : str(v)))
          .filter((v): v is string => !!v && /^[a-f0-9]{24}$/.test(v))
      )
    ].slice(0, 300)
    const out: (InboxWork | null)[] = []
    // 공개 상세는 네 개씩 나눠 읽는다
    for (let i = 0; i < oids.length; i += 4) {
      const part = await Promise.all(
        oids.slice(i, i + 4).map(async (oid) => {
          const res = await read(
            'https://chat-api.rplay.live/story-chat/chat-content?contentOid=' + oid + '&lang=ko'
          )
          if (!res.ok) return null
          const d = (await res.json().catch(() => null)) as unknown
          if (!isObj(d) || d.deleted === true) return null
          const titles = isObj(d.multiLangTitle) ? d.multiLangTitle : {}
          return work(
            'rplay',
            oid,
            str(titles.ko) || d.title,
            'https://rplay.live/story/' + oid,
            d.status === 'published' ? d.publishedAt : null,
            d.createdAt,
            d.status === 'published' && d.isPrivate !== true,
            'https://pb3.rplay.live/thumbnail/' + oid,
            d.modified ?? d.updatedAt
          )
        })
      )
      out.push(...part)
    }
    return out
  },

  async eden(read) {
    const me = await json(await read('https://www.eden-chat.com/api/user/profile'))
    const uid = str(isObj(me) && isObj(me.item) ? me.item.id : null)
    if (!uid || !/^[0-9a-f-]{36}$/i.test(uid)) throw new Error('ACCOUNT_MISSING')
    const out: (InboxWork | null)[] = []
    for (let page = 1; page <= MAX_PAGES; page++) {
      const body = await json(
        await read(
          'https://www.eden-chat.com/api/creators/' +
            uid +
            '/works?page=' +
            page +
            '&sort=newest&category=all&limit=24'
        )
      )
      const rows = list(isObj(body) ? body.works : null)
      for (const w of rows) {
        const id = str(w.id)
        out.push(
          work(
            'eden',
            id,
            w.title,
            id ? 'https://www.eden-chat.com/works/' + enc(id) : null,
            w.first_published_at,
            w.created_at,
            w.visibility === 'public',
            https(w.cover_image_url),
            w.updated_at
          )
        )
      }
      if (rows.length < 24) break
    }
    return out
  },

  async babe(read) {
    const rows = list(await json(await read('https://api.babechatapi.com/ko/api/characters/my')))
    return rows.map((w) => {
      const id = str(w.id) || str(w.characterId)
      return work(
        'babe',
        id,
        w.name,
        id ? 'https://babechat.ai/character/u/' + enc(id) + '/profile' : null,
        null,
        w.createdAt,
        w.visibility === 'public',
        https(w.mainImage) || https(w.profileImageUrl)
      )
    })
  },

  async elyn(read) {
    const out: (InboxWork | null)[] = []
    for (let page = 1; page <= MAX_PAGES; page++) {
      const body = await json(
        await read('https://api.elyn.ai/api/v1/characters/mine?page=' + page + '&limit=50')
      )
      const rows = list(isObj(body) ? body.characters : null)
      for (const w of rows) {
        const id = str(w.id)
        out.push(
          work(
            'elyn',
            id,
            w.name,
            id ? 'https://elyn.ai/characters/' + enc(id) : null,
            w.publicAt,
            w.createdAt,
            w.visibility !== 'private',
            https(w.imageUrl),
            w.updatedAt ?? w.updated_at
          )
        )
      }
      const total = isObj(body) && typeof body.total === 'number' ? body.total : 0
      if (rows.length < 50 || page * 50 >= total) break
    }
    return out
  },

  async neko(read) {
    const body = await json(await read('https://www.nekochat.xyz/api/users/me/characters'))
    return list(isObj(body) ? body.characters : null).map((w) => {
      const id = str(w.id)
      return work(
        'neko',
        id,
        w.displayName ?? w.name,
        id ? 'https://www.nekochat.xyz/character/' + enc(id) : null,
        null,
        w.createdAt,
        w.isPublic === true,
        https(isObj(w.avatar) ? w.avatar.url : null),
        w.updatedAt
      )
    })
  },

  async crack(read) {
    const out: (InboxWork | null)[] = []
    let cursor: string | null = null
    for (let page = 0; page < MAX_PAGES; page++) {
      const body = await json(
        await read(
          'https://crack-api.wrtn.ai/crack-api/stories/me' +
            (cursor ? '?cursor=' + enc(cursor) : '')
        )
      )
      const data = isObj(body) && isObj(body.data) ? body.data : {}
      for (const w of list(data.stories)) {
        const id = str(w._id)
        const img = isObj(w.portraitImage) ? w.portraitImage : {}
        out.push(
          work(
            'crack',
            id,
            w.name,
            id ? 'https://crack.wrtn.ai/detail/' + enc(id) : null,
            null,
            w.createdAt,
            w.visibility === 'public' && w.status !== 'deleted',
            https(img.w600) || https(img.origin),
            w.updatedAt
          )
        )
      }
      cursor = str(data.nextCursor)
      if (!cursor) break
    }
    return out
  },

  async genit(read) {
    const me = await json(await read('https://api.genit.ai/api/auth/user/?lang=ko'))
    const uid = str(isObj(me) ? me.id : null)
    if (!uid || !/^[0-9a-f-]{36}$/i.test(uid)) throw new Error('ACCOUNT_MISSING')
    const out: (InboxWork | null)[] = []
    for (let page = 1; page <= MAX_PAGES; page++) {
      const body = await json(
        await read(
          'https://api.genit.ai/api/characters/?page=' +
            page +
            '&creator=' +
            uid +
            '&ordering=-published_at&page_size=20&lang=ko'
        )
      )
      const rows = list(isObj(body) ? body.results : null)
      // 다른 작가 작품이 섞여 오면 버린다
      for (const w of rows.filter((r) => r.creator_id === uid)) {
        const id = str(w.id)
        out.push(
          work(
            'genit',
            id,
            w.name,
            id ? 'https://genit.ai/ko/contents/' + enc(id) : null,
            w.published_at,
            w.created_at,
            !!w.published_at,
            https(w.profile_image_url),
            w.updated_at
          )
        )
      }
      if (!isObj(body) || !body.next || rows.length < 20) break
    }
    return out
  },

  async luna(read) {
    const out: (InboxWork | null)[] = []
    for (let page = 0; page < MAX_PAGES; page++) {
      const body = await json(
        await read('https://lunatalk.chat/member/mypage_api', {
          method: 'POST',
          contentType: 'application/x-www-form-urlencoded',
          body:
            'action=my_characters&offset=' +
            page * 20 +
            '&limit=20&filter=all&sort=latest&order=desc'
        })
      )
      if (!isObj(body) || body.success === false) throw new Error('LOGIN_REQUIRED')
      const rows = list(body.characters)
      for (const w of rows) {
        const id = w.idx
        out.push(
          work(
            'luna',
            id,
            w.char_name,
            id != null ? 'https://lunatalk.chat/character/detail/' + enc(String(id)) : null,
            null,
            w.char_datetime,
            w.char_public === 'public',
            https(w.img_main, 'https://lunatalk.chat/') ||
              https(w.img_profile, 'https://lunatalk.chat/')
          )
        )
      }
      if (!body.has_more || rows.length < 20) break
    }
    return out
  },

  // 우마이 스튜디오 "작품" 탭과 같은 목록 (2026-11-10 사이트 코드, 실제 호출 전):
  //   GET /v1/creator/work?sort=latest[&after=다음 표시] → {data:[{id,title,thumbnail,publishedAt,draftSavedAt,publishStatus}], meta:{next}}
  // publishStatus 1 공개 / 2 비공개 / 3 링크공개. publishedAt이 없으면 한 번도 발행하지 않은 초안이다.
  async uumai(read) {
    const out: (InboxWork | null)[] = []
    let after: string | null = null
    const seen = new Set<string>()
    for (let page = 0; page < MAX_PAGES; page++) {
      const body = await json(
        await read(
          'https://api.uumm.ai/v1/creator/work?sort=latest' + (after ? '&after=' + enc(after) : '')
        )
      )
      const rows = list(isObj(body) ? body.data : null)
      for (const w of rows) {
        const id = str(w.id)
        out.push(
          work(
            'uumai',
            id,
            w.title,
            id ? 'https://uumm.ai/works/' + enc(id) : null,
            w.publishedAt,
            w.draftSavedAt,
            !!str(w.publishedAt) && w.publishStatus === 1,
            https(w.thumbnail),
            w.draftSavedAt
          )
        )
      }
      const meta = isObj(body) && isObj(body.meta) ? body.meta : {}
      const next = typeof meta.next === 'number' ? String(meta.next) : str(meta.next)
      // 같은 표시가 다시 오면 멈춘다 (목록이 돌지 않게)
      if (!next || !rows.length || seen.has(next)) break
      seen.add(next)
      after = next
    }
    return out
  },

  // 챗플 프로필 "제작 캐릭터"와 같은 목록 (2026-11-10 사이트 코드, 실제 호출 전):
  //   GET /v1/login/me → result.login.mem_no,  GET /v1/contents/creator/{mem_no} → result.contents[]
  // flag_use 0 공개 / 1 비공개 / 2 링크공개. 공개는 심사 통과(review_status 2 또는 flag_public 1) 뒤에 보인다.
  async chatple(read) {
    const me = await json(await read('https://api.chatple.live/v1/login/me'))
    const result = isObj(me) && isObj(me.result) ? me.result : {}
    const login = isObj(result.login) ? result.login : {}
    const memNo = typeof login.mem_no === 'number' ? login.mem_no : Number(str(login.mem_no))
    if (!Number.isInteger(memNo) || memNo <= 0) throw new Error('LOGIN_REQUIRED')
    const body = await json(await read('https://api.chatple.live/v1/contents/creator/' + memNo))
    const res = isObj(body) && isObj(body.result) ? body.result : {}
    const video = (v: unknown): boolean => /\.(?:mp4|webm|mov)(?:[?#]|$)/i.test(str(v) ?? '')
    return list(res.contents).map((w) => {
      const id = typeof w.idx === 'number' ? String(w.idx) : str(w.idx)
      return work(
        'chatple',
        id,
        w.title,
        id && /^\d+$/.test(id) ? 'https://ko.chatple.live/content/' + id : null,
        null,
        w.reg_dt,
        Number(w.flag_use ?? 0) === 0 &&
          (Number(w.flag_public) === 1 || Number(w.review_status) === 2),
        // 주소가 //로 시작할 수 있다 (NP_CDN_DOMAIN_IMG "//images.novelpia.com")
        video(w.avatar_url)
          ? https(w.poster_url, CHATPLE_SITE)
          : https(w.avatar_url, CHATPLE_SITE) || https(w.poster_url, CHATPLE_SITE),
        w.upd_dt
      )
    })
  },

  async teapot(read, ctx) {
    const uid = ctx.teapotUid
    if (!uid) throw new Error('LOGIN_REQUIRED')
    const url =
      'https://firestore.googleapis.com/v1/projects/chat-ai-7a275/databases/(default)/documents:runQuery'
    // 작가 페이지와 같은 조회 (색인이 있는 모양). 성인·일반을 나눠 두 번 묻는다.
    const query = (nsfw: boolean): string =>
      JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: 'OC' }],
          where: {
            compositeFilter: {
              op: 'AND',
              filters: [
                {
                  fieldFilter: {
                    field: { fieldPath: 'is_deleted' },
                    op: 'EQUAL',
                    value: { booleanValue: false }
                  }
                },
                {
                  fieldFilter: {
                    field: { fieldPath: 'publicity' },
                    op: 'EQUAL',
                    value: { stringValue: '1' }
                  }
                },
                {
                  fieldFilter: {
                    field: { fieldPath: 'is_nsfw' },
                    op: 'EQUAL',
                    value: { booleanValue: nsfw }
                  }
                },
                {
                  fieldFilter: {
                    field: { fieldPath: 'creator_uid' },
                    op: 'EQUAL',
                    value: { stringValue: uid }
                  }
                }
              ]
            }
          },
          orderBy: [
            { field: { fieldPath: 'time_created' }, direction: 'DESCENDING' },
            { field: { fieldPath: '__name__' }, direction: 'DESCENDING' }
          ],
          limit: 300
        }
      })
    const out: (InboxWork | null)[] = []
    for (const nsfw of [true, false]) {
      const rows = list(
        await json(
          await read(url, { method: 'POST', contentType: 'application/json', body: query(nsfw) })
        )
      )
      for (const row of rows) {
        const doc = isObj(row.document) ? row.document : null
        if (!doc) continue
        const id = str(doc.name)?.split('/').pop() ?? null
        const f = isObj(doc.fields) ? doc.fields : {}
        const v = (k: string, t: string): unknown => (isObj(f[k]) ? (f[k] as Obj)[t] : null)
        out.push(
          work(
            'teapot',
            id,
            v('char_name', 'stringValue'),
            id ? 'https://teapotchat.com/character/' + enc(id) : null,
            v('time_published', 'timestampValue'),
            v('time_created', 'timestampValue'),
            true,
            https(v('image', 'stringValue')),
            v('time_updated', 'timestampValue')
          )
        )
      }
    }
    return out
  }
}

/** 한 플랫폼의 내 작품 (번호 중복 제거, 최신 순) */
export async function readMyWorks(
  platform: string,
  read: WorkRead,
  ctx: WorkContext = {}
): Promise<InboxWork[]> {
  const lister = MY_WORK_LISTS[platform]
  if (!lister) return []
  const seen = new Set<string>()
  const out: InboxWork[] = []
  for (const w of await lister(read, ctx)) {
    if (!w || seen.has(w.id)) continue
    seen.add(w.id)
    out.push(w)
  }
  return out.sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''))
}

/** 파이어베이스 인증 헤더(JWT)에서 사용자 번호만 꺼낸다. 토큰 자체는 어디에도 남기지 않는다. */
export function firebaseUid(authorization: string | undefined | null): string | null {
  const token = String(authorization ?? '').replace(/^Bearer\s+/i, '')
  const part = token.split('.')[1]
  if (!part) return null
  try {
    const payload = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Obj
    const uid = str(payload.user_id) || str(payload.sub)
    return uid && /^[A-Za-z0-9]{10,64}$/.test(uid) ? uid : null
  } catch {
    return null
  }
}
