import { session as electronSession, type Session } from 'electron'
import { join } from 'node:path'
import {
  allowed,
  collectEden,
  collectLuna,
  collectPages,
  collectTeapot,
  endpoints,
  expiryByOrigin,
  normalize,
  profileUpdate,
  readError,
  readRoute,
  renewable,
  renewableExpiry,
  renewSession,
  safeSessionSummary,
  SessionExpired,
  teapotQueries,
  traceText,
  type EngineBatch,
  type SessionProfile,
  type EngineRequest
} from './engine.mjs'
import {
  LoginBrowser,
  openSignInWindow,
  profileInUse,
  profileReleased,
  type BrowserCookie
} from './login-browser'
import { ReplyError } from './babe-reply'
import { imageReadAllowed, IMAGE_ROUTES, readWorkImage } from './work-image-routes'
import {
  firebaseUid,
  MY_WORK_LISTS,
  myWorksReadAllowed,
  readMyWorks,
  type WorkRead
} from './my-works'
import type { InboxWork } from '../../../shared/inbox'
import { workReadAllowed, workSendRule, workWriteAllowed } from '../../works/adapters'
import type { WorkReadInit, WorkRequest } from '../../works/types'
import {
  checkContent,
  findEdenReplies,
  REPLY_ADAPTERS,
  writeAllowed,
  type FoundReply,
  type ReplyComment,
  type ReplyContext,
  type ReplyItem,
  type WriteSend
} from './replies'
import {
  CAPTURE_SCRIPT,
  DIRECT_PLATFORMS,
  SITES,
  captureComplete,
  cookieBelongs,
  cookieOnly,
  sessionReady,
  type DirectPlatformId
} from './platforms'
import { createVault, type DirectState } from './vault'

const NEEDS_LOGIN = new Set([
  'SESSION_QUERIES_MISSING',
  'SESSION_ROUTES_MISSING',
  'SESSION_NOTICE_ROUTES_MISSING'
])
const RUN_EVERY = 5 * 60_000
const SIGNED_OUT_AFTER = 10_000
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export interface DirectStore {
  ingest(batch: Record<string, unknown>): Promise<unknown>
  heartbeat(detail: {
    version: string
    running: boolean
    sessions: Record<string, unknown>
  }): Promise<{ enabled: boolean; selection: Partial<Record<string, boolean>> }>
}
export interface ConnectResult {
  state: 'connected' | 'login-required' | 'error'
  detail: string | null
}
export interface RunResult {
  status: 'ok' | 'partial' | 'login' | 'error'
  detail: string
}
export interface DirectPlatformState {
  connected: boolean
  awaitingLogin: boolean
  connecting: boolean
  /** The sign-in window is still open, so a finished sign-in is picked up by itself. */
  windowOpen: boolean
}

/** 작품 연결부에 넘기는 로그인 계정 번호 (토큰은 담지 않는다) */
export type WorkAccount = { uid: string } | { oid: string; loginType: string }

/** 작품 통로의 요청이 로그인 만료로 거절된 것인지. 알플레이는 만료를 500 {"error":"jwt expired"} 로도 알린다 */
async function workExpired(platform: string, response: Response): Promise<boolean> {
  if (response.ok) return false
  if (await renewable(response.clone())) return true
  return (
    platform === 'rplay' &&
    response.status === 500 &&
    /jwt expired/i.test(await response.clone().text())
  )
}

