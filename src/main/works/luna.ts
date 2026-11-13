// 루나톡 작품 읽기. 루나는 API 세션 없이 사이트 쿠키만 쓰는 서버 렌더 사이트다.
// 2026-11-10 조사(공개 정적 파일·공개 페이지만, 로그인 없이):
//   POST /member/mypage_api   x-www-form-urlencoded  action=my_characters&offset=…&limit=20&filter=all&sort=latest&order=desc
//        → {success, characters:[{idx, char_name, char_public, char_datetime, img_main, img_profile}], has_more}
//        (알림 모아보기의 내 작품 목록에서 2026-10-23 실제 응답으로 확인한 주소·필드)
//   GET  /character/detail/{idx}   작품 상세 페이지 HTML (공개 페이지에서 구조 확인)
//        og:title = "제목 | LUNATALK - AI 캐릭터 채팅", <template id="charDescriptionTemplate"> = 소개글,
//        <div class="sg-card" data-situation-idx=N> … <h4 class="sg-card-title">, <div class="sg-bubble" data-raw="…"> = 시작 상황
// 편집 화면(/character/edit, /character/add, /lorebook/edit)은 로그인해야 열리고, 편집기 스크립트가 공개
// 정적 파일로 나와 있지 않아 저장 주소·본문 모양을 코드로 확인하지 못했다. 그래서 메인 프롬프트·로어북 읽기와
// 저장·추가·삭제·공개 전환·새 작품·이미지(itimg)는 만들지 않았다 (도구는 NO_SAVE·NO_DELETE·NO_CREATE·NO_IMAGES로 막힌다).
import type {
  WorkAdapter,
  WorkBody,
  WorkFeature,
  WorkFetch,
  WorkListItem,
  WorkReadInit
} from './types'

const ORIGIN = 'https://lunatalk.chat'
const LIST_URL = ORIGIN + '/member/mypage_api'
const DETAIL_PATH = /^\/character\/detail\/\d{1,10}$/
const FORM = 'application/x-www-form-urlencoded'
const PAGE = 20
const MAX_PAGES = 30
const TITLE_SUFFIX = / \| LUNATALK - AI 캐릭터 채팅$/

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
const list = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter(isObj) : [])
const text = (v: unknown): string => (typeof v === 'string' ? v : '')
const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)

function workId(id: string): string {
  if (!/^\d{1,10}$/.test(id)) throw new Error('BAD_WORK_ID')
  return id
}

/** 목록 요청 본문. 편집 요청과 섞이지 않게 이 모양 하나만 허용한다 */
export function lunaListBody(offset: number): string {
  return (
    'action=my_characters&offset=' +
    offset +
    '&limit=' +
    PAGE +
    '&filter=all&sort=latest&order=desc'
  )
}
const LIST_KEYS = ['action', 'offset', 'limit', 'filter', 'sort', 'order']
function listBodyAllowed(body: string): boolean {
  const params = new URLSearchParams(body)
  const keys = [...params.keys()]
  return (
    keys.length === LIST_KEYS.length &&
    LIST_KEYS.every((k) => params.getAll(k).length === 1) &&
    params.get('action') === 'my_characters' &&
    /^\d{1,5}$/.test(params.get('offset') ?? '') &&
    params.get('limit') === String(PAGE) &&
    params.get('filter') === 'all' &&
    params.get('sort') === 'latest' &&
    params.get('order') === 'desc'
  )
}

function plainUrl(url: string): URL | null {
  try {
    const u = new URL(url)
    return u.origin === ORIGIN && !u.username && !u.password && !u.search && !u.hash ? u : null
  } catch {
    return null
  }
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' '
}
/** HTML 속성·글에 든 문자 참조를 푼다 */
export function unescapeHtml(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, code: string) => {
    if (code[0] === '#') {
      const n =
        code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : Number(code.slice(1))
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : all
    }
    return ENTITIES[code.toLowerCase()] ?? all
  })
}

/** 로그인 없이 열면 사이트가 경고창 + 로그인 화면 이동 스크립트만 돌려준다 */
function redirectOnly(html: string): { alert: string; to: string } | null {
  if (html.length > 2000 || !/window\.location\.href\s*=/.test(html)) return null
  return {
    alert: /alert\('([^']*)'\)/.exec(html)?.[1] ?? '',
    to: /window\.location\.href\s*=\s*'([^']*)'/.exec(html)?.[1] ?? ''
  }
}

