import type { RemoteStamp } from './remote-view'
import type { EditionRecord } from './work-freshness'

export const INBOX_PLATFORMS = {
  eden: '에덴',
  babe: '베이비챗',
  luna: '루나',
  elyn: '엘린',
  neko: '네코',
  teapot: '티팟',
  crack: '크랙',
  rplay: '알플레이',
  genit: '젠잇',
  uumai: '우마이',
  chatple: '챗플'
} as const
export const INBOX_EVENTS = {
  comment: '댓글',
  reply: '답글',
  like: '좋아요',
  follow: '팔로우',
  admin: '공지',
  other: '기타'
} as const
// Reactions outnumber conversation roughly three to one, so they get their own view
// instead of burying the comments a creator actually needs to answer.
export const INBOX_EVENT_GROUPS = {
  conversation: ['comment', 'reply', 'admin', 'other'],
  reaction: ['like', 'follow']
} as const
export type InboxEventGroup = keyof typeof INBOX_EVENT_GROUPS
export type InboxPlatform = keyof typeof INBOX_PLATFORMS
export type InboxEvent = keyof typeof INBOX_EVENTS
export interface InboxItem {
  id: string
  platform: InboxPlatform
  event: InboxEvent
  sourceType: string
  title: string
  body: string
  actor: { id: string | null; name: string | null }
  work: { id: string | null; title: string | null; url: string | null }
  at: string | null
  unread: boolean | null
  url: string | null
  /** 작품 썸네일(https). 지금은 1:1 규격인 베이비챗 작품 이미지만 채운다. */
  thumbnail?: string | null
  /** NAIS3에서 바로 답글을 달 수 있는 알림인지 (현재 베이비챗 작품 댓글) */
  canReply?: boolean
  /** 내가 이 댓글에 답글을 달았는지. NAIS3에서 보냈거나, 에덴 사이트에서 직접 단 답글을 찾았을 때. */
  replied?: InboxReplied | null
  /** AI가 나눈 댓글 분류 (아직 안 나눴거나 대상이 아니면 null) */
  topic?: import('./inbox-topic').InboxTopicInfo | null
}
export interface InboxReplied {
  at: string
  content: string
  /** app: NAIS3에서 보냄 / site: 사이트에서 직접 단 답글을 찾음 / ai: AI 자동 답글이 보냄 */
  via: 'app' | 'site' | 'ai'
}
export interface InboxPlatformStatus {
  status?: string
  lastAttempt?: string | null
  lastSuccess?: string | null
  /** 마지막으로 새 알림을 찾은 시각 */
  lastNewAt?: string | null
  detail?: string
}
export interface InboxView {
  intervalMinutes?: number
  collecting?: boolean
  nextCollectionAt?: string | null
  enabled: boolean
  mode: string
  collector: null | {
    lastSeen: string
    version: string
    running: boolean
    sessions?: Partial<
      Record<
        InboxPlatform,
        {
          connected: boolean
          expiresAt?: string | null
          canRenew?: boolean
        }
      >
    >
  }
  /** Platforms the person turned off; absent means on. */
  selection?: Partial<Record<InboxPlatform, boolean>>
  platforms: Partial<Record<InboxPlatform, InboxPlatformStatus>>
  items: InboxItem[]
}
export interface InboxQuery {
  platform?: string
  event?: string
  search?: string
  page?: number
  unread?: boolean
  /** 답글을 달 수 있는데 아직 안 단 댓글만 */
  unreplied?: boolean
  /** 댓글 분류 (inbox-topic) */
  topic?: string
}
export interface InboxResult {
  /** 맥미니에서 받아 온 것이면 받은 시각과, 끊겨서 마지막 것을 보여 주는 중인지 */
  remote?: RemoteStamp
  intervalMinutes: number
  collecting: boolean
  nextCollectionAt: string | null
  available: boolean
  error: string | null
  enabled: boolean
  collectorOnline: boolean
  collectorVersion: string | null
  lastSeen: string | null
  total: number
  filtered: number
  unread: number
  page: number
  pageSize: number
  items: InboxItem[]
  platforms: {
    id: InboxPlatform
    label: string
    count: number
    connected: boolean
    status: string
    detail: string | null
    lastSuccess: string | null
    lastAttempt: string | null
    lastNewAt: string | null
    expiresAt: string | null
    canRenew: boolean
    selected: boolean
    /** NAIS3 holds a signed-in session for this platform. */
    appConnected: boolean
    /** A sign-in window is open and waiting for the person to finish. */
    awaitingLogin: boolean
    /** That sign-in window is still open, so finishing sign-in connects by itself. */
    loginWindowOpen: boolean
    connecting: boolean
  }[]
  events: Record<InboxEvent, number>
  /** Why the in-app collector could not open its session store, if it could not. */
  directError: string | null
  /** 플랫폼 작품 이미지를 뒤에서 채우는 중이면 true — 화면이 잠시 뒤 다시 읽는다. */
  thumbnailsPending: boolean
  /** 사이트에서 단 답글을 뒤에서 확인하는 중이면 true — 화면이 잠시 뒤 다시 읽는다. */
  repliesPending?: boolean
  /** 분류별 댓글 수 (플랫폼·종류·검색 조건 안에서) */
  topics?: Record<string, number>
  /** 아직 분류하지 못한 댓글 수 */
  topicsPending?: number
  /** 분류를 못 하는 이유 (키 없음·오류) */
  topicsError?: string | null
}
export interface InboxConnectResult {
  state: 'connected' | 'login-required' | 'error'
  message: string
}
export interface InboxReplyResult {
  ok: boolean
  message: string
}
export interface InboxReplyTarget {
  ok: boolean
  message: string
  author?: string | null
  content?: string
  at?: string | null
}

/** 플랫폼에 올린 내 작품 하나 */
export interface InboxWork {
  platform: string
  id: string
  title: string
  url: string
  /** 최초 공개 시각 (없으면 등록 시각) */
  at: string | null
  /** published = 플랫폼이 준 공개일, created = 공개일이 없어 등록일을 씀 */
  atKind: 'published' | 'created'
  /**
   * 플랫폼이 준 마지막 수정 시각. 목록 응답에 수정 시각이 없는 플랫폼(베이비챗·루나)과
   * 이 필드가 생기기 전에 저장된 목록은 null/없음.
   */
  updatedAt?: string | null
  isPublic: boolean
  image: string | null
}

/** 같은 제목으로 묶은 작품 (플랫폼별 이식본) */
export interface InboxWorkGroup {
  key: string
  title: string
  /** nais-thumb 썸네일 주소 (베이비챗 1:1 이미지 우선) */
  thumbnail: string | null
  works: InboxWork[]
}

export interface InboxWorksResult {
  fetchedAt: string | null
  groups: InboxWorkGroup[]
  /** 플랫폼 → 읽지 못한 이유 */
  errors: Record<string, string>
  /** 내 작품 목록을 읽을 수 있는 플랫폼 */
  supported: string[]
  /** 묶음 key → 답글 안 단 댓글 수 (알림의 "답글 안 단 것만"과 같은 기준, 0은 빠짐). 최근 30일 것만 */
  unanswered?: Record<string, number>
  /** 로그인이 풀렸거나 연결이 끊긴 플랫폼 */
  loginLost?: string[]
  /** MCP 저장 도구가 남긴 작품별 마지막 저장 기록 (낡음 판정에 수집기 시각과 함께 쓴다) */
  saved?: EditionRecord[]
  /** 맥미니에서 받아 온 것이면 받은 시각과, 끊겨서 마지막 것을 보여 주는 중인지 */
  remote?: RemoteStamp
}