export function createDirectCollector(options: {
  directory: string
  profileDir: string
  store: DirectStore
  version: string
}): {
  start(): void
  stop(): Promise<void>
  /** One collection round now, the same one the timer runs; used by tests. */
  collect(): Promise<void>
  connect(platform: DirectPlatformId): Promise<ConnectResult>
  disconnect(platform: DirectPlatformId): Promise<void>
  /** 알림이 가리키는 원래 댓글을 찾는다 (보내기 전 확인용). */
  resolveReply(platform: DirectPlatformId, item: ReplyItem): Promise<ReplyComment>
  /** 원래 댓글을 다시 찾아 그 댓글에 답글을 단다. */
  reply(
    platform: DirectPlatformId,
    item: ReplyItem,
    content: string
  ): Promise<{ replyId: string | null; target: ReplyComment }>
  /** 베이비챗 내 작품 목록(이름·대표 이미지) 원본 응답. 썸네일 기준표를 만든다. */
  babeWorks(): Promise<unknown>
  /** 그 플랫폼 작품의 대표 이미지 주소 (로그인 계정으로 읽음). 연결 안 된 플랫폼은 null. */
  workImage(platform: string, workId: string): Promise<string | null>
  /** 그 플랫폼에 올린 내 작품 목록 (읽기만 한다). 연결 안 됐으면 LOGIN_REQUIRED */
  myWorks(platform: string): Promise<InboxWork[]>
  /** 내 작품 목록을 읽을 수 있는 연결된 플랫폼 */
  myWorkPlatforms(): Promise<string[]>
  /**
   * 그 플랫폼 작품 본문을 로그인 계정으로 읽는다 (작품 읽기로 허용된 주소만. 기본 GET,
   * POST는 연결부가 주소·본문 종류·본문 모양까지 허용한 읽기만). 연결 안 됐으면 LOGIN_REQUIRED.
   */
  workRead(platform: string, url: string, init?: WorkReadInit): Promise<Response>
  /**
   * 그 플랫폼 작품을 로그인 계정으로 저장한다 (작품 저장으로 허용된 요청만, JSON 본문).
   * 연결 안 됐으면 LOGIN_REQUIRED.
   */
  workWrite(platform: string, method: string, url: string, body: unknown): Promise<Response>
  /**
   * 작품 이미지·표지처럼 JSON이 아닌 본문(파일 묶음·바이너리)이나 파일 저장소로 가는 요청을 보낸다.
   * 주소·본문 종류·헤더 이름이 그 플랫폼 연결부의 규칙과 맞을 때만 나가고, 규칙이 정한 로그인 정보만 붙는다.
   */
  workSend(platform: string, request: WorkRequest): Promise<Response>
  /**
   * 작품 연결부가 주소에 넣어야 하는 로그인 계정 번호 (알플레이 계정 번호·로그인 종류, 티팟 사용자 번호).
   * 저장된 로그인 정보에서 번호만 꺼내고 토큰은 돌려주지 않는다. 없으면 null.
   */
  workAccount(platform: string): Promise<WorkAccount | null>
  /** 에덴 댓글 번호 → 사이트에서 내가 그 뒤에 단 답글 (읽기만 한다). */
  edenReplies(commentIds: string[]): Promise<Record<string, FoundReply>>
  status(): Promise<{
    error: string | null
    platforms: Record<DirectPlatformId, DirectPlatformState>
  }>
} {
  const { store, version } = options
  const vault = createVault(join(options.directory, 'direct-sessions.bin'))
  const ses: Session = electronSession.fromPartition('persist:moa-direct')
  let state: DirectState | null = null,
    loading: Promise<DirectState> | null = null,
    loadError: string | null = null,
    browser: LoginBrowser | null = null,
    timer: NodeJS.Timeout | null = null,
    watchTimer: NodeJS.Timeout | null = null,
    watching = false,
    signInOpen = false,
    ticking = false,
    stopped = false
  const awaitingLogin = new Set<DirectPlatformId>(),
    connecting = new Set<DirectPlatformId>(),
    renewing = new Map<DirectPlatformId, Promise<boolean>>(),
    lastRenewal = new Map<DirectPlatformId, string>()

  async function ready(): Promise<DirectState> {
    if (state) return state
    if (!loading)
      loading = vault.load().then(
        (value) => {
          state = value
          if (value.userAgent) ses.setUserAgent(value.userAgent)
          return value
        },
        (error: Error) => {
          loading = null
          loadError = error.message
          throw error
        }
      )
    return loading
  }
  const persist = async (): Promise<void> => {
    if (state) await vault.save(state)
  }

  async function heartbeat(): Promise<{
    enabled: boolean
    selection: Partial<Record<string, boolean>>
  }> {
    const s = await ready()
    const sessions = Object.fromEntries(
      DIRECT_PLATFORMS.filter((p) => s.platforms[p]).map((p) => [
        p,
        p === 'luna'
          ? { connected: true, expiresAt: null, canRenew: false }
          : safeSessionSummary(s.platforms[p]!.profile)
      ])
    )
    return store.heartbeat({ version, running: true, sessions })
  }

  // One renewal per account at a time. A failure keeps the old bearer, so the account
  // still reports its real error instead of being hidden behind a renewal error.
  function renewPlatform(
    platform: DirectPlatformId,
    holder: { profile: SessionProfile }
  ): Promise<boolean> {
    if (!holder.profile.renewal) return Promise.resolve(false)
    let run = renewing.get(platform)
    if (!run) {
      run = (async () => {
        const result = await renewSession({
          platform,
          profile: holder.profile,
          fetchImpl: ((url: string, init: RequestInit) => ses.fetch(url, init)) as typeof fetch
        })
        const current = state?.platforms[platform]
        if (!state || !current) return false
        const headersByOrigin = { ...current.profile.headersByOrigin }
        // 챗플은 Login-At 헤더로 로그인한다. 나머지는 Authorization.
        const header = result.header || 'authorization'
        for (const origin of result.origins)
          headersByOrigin[origin] = {
            ...headersByOrigin[origin],
            [header]: result.authorization
          }
        const primary =
          platform === 'teapot' ? 'https://firestore.googleapis.com' : allowed[platform]?.origin
        const profile: SessionProfile = {
          ...current.profile,
          headersByOrigin,
          headers: result.origins.includes(primary)
            ? { ...current.profile.headers, [header]: result.authorization }
            : current.profile.headers,
          renewal: result.renewal,
          renewedAt: new Date().toISOString()
        }
        state.platforms[platform] = { ...current, profile }
        holder.profile = profile
        await persist()
        lastRenewal.delete(platform)
        return true
      })().finally(() => renewing.delete(platform))
      renewing.set(platform, run)
    }
    return run
  }

  async function transport(
    platform: DirectPlatformId,
    holder: { profile: SessionProfile },
    request: EngineRequest,
    retried = false
  ): Promise<Response> {
    const { url, method = 'GET' } = request,
      profile = holder.profile
    if (platform === 'teapot') {
      const query = JSON.parse(request.body || '{}')
      const approved = teapotQueries(profile).some((q) => {
        const known = q as { parent: string; structuredQuery: unknown }
        return (
          url === 'https://firestore.googleapis.com/v1/' + known.parent + ':runQuery' &&
          JSON.stringify(query) === JSON.stringify({ structuredQuery: known.structuredQuery })
        )
      })
      if (method !== 'POST' || !approved) throw new Error('UNAPPROVED_READ_QUERY')
    } else if (method !== 'GET') throw new Error('READ_ONLY')
    else readRoute(platform, url)
    const origin = new URL(url).origin
    const headers =
      profile.headersByOrigin?.[origin] ||
      (platform === 'teapot' || origin === allowed[platform]?.origin ? profile.headers : {}) ||
      {}
    const response = await ses.fetch(url, {
      method,
      headers: { ...headers, ...request.headers },
      body: request.body,
      credentials: 'include',
      redirect: 'error',
      signal: request.signal || AbortSignal.timeout(15_000)
    })
    // An expired bearer is renewed once in place, so the caller never sees the stale failure.
    if (
      !response.ok &&
      !retried &&
      (await renewable(response)) &&
      (await renewPlatform(platform, holder).catch((error: Error) => {
        lastRenewal.set(platform, error.message)
        return false
      }))
    )
      return transport(platform, holder, request, true)
    return response
  }

  async function runPlatform(platform: DirectPlatformId): Promise<RunResult> {
    const s = await ready(),
      current = s.platforms[platform]
    if (!current) return { status: 'login', detail: '로그인이 필요해요.' }
    const holder = { profile: current.profile }
    let last: RunResult = { status: 'ok', detail: '' }
    const report = async (status: RunResult['status'], detail: string): Promise<void> => {
      last = { status, detail }
      await store.ingest({
        transport: 'direct-api',
        platform,
        channel: 'api-status',
        items: [],
        status,
        detail
      })
    }
    // Renew before the round rather than after a failure, so one expiry does not cost a cycle.
    const due = renewableExpiry(holder.profile)
    if (due && Date.parse(due) - Date.now() < 300_000)
      await renewPlatform(platform, holder).catch((error: Error) =>
        lastRenewal.set(platform, error.message)
      )
    const request = (r: EngineRequest): Promise<Response> => transport(platform, holder, r)
    const commit = async (batch: EngineBatch): Promise<void> => {
      const status: RunResult['status'] =
        batch.issues?.length || batch.unmapped
          ? 'partial'
          : batch.checkpoint?.complete
            ? 'ok'
            : 'partial'
      const detail =
        '앱 수집 · API 응답 ' +
        (batch.received ?? batch.items.length) +
        '건 · 미분류 ' +
        (batch.unmapped || 0) +
        '건 · 변환 누락 ' +
        (batch.issues?.length || 0) +
        '건' +
        (batch.checkpoint?.next ? ' · 다음 페이지 이어받기' : '')
      await store.ingest({ ...batch, transport: 'direct-api', status, detail, items: batch.items })
      last = { status, detail }
      if (batch.checkpoint) s.checkpoints[platform] = batch.checkpoint
    }
    const stored = s.checkpoints[platform],
      cursor = stored?.complete ? null : stored
    try {
      if (platform === 'eden')
        await collectEden({
          profile: holder.profile,
          transport: request,
          commit,
          checkpoint: cursor
        })
      else if (platform === 'luna')
        await collectLuna({ transport: request, commit, checkpoint: cursor })
      else if (platform === 'teapot')
        await collectTeapot({ profile: holder.profile, transport: request, commit })
      else {
        const route =
          platform === 'rplay'
            ? holder.profile.routes?.['/account/getuser']
            : holder.profile.routes?.[new URL(endpoints[platform]).pathname] || endpoints[platform]
        if (!route) throw new Error('SESSION_ROUTES_MISSING')
        // Refresh the newest page even while a historical continuation is pending.
        if (cursor?.next)
          await collectPages({
            platform,
            transport: request,
            commit: async (batch) => {
              await store.ingest({
                ...batch,
                transport: 'direct-api',
                channel: 'latest',
                status: 'partial',
                detail: '앱 수집 · 최신 알림 API 조회',
                items: batch.items
              })
            },
            startUrl: route,
            maxPages: 1,
            stage: 'latest'
          })
        await collectPages({
          platform,
          transport: request,
          commit,
          startUrl: route,
          checkpoint: cursor,
          maxPages: 40,
          stage: platform === 'rplay' ? 'getuser' : 'list'
        })
        const popup =
          platform === 'rplay'
            ? holder.profile.routes?.['/account/popup-notifications/active']
            : undefined
        if (popup) {
          const response = await request({ platform, url: popup, method: 'GET' })
          if (!response.ok) throw await readError(platform, response, popup, 'popup')
          const batch = normalize(platform, await response.json(), {
            channel: 'global',
            classification: { event: 'admin', type: 'popup', evidence: 'source-route' }
          })
          await commit({ ...batch, platform, channel: 'global' })
        }
      }
    } catch (error) {
      // The stored token's own expiry travels with the failure, so an expired
      // credential is never mistaken for a broken route or a server outage.
      const message = error instanceof Error ? error.message : String(error)
      const oldest = Object.values(expiryByOrigin(holder.profile)).sort()[0] || null,
        renewal = lastRenewal.get(platform)
      const suffix = [
        oldest && traceText({ tokenExp: oldest, now: new Date().toISOString() }),
        renewal && 'renewal=' + JSON.stringify(String(renewal).slice(0, 200))
      ]
        .filter(Boolean)
        .map((x) => ' · ' + x)
        .join('')
      const login = error instanceof SessionExpired || NEEDS_LOGIN.has(message)
      await report(login ? 'login' : 'error', message + suffix).catch(() => undefined)
    } finally {
      lastRenewal.delete(platform)
      s.lastRun[platform] = Date.now()
      await persist().catch(() => undefined)
    }
    return last
  }

  async function tick(): Promise<void> {
    if (ticking || stopped) return
    ticking = true
    try {
      const s = await ready()
      const connected = DIRECT_PLATFORMS.filter((p) => s.platforms[p])
      if (!connected.length) return
      const gate = await heartbeat()
      if (!gate.enabled) return
      const due = connected
        .filter(
          (p) =>
            gate.selection[p] !== false &&
            !connecting.has(p) &&
            Date.now() - (s.lastRun[p] || 0) >= RUN_EVERY
        )
        .slice(0, 2)
      for (const platform of due) await runPlatform(platform)
    } catch {
      /* A failed round is reported per platform; the next tick retries. */
    } finally {
      ticking = false
    }
  }

  async function openBrowser(): Promise<LoginBrowser> {
    if (browser?.alive) return browser
    browser = await LoginBrowser.launch(options.profileDir)
    return browser
  }
  async function closeBrowser(): Promise<void> {
    const open = browser
    browser = null
    if (open?.alive) await open.close()
  }

  async function capture(
    open: LoginBrowser,
    platform: DirectPlatformId
  ): Promise<SessionProfile | null> {
    const tab = await open.openCaptureTab(SITES[platform], CAPTURE_SCRIPT)
    let profile: SessionProfile | undefined = platform === 'luna' ? cookieOnly() : undefined
    const started = Date.now()
    try {
      while (Date.now() - started < 25_000) {
        await sleep(500)
        for (const message of await tab.poll()) {
          const captured = message as { platform?: string; profile?: unknown }
          if (captured.platform !== platform) continue
          try {
            profile = profileUpdate(platform, captured.profile, profile)
          } catch {
            /* A request from another API on the page is not this session. */
          }
        }
        // Late renewal tokens are worth a few seconds; a complete capture ends early.
        const elapsed = Date.now() - started
        if (elapsed >= 4_000 && captureComplete(platform, profile)) break
        // A signed-in site sends its first API call within a few seconds. Nothing usable by
        // now means signed out, so the person is not kept waiting for the full window.
        if (elapsed >= SIGNED_OUT_AFTER && !sessionReady(platform, profile)) break
      }
    } finally {
      await tab.close()
    }
    return sessionReady(platform, profile) ? profile! : null
  }

  async function clearCookies(platform: DirectPlatformId): Promise<void> {
    for (const cookie of await ses.cookies.get({})) {
      const domain = cookie.domain || ''
      if (cookieBelongs(platform, domain))
        await ses.cookies
          .remove('https://' + domain.replace(/^\./, '') + (cookie.path || '/'), cookie.name)
          .catch(() => undefined)
    }
  }
  async function importCookies(
    platform: DirectPlatformId,
    cookies: BrowserCookie[]
  ): Promise<void> {
    await clearCookies(platform)
    // A browser-session cookie would end with this app's session; it is kept for a month
    // instead, and the site itself still decides whether it is valid.
    const month = Math.floor(Date.now() / 1000) + 30 * 86_400
    for (const cookie of cookies) {
      if (!cookieBelongs(platform, cookie.domain) || cookie.partitionKey) continue
      const host = cookie.domain.replace(/^\./, '')
      await ses.cookies
        .set({
          url: 'https://' + host + (cookie.path || '/'),
          name: cookie.name,
          value: cookie.value,
          ...(cookie.domain.startsWith('.') ? { domain: cookie.domain } : {}),
          path: cookie.path || '/',
          secure: cookie.secure,
          httpOnly: cookie.httpOnly,
          expirationDate: cookie.session || !(cookie.expires > 0) ? month : cookie.expires,
          sameSite:
            cookie.sameSite === 'Strict'
              ? 'strict'
              : cookie.sameSite === 'Lax'
                ? 'lax'
                : cookie.sameSite === 'None'
                  ? 'no_restriction'
                  : 'unspecified'
        })
        .catch(() => undefined)
    }
    await ses.cookies.flushStore()
  }

  async function forget(platform: DirectPlatformId): Promise<void> {
    const s = await ready()
    await clearCookies(platform)
    delete s.platforms[platform]
    delete s.checkpoints[platform]
    delete s.lastRun[platform]
    await persist()
  }

  // Reads the platform's session from the NAIS3 profile under DevTools. The sign-in window
  // must be closed first: Google refuses to sign in on a browser under remote control, and
  // one profile can only be open once. `openLogin` opens that window when no session is found.
  async function attempt(platform: DirectPlatformId, openLogin: boolean): Promise<ConnectResult> {
    if (connecting.has(platform)) return { state: 'error', detail: 'CONNECT_IN_PROGRESS' }
    connecting.add(platform)
    try {
      const s = await ready()
      // The person is still signing in: another platform opens as a tab in that window.
      if (!browser?.alive && profileInUse(options.profileDir)) {
        if (!openLogin) return { state: 'login-required', detail: null }
        await openSignInWindow(options.profileDir, SITES[platform])
        waitForSignIn(platform)
        return { state: 'login-required', detail: null }
      }
      // Never connected and not mid sign-in: there is nothing to check yet, so the sign-in
      // window opens at once. Closing it runs the check anyway.
      if (openLogin && !browser?.alive && !s.platforms[platform] && !awaitingLogin.has(platform)) {
        await openSignInWindow(options.profileDir, SITES[platform])
        waitForSignIn(platform)
        return { state: 'login-required', detail: null }
      }
      let connected: ConnectResult | null = null
      try {
        const open = await openBrowser()
        const profile = await capture(open, platform)
        if (profile) {
          await importCookies(platform, await open.cookies())
          s.userAgent = open.userAgent
          ses.setUserAgent(open.userAgent)
          s.platforms[platform] = { profile, connectedAt: new Date().toISOString() }
          delete s.checkpoints[platform]
          delete s.lastRun[platform]
          await persist()
          // The first collection is the proof: a signed-out site answers it with 401/403.
          const result = await runPlatform(platform)
          if (result.status !== 'login')
            connected = {
              state: 'connected',
              detail: result.status === 'error' ? result.detail : null
            }
          else await forget(platform)
        }
      } finally {
        // The DevTools browser only lives for the check; another check may still be using it.
        if (connecting.size === 1) await closeBrowser()
      }
      if (connected) {
        awaitingLogin.delete(platform)
        await heartbeat().catch(() => undefined)
        return connected
      }
      if (openLogin) {
        await profileReleased(options.profileDir)
        await openSignInWindow(options.profileDir, SITES[platform])
        waitForSignIn(platform)
      }
      return { state: 'login-required', detail: null }
    } catch (error) {
      return { state: 'error', detail: error instanceof Error ? error.message : String(error) }
    } finally {
      connecting.delete(platform)
    }
  }
  const connect = (platform: DirectPlatformId): Promise<ConnectResult> => attempt(platform, true)

  function stopWatching(): void {
    if (watchTimer) clearInterval(watchTimer)
    watchTimer = null
  }
  function waitForSignIn(platform: DirectPlatformId): void {
    awaitingLogin.add(platform)
    signInOpen = true
    if (!watchTimer) {
      watchTimer = setInterval(() => void watchTick(), 1_500)
      watchTimer.unref()
    }
    void heartbeat().catch(() => undefined)
  }
  // Watches only whether the sign-in window is still open (the profile's lockfile), never
  // the page itself. Once it closes, each platform waiting for sign-in is checked once;
  // one still signed out keeps its "로그인 완료" button for another try.
  async function watchTick(): Promise<void> {
    if (watching || stopped) return
    watching = true
    try {
      if (!awaitingLogin.size) {
        signInOpen = false
        return stopWatching()
      }
      if (browser?.alive || connecting.size) return
      if (profileInUse(options.profileDir)) {
        signInOpen = true
        return
      }
      if (!signInOpen) return
      signInOpen = false
      for (const platform of [...awaitingLogin]) await attempt(platform, false)
      await heartbeat().catch(() => undefined)
    } catch {
      /* The next tick or the button tries again. */
    } finally {
      watching = false
    }
  }

  // 답글 쓰기는 수집용 transport(읽기 전용)와 분리한다. 플랫폼마다 그 사이트의 댓글 주소로만
  // 보낼 수 있고, 만료된 토큰은 수집과 같은 방식으로 한 번 갱신한다.
  async function replyContext(
    platform: DirectPlatformId
  ): Promise<{ adapter: (typeof REPLY_ADAPTERS)[string]; ctx: ReplyContext }> {
    const adapter = REPLY_ADAPTERS[platform]
    if (!adapter) throw new ReplyError('REPLY_UNSUPPORTED')
    const s = await ready()
    const current = s.platforms[platform]
    if (!current) throw new ReplyError('LOGIN_REQUIRED')
    const holder = { profile: current.profile }
    // 쓰기 주소는 writeAllowed로 그 플랫폼 댓글 주소로만 제한돼 있다. 그 주소에 따로 기록된
    // 헤더가 없으면 같은 플랫폼 세션의 기본 헤더를 쓴다 (예: 티팟 함수 호출, 스토리챗 목록).
    const headersFor = (origin: string): Record<string, string> =>
      holder.profile.headersByOrigin?.[origin] ||
      holder.profile.headers ||
      Object.values(holder.profile.headersByOrigin || {})[0] ||
      {}
    const send: WriteSend = async (url, init) => {
      if (!writeAllowed(platform, url)) throw new ReplyError('UNAPPROVED_WRITE_ROUTE')
      const origin = new URL(url).origin
      const form = init.form
        ? (): FormData => {
            const data = new FormData()
            for (const [key, value] of Object.entries(init.form!)) data.append(key, value)
            return data
          }
        : null
      const call = (): Promise<Response> =>
        ses.fetch(url, {
          method: init.method,
          headers: {
            ...(form ? {} : headersFor(origin)),
            ...(init.body ? { 'content-type': 'application/json' } : {}),
            ...init.headers
          },
          body: form ? form() : init.body,
          credentials: 'include',
          redirect: 'error',
          signal: AbortSignal.timeout(15_000)
        })
      const response = await call()
      if (
        !response.ok &&
        (await renewable(response.clone())) &&
        (await renewPlatform(platform, holder).catch(() => false))
      )
        return call()
      return response
    }
    const ctx: ReplyContext = {
      send,
      async cookie(domain, name) {
        const found = await ses.cookies.get({ domain, name })
        return found[0]?.value ?? null
      },
      accountId(origin) {
        const token = String(headersFor(origin).authorization || '').replace(/^Bearer\s+/i, '')
        try {
          const payload = JSON.parse(Buffer.from(token.split('.')[1] || '', 'base64url').toString())
          const id = payload.sub ?? payload.user_id
          return typeof id === 'string' ? id : null
        } catch {
          return null
        }
      },
      route(path) {
        const value = (holder.profile.routes as Record<string, unknown> | undefined)?.[path]
        return typeof value === 'string' ? value : null
      }
    }
    return { adapter, ctx }
  }

  return {
    start() {
      stopped = false
      ready().catch(() => undefined)
      setTimeout(() => void tick(), 5_000).unref()
      timer = setInterval(() => void tick(), 30_000)
      timer.unref()
    },
    async stop() {
      stopped = true
      if (timer) clearInterval(timer)
      timer = null
      stopWatching()
      await closeBrowser().catch(() => undefined)
    },
    connect,
    collect: tick,
    async workImage(platform, workId) {
      const route = IMAGE_ROUTES[platform]
      if (!route) return null
      // 요청이 필요 없는 플랫폼(알플레이)은 로그인 없이도 주소를 만든다.
      if (!route.url)
        return readWorkImage(platform, workId, () => Promise.reject(new Error('NO_READ')))
      const s = await ready()
      const current = s.platforms[platform as DirectPlatformId]
      if (!current) return null
      const holder = { profile: current.profile }
      const read = async (url: string): Promise<Response> => {
        if (!imageReadAllowed(platform, url)) throw new Error('UNAPPROVED_READ_ROUTE')
        const origin = new URL(url).origin
        const call = (): Promise<Response> =>
          ses.fetch(url, {
            headers:
              holder.profile.headersByOrigin?.[origin] ||
              (origin === allowed[platform as DirectPlatformId]?.origin
                ? holder.profile.headers
                : {}) ||
              {},
            credentials: 'include',
            redirect: 'error',
            signal: AbortSignal.timeout(15_000)
          })
        const response = await call()
        if (
          !response.ok &&
          (await renewable(response.clone())) &&
          (await renewPlatform(platform as DirectPlatformId, holder).catch(() => false))
        )
          return call()
        return response
      }
      return readWorkImage(platform, workId, read)
    },
    async myWorks(platform) {
      if (!MY_WORK_LISTS[platform]) return []
      const s = await ready()
      const current = s.platforms[platform as DirectPlatformId]
      if (!current) throw new ReplyError('LOGIN_REQUIRED')
      const holder = { profile: current.profile }
      const read: WorkRead = async (url, init) => {
        if (!myWorksReadAllowed(platform, url)) throw new Error('UNAPPROVED_READ_ROUTE')
        const origin = new URL(url).origin
        const call = (): Promise<Response> =>
          ses.fetch(url, {
            method: init?.method ?? 'GET',
            headers: {
              ...(holder.profile.headersByOrigin?.[origin] || holder.profile.headers || {}),
              ...(init?.contentType ? { 'content-type': init.contentType } : {})
            },
            body: init?.body,
            credentials: 'include',
            redirect: 'error',
            signal: AbortSignal.timeout(20_000)
          })
        const response = await call()
        if (
          !response.ok &&
          ((await renewable(response.clone())) ||
            // 알플레이는 만료를 500 {"error":"jwt expired"} 로도 알린다
            (platform === 'rplay' &&
              response.status === 500 &&
              /jwt expired/i.test(await response.clone().text()))) &&
          (await renewPlatform(platform as DirectPlatformId, holder).catch(() => false))
        )
          return call()
        return response
      }
      const teapotUid =
        platform === 'teapot'
          ? firebaseUid(
              holder.profile.headersByOrigin?.['https://firestore.googleapis.com']?.authorization
            )
          : null
      let rplayOid: string | null = null
      if (platform === 'rplay') {
        const route = (holder.profile.routes as Record<string, unknown> | undefined)?.[
          '/account/getuser'
        ]
        try {
          rplayOid = typeof route === 'string' ? new URL(route).searchParams.get('userOid') : null
        } catch {
          rplayOid = null
        }
      }
      return readMyWorks(platform, read, { teapotUid, rplayOid })
    },
    async workAccount(platform) {
      const s = await ready()
      const profile = s.platforms[platform as DirectPlatformId]?.profile
      if (!profile) return null
      if (platform === 'teapot') {
        const uid = firebaseUid(
          profile.headersByOrigin?.['https://firestore.googleapis.com']?.authorization
        )
        return uid ? { uid } : null
      }
      if (platform === 'rplay') {
        const route = (profile.routes as Record<string, unknown> | undefined)?.['/account/getuser']
        try {
          const q = typeof route === 'string' ? new URL(route).searchParams : null
          const oid = q?.get('requestorOid') || q?.get('userOid') || ''
          return /^[a-f0-9]{24}$/.test(oid)
            ? { oid, loginType: q?.get('loginType') || 'rplay' }
            : null
        } catch {
          return null
        }
      }
      return null
    },
    async workRead(platform, url, init) {
      if (!workReadAllowed(platform, url, init)) throw new Error('UNAPPROVED_READ_ROUTE')
      const s = await ready()
      const current = s.platforms[platform as DirectPlatformId]
      if (!current) throw new ReplyError('LOGIN_REQUIRED')
      const holder = { profile: current.profile }
      const origin = new URL(url).origin
      const call = (): Promise<Response> =>
        ses.fetch(url, {
          method: init?.method ?? 'GET',
          headers: {
            ...(holder.profile.headersByOrigin?.[origin] || holder.profile.headers || {}),
            ...(init?.contentType ? { 'content-type': init.contentType } : {})
          },
          body: init?.body,
          credentials: 'include',
          redirect: 'error',
          signal: AbortSignal.timeout(20_000)
        })
      const response = await call()
      if (
        (await workExpired(platform, response)) &&
        (await renewPlatform(platform as DirectPlatformId, holder).catch(() => false))
      )
        return call()
      return response
    },
    async workWrite(platform, method, url, body) {
      if (!workWriteAllowed(platform, method, url)) throw new Error('UNAPPROVED_WRITE_ROUTE')
      const s = await ready()
      const current = s.platforms[platform as DirectPlatformId]
      if (!current) throw new ReplyError('LOGIN_REQUIRED')
      const holder = { profile: current.profile }
      const origin = new URL(url).origin
      // 본문 없는 요청(삭제)은 본문과 content-type을 붙이지 않는다
      const payload = body === undefined ? undefined : JSON.stringify(body)
      const call = (): Promise<Response> =>
        ses.fetch(url, {
          method,
          headers: {
            ...(holder.profile.headersByOrigin?.[origin] || holder.profile.headers || {}),
            ...(payload === undefined ? {} : { 'content-type': 'application/json' })
          },
          body: payload,
          credentials: 'include',
          redirect: 'error',
          signal: AbortSignal.timeout(30_000)
        })
      const response = await call()
      // 로그인 만료로 거절된 요청은 저장되지 않았으므로 로그인을 이어 붙인 뒤 한 번만 다시 보낸다.
      if (
        (await workExpired(platform, response)) &&
        (await renewPlatform(platform as DirectPlatformId, holder).catch(() => false))
      )
        return call()
      return response
    },
    async workSend(platform, request) {
      // 허용 검사가 먼저다. 주소·본문 종류·헤더 이름 중 하나라도 규칙 밖이면 여기서 던진다.
      const rule = workSendRule(platform, request)
      const s = await ready()
      const current = s.platforms[platform as DirectPlatformId]
      if (!current) throw new ReplyError('LOGIN_REQUIRED')
      const holder = { profile: current.profile }
      const origin = new URL(request.url).origin
      // 로그인 헤더는 규칙이 정한 만큼만 붙인다. 다른 회사 저장소(none)에는 아무것도 붙이지 않고,
      // origin은 그 주소에 따로 저장된 헤더만 쓴다 (플랫폼 기본 헤더로 넘어가지 않는다).
      const stored = (): Record<string, string> =>
        rule.auth === 'session'
          ? holder.profile.headersByOrigin?.[origin] || holder.profile.headers || {}
          : rule.auth === 'origin'
            ? holder.profile.headersByOrigin?.[origin] || {}
            : {}
      const body = (): BodyInit | undefined => {
        if (request.json !== undefined) return JSON.stringify(request.json)
        if (request.form) {
          const data = new FormData()
          for (const field of request.form)
            if ('file' in field)
              data.append(
                field.name,
                new Blob([Buffer.from(field.file.data)], { type: field.file.type }),
                field.file.name
              )
            else data.append(field.name, field.value)
          return data
        }
        if (request.bytes)
          return new Blob([Buffer.from(request.bytes.data)], { type: request.bytes.contentType })
        return undefined
      }
      // 사이트가 로그인 토큰을 쿠키에 적어 두고 그 쿠키로 확인하는 주소용. 알림 연장으로 토큰이
      // 새로 바뀌어도 쿠키는 옛 값이라, 사이트 코드가 하는 것처럼 지금 토큰을 쿠키에 맞춰 적는다.
      const syncCookie = async (): Promise<void> => {
        const cookie = rule.cookieFromBearer
        if (!cookie) return
        const main = allowed[platform as DirectPlatformId]?.origin
        const bearer = String(
          (main && holder.profile.headersByOrigin?.[main]?.authorization) ||
            holder.profile.headers?.authorization ||
            ''
        ).replace(/^Bearer\s+/i, '')
        if (!bearer || /\s/.test(bearer)) return
        await ses.cookies
          .set({
            url: 'https://' + cookie.domain + '/',
            name: cookie.name,
            value: bearer,
            domain: '.' + cookie.domain,
            path: '/',
            secure: true,
            sameSite: 'lax',
            expirationDate: Math.floor(Date.now() / 1000) + 30 * 86_400
          })
          .catch(() => undefined)
      }
      // 사이트가 쿠키의 CSRF 토큰을 헤더로 되돌려 보내게 하는 주소용 (젠잇). 쿠키가 없으면 보내지 않는다.
      const csrf = async (): Promise<Record<string, string>> => {
        const need = rule.csrfCookie
        if (!need) return {}
        const found = await ses.cookies.get({ domain: need.domain, name: need.name })
        const value = found[0]?.value
        if (!value || /[\s;]/.test(value)) throw new ReplyError('LOGIN_REQUIRED')
        return { [need.header]: value }
      }
      const call = async (): Promise<Response> => {
        await syncCookie()
        const token = await csrf()
        return ses.fetch(request.url, {
          method: request.method,
          headers: {
            ...stored(),
            ...(request.json !== undefined ? { 'content-type': 'application/json' } : {}),
            ...request.headers,
            ...token
          },
          body: body(),
          credentials: rule.auth === 'session' || rule.auth === 'cookie' ? 'include' : 'omit',
          redirect: 'error',
          signal: AbortSignal.timeout(60_000)
        })
      }
      const response = await call()
      // 로그인 만료로 거절된 요청은 반영되지 않았으므로 로그인을 이어 붙인 뒤 한 번만 다시 보낸다.
      // 저장소(origin·none)는 플랫폼 로그인과 상관없어 다시 보내지 않는다.
      const expired =
        rule.auth === 'session'
          ? await workExpired(platform, response)
          : rule.auth === 'cookie' && (response.status === 401 || response.status === 403)
      if (expired && (await renewPlatform(platform as DirectPlatformId, holder).catch(() => false)))
        return call()
      return response
    },
    async myWorkPlatforms() {
      const s = await ready()
      return DIRECT_PLATFORMS.filter((p) => s.platforms[p] && MY_WORK_LISTS[p])
    },
    async babeWorks() {
      const s = await ready()
      const current = s.platforms.babe
      if (!current) throw new ReplyError('LOGIN_REQUIRED')
      const holder = { profile: current.profile }
      const url = 'https://api.babechatapi.com/ko/api/characters/my'
      const origin = new URL(url).origin
      const call = (): Promise<Response> =>
        ses.fetch(url, {
          headers: holder.profile.headersByOrigin?.[origin] || holder.profile.headers || {},
          credentials: 'include',
          redirect: 'error',
          signal: AbortSignal.timeout(15_000)
        })
      let response = await call()
      if (
        !response.ok &&
        (await renewable(response.clone())) &&
        (await renewPlatform('babe', holder).catch(() => false))
      )
        response = await call()
      if (!response.ok) throw new ReplyError('WORKS_FAILED', response.status)
      return response.json()
    },
    async resolveReply(platform, item) {
      const { adapter, ctx } = await replyContext(platform)
      return adapter.resolve(ctx, item)
    },
    async edenReplies(commentIds) {
      const { ctx } = await replyContext('eden')
      return findEdenReplies(ctx, commentIds)
    },
    async reply(platform, item, content) {
      const text = checkContent(content)
      const { adapter, ctx } = await replyContext(platform)
      const target = await adapter.resolve(ctx, item)
      const { replyId } = await adapter.post(ctx, target, text)
      return { replyId, target }
    },
    async disconnect(platform) {
      awaitingLogin.delete(platform)
      await forget(platform)
      await heartbeat().catch(() => undefined)
    },
    async status() {
      const s = await ready().catch(() => null)
      return {
        error: s ? null : loadError,
        platforms: Object.fromEntries(
          DIRECT_PLATFORMS.map((p) => [
            p,
            {
              connected: !!s?.platforms[p],
              awaitingLogin: awaitingLogin.has(p),
              connecting: connecting.has(p),
              windowOpen: signInOpen
            }
          ])
        ) as Record<DirectPlatformId, DirectPlatformState>
      }
    }
  }
}