interface LunaRaw {
  id: string
  /** 원본이 무엇인지 (스냅샷에서 구분) */
  source: 'detail_page'
  html: string
}

function page(raw: unknown): LunaRaw {
  if (
    !isObj(raw) ||
    raw.source !== 'detail_page' ||
    typeof raw.html !== 'string' ||
    typeof raw.id !== 'string'
  )
    throw new Error('WORK_SHAPE')
  return raw as unknown as LunaRaw
}

/** 상세 페이지의 시작 상황 카드들 */
function situations(html: string): WorkBody['startScenarios'] {
  const out: WorkBody['startScenarios'] = []
  const cards = html.split(/<div class="sg-card" data-situation-idx="/).slice(1)
  for (const card of cards) {
    const index = /^(\d+)"/.exec(card)?.[1]
    if (index === undefined) continue
    const title = /<h4 class="sg-card-title">([\s\S]*?)<\/h4>/.exec(card)?.[1] ?? ''
    const bubble = /<div class="sg-bubble" data-raw="([^"]*)"/.exec(card)?.[1] ?? ''
    out.push({
      id: Number(index),
      title: unescapeHtml(title.trim()),
      isDefault: /<span class="sg-card-badge">\s*기본\s*<\/span>/.test(card),
      content: unescapeHtml(bubble),
      subPrompt: '',
      dialogue: '',
      situation: '',
      description: ''
    })
  }
  return out
}

/** 상세 페이지 `<p class="dTit">라벨</p><p class="dDate">날짜</p>` 한 쌍의 날짜 (YYYY.MM.DD). 없으면 null */
function detailDate(html: string, label: string): string | null {
  const m = new RegExp(
    '<p class="dTit">\\s*' + label + '\\s*</p>\\s*<p class="dDate">\\s*([^<]*?)\\s*</p>'
  ).exec(html)
  return m && /^\d{4}\.\d{2}\.\d{2}$/.test(m[1]) ? m[1] : null
}

const MAX_TAGS = 20
const MAX_TAG_CHARS = 80

/**
 * 상세 페이지에서 읽히는 설정 (2026-11-10 스냅샷으로 확인한 칸만). 페이지 구조를 못 찾은 칸은 넣지 않는다.
 * 대화 수·좋아요 수처럼 읽을 때마다 달라지는 값은 계획 비교(frozen)를 깨므로 싣지 않는다.
 */
function extrasOf(html: string): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {}
  const block = /<ul class="lTag"[^>]*>([\s\S]*?)<\/ul>/.exec(html)?.[1]
  if (block !== undefined) {
    const tags = [...block.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/g)]
      .map((m) => unescapeHtml(m[1].replace(/<[^>]*>/g, '')).trim())
      .filter(Boolean)
    if (tags.length <= MAX_TAGS && tags.every((t) => t.length <= MAX_TAG_CHARS)) out.tags = tags
    else out.tag_count = tags.length
    out.has_r19_tag = tags.includes('R-19')
  }
  const registered = detailDate(html, '등록일')
  if (registered) out.registered_on = registered
  if (/<div class="lImg">/.test(html))
    out.has_cover_image = /<div class="lImg">\s*<img [^>]*src="[^"]+"/.test(html)
  const pack = /<p class="dTxt">\s*(\d+)개의 이미지팩\s*<\/p>/.exec(html)?.[1]
  if (pack !== undefined) out.image_pack_count = Number(pack)
  return Object.keys(out).length ? out : undefined
}

/** 사이트에는 있는데 이 연결부가 읽지 못해 빈 값으로 보이는 칸 */
const UNSUPPORTED = [
  '메인 프롬프트(세계관·인물 설정·응답 규칙)',
  '한 줄 소개',
  '로어북',
  '등장인물',
  '위키 본문',
  '공개 범위(상세 읽기)',
  '모델·엔진 설정'
]

const feature = (
  site: WorkFeature['site'],
  read: WorkFeature['read'],
  write: WorkFeature['write'],
  verified: WorkFeature['verified'],
  note: string
): WorkFeature => ({ site, read, write, verified, note })

// 근거: docs/platform-analysis/luna.md 9절. 저장은 전부 막혀 있어 저장 경로가 있는 칸의 쓰기는 blocked, 도구 밖 기능은 no
const FEATURES: Record<string, WorkFeature> = {
  title: feature('yes', 'yes', 'blocked', 'partial', '공개 상세 읽기 1건'),
  description: feature('yes', 'yes', 'blocked', 'partial', 'HTML 통째로 읽음'),
  main_prompt: feature('yes', 'no', 'blocked', 'no', '3칸 합 7000자 권장, 못 읽음'),
  first_message: feature('yes', 'partial', 'blocked', 'partial', '시작 상황 0번으로 읽힘'),
  start_scenarios: feature('yes', 'partial', 'blocked', 'partial', '제목·기본 여부·본문만 읽음, 1500자 권장'),
  lorebook: feature('yes', 'no', 'blocked', 'no', '별개 객체, 빈 배열은 "없음"이 아님'),
  characters: feature('yes', 'no', 'blocked', 'no', '못 읽음, 빈 배열은 "없음"이 아님'),
  example_dialogue: feature('unknown', 'no', 'no', 'no', '칸 존재 불명'),
  user_persona: feature('yes', 'no', 'no', 'no', '공식 MCP 창작 자료로만'),
  output_rules: feature('yes', 'no', 'blocked', 'no', '매 응답 적용 규칙 칸, 못 읽음'),
  situation_images: feature('yes', 'partial', 'blocked', 'partial', '시작 상황 글 속 img만 보임'),
  cover: feature('yes', 'partial', 'blocked', 'partial', '있음/없음만 보임, 주소는 못 읽음'),
  tags: feature('yes', 'yes', 'blocked', 'partial', '상세 페이지 태그를 extras로 읽음'),
  visibility: feature('yes', 'partial', 'blocked', 'partial', '목록에서만, 상세는 비어 나옴'),
  create_work: feature('yes', 'no', 'blocked', 'no', '공식 MCP로만'),
  delete_work: feature('yes', 'no', 'blocked', 'no', '사이트에서 직접'),
  versioning_review: feature('yes', 'no', 'no', 'no', '수정본 구조, 심사는 모름'),
  language_editions: feature('no', 'no', 'no', 'yes', '판본 없음 응답 확인'),
  bgm_voice: feature('unknown', 'no', 'no', 'no', '근거 자료 없음'),
  jsx_html: feature('yes', 'partial', 'blocked', 'partial', '소개 HTML만 읽음, JSX 불가'),
  model_settings: feature('yes', 'no', 'no', 'no', '공식 MCP 엔진 이름으로만'),
  comments_stats: feature('yes', 'no', 'no', 'no', '알림 탭·사이트에서 직접')
}

export const lunaWorks: WorkAdapter = {
  id: 'luna',
  label: '루나톡',
  guide: {
    save: '읽기만 된다(목록과 공개 상세 페이지). 쓰기는 루나톡 공식 MCP(루나톡 제작 도우미)로 하고, 거기서도 수정본으로만 저장된다.',
    manual: ['수정본을 원본에 반영', '공개', '이미지·JSX 에셋 등록', '삭제'],
    unverified: ['이미지(itimg) 올리는 방식']
  },
  // 공개 상세 페이지로 읽을 수 있는 것만 (메인 프롬프트·로어북·저장은 편집기 코드 미확보)
  capabilities: ['works_list', 'work_read', 'start_scenarios'],
  features: FEATURES,

  readAllowed(url) {
    const u = plainUrl(url)
    return !!u && DETAIL_PATH.test(u.pathname)
  },
  readPostAllowed(url, init: WorkReadInit) {
    return (
      url === LIST_URL &&
      !!plainUrl(url) &&
      init.contentType === FORM &&
      typeof init.body === 'string' &&
      listBodyAllowed(init.body)
    )
  },

  async list(read: WorkFetch): Promise<WorkListItem[]> {
    const out: WorkListItem[] = []
    for (let n = 0; n < MAX_PAGES; n++) {
      const res = await read(LIST_URL, {
        method: 'POST',
        contentType: FORM,
        body: lunaListBody(n * PAGE)
      })
      if (res.status === 401 || res.status === 403) throw new Error('LOGIN_REQUIRED')
      if (!res.ok) throw new Error('WORK_READ_FAILED ' + res.status)
      const body: unknown = await res.json().catch(() => null)
      // 로그인이 풀리면 {success:false, message:'로그인이 필요합니다.'}가 온다
      if (!isObj(body)) throw new Error('LOGIN_REQUIRED')
      if (body.success === false) {
        // 로그인·세션 만료 말이 없는 거절 문구는 로그인 문제로 뭉개지 않는다 (문구가 아예 없으면 가릴 수 없어 로그인으로 본다)
        const message = text(body.message).trim()
        if (message && !/로그인|세션|만료|회원/.test(message))
          throw new Error('LIST_REFUSED ' + message.slice(0, 60))
        throw new Error('LOGIN_REQUIRED')
      }
      const rows = list(body.characters)
      for (const w of rows) {
        const id = typeof w.idx === 'number' || typeof w.idx === 'string' ? String(w.idx) : ''
        if (!/^\d{1,10}$/.test(id)) continue
        out.push({
          id,
          title: text(w.char_name),
          visibility: strOrNull(w.char_public),
          status: null,
          updatedAt: strOrNull(w.char_datetime),
          characters: null
        })
      }
      if (!body.has_more || rows.length < PAGE) break
    }
    return out
  },

  async readRaw(read, id) {
    const wid = workId(id)
    const res = await read(ORIGIN + '/character/detail/' + wid)
    if (res.status === 401 || res.status === 403) throw new Error('LOGIN_REQUIRED')
    if (res.status === 404) throw new Error('WORK_NOT_FOUND')
    if (!res.ok) throw new Error('WORK_READ_FAILED ' + res.status)
    const html = await res.text()
    const redirect = redirectOnly(html)
    if (redirect !== null) {
      const { alert, to } = redirect
      // 경고 문구에 로그인 말이 없어도 로그인 화면으로 보내면 로그인 문제다
      if (alert.includes('로그인') || /^\/(?:member\/)?login(?:[/?#]|$)/.test(to))
        throw new Error('LOGIN_REQUIRED')
      // 작품이 없다는 말이거나 말이 없으면 없음으로, 그 밖의 경고(성인 인증·접근 거부 등)는 따로 알린다
      if (!alert.trim() || /찾을 수 없|존재하지|삭제/.test(alert)) throw new Error('WORK_NOT_FOUND')
      throw new Error('WORK_ACCESS_REFUSED ' + alert.trim().slice(0, 60))
    }
    // 페이지가 가리키는 작품 번호가 요청한 번호와 같아야 한다
    if (/var charIdx = (\d+);/.exec(html)?.[1] !== wid) throw new Error('WORK_SHAPE')
    // 페이지에 든 세션 CSRF 토큰은 스냅샷 파일에 남기지 않는다
    const raw: LunaRaw = {
      id: wid,
      source: 'detail_page',
      html: html.replace(/(var csrfToken\s*=\s*)(['"])[^'"]*(['"])/g, '$1$2(removed)$3')
    }
    return raw
  },

  normalize(raw): WorkBody {
    const { id, html } = page(raw)
    const og = /<meta property="og:title" content="([^"]*)"/.exec(html)?.[1] ?? ''
    const title = unescapeHtml(og).replace(TITLE_SUFFIX, '')
    const description =
      /<template id="charDescriptionTemplate">([\s\S]*?)<\/template>/.exec(html)?.[1]?.trim() ?? ''
    const extras = extrasOf(html)
    return {
      id,
      title,
      // 상세 페이지에는 공개 상태가 없다 (works_list의 visibility를 본다)
      visibility: null,
      status: null,
      // 상세 페이지의 "수정일"(날짜만, YYYY.MM.DD). 목록의 char_datetime과 같은 값인지는 확인하지 못했다
      updatedAt: detailDate(html, '수정일'),
      // 메인 프롬프트는 편집 화면에만 있어 읽지 못한다 (main 칸 없음)
      fields: { title, description },
      lorebook: [],
      startScenarios: situations(html),
      characters: [],
      ...(extras ? { extras } : {}),
      unsupported: [...UNSUPPORTED]
    }
  }
}
