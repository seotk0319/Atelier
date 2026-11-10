// 작품 본문을 읽을 수 있는 플랫폼 연결부 등록부. 새 플랫폼은 여기 한 줄을 더한다.
import { babeWorks } from './babe'
import { chatpleWorks } from './chatple'
import { crackWorks } from './crack'
import { rplayWorks } from './rplay'
import { teapotWorks } from './teapot'
import { edenWorks } from './eden'
import { elynWorks } from './elyn'
import { genitWorks } from './genit'
import { lunaWorks } from './luna'
import { nekoWorks } from './neko'
import { uumaiWorks } from './uumai'
import type { SendRule, WorkAdapter, WorkReadInit, WorkRequest } from './types'

export const WORK_ADAPTERS: Record<string, WorkAdapter> = {
  eden: edenWorks,
  babe: babeWorks,
  genit: genitWorks,
  luna: lunaWorks,
  elyn: elynWorks,
  neko: nekoWorks,
  teapot: teapotWorks,
  crack: crackWorks,
  rplay: rplayWorks,
  uumai: uumaiWorks,
  chatple: chatpleWorks
}

// 사람이 부르는 이름 → 연결부 이름
const ALIASES: Record<string, string> = {
  에덴: 'eden',
  에덴챗: 'eden',
  edenchat: 'eden',
  'eden-chat': 'eden',
  바베: 'babe',
  바베챗: 'babe',
  베이비챗: 'babe',
  babechat: 'babe',
  젠잇: 'genit',
  루나: 'luna',
  루나톡: 'luna',
  lunatalk: 'luna',
  엘린: 'elyn',
  elynai: 'elyn',
  'elyn.ai': 'elyn',
  네코: 'neko',
  네코챗: 'neko',
  nekochat: 'neko',
  크랙: 'crack',
  뤼튼: 'crack',
  wrtn: 'crack',
  'crack.wrtn.ai': 'crack',
  알플: 'rplay',
  알플레이: 'rplay',
  'rplay.live': 'rplay',
  티팟: 'teapot',
  teapotchat: 'teapot',
  우마이: 'uumai',
  우우마이: 'uumai',
  'uumm.ai': 'uumai',
  챗플: 'chatple',
  'chatple.live': 'chatple'
}

/** 어느 플랫폼이든 이 도구로 못 하는 일 (스킬 references/mcp.md 「MCP가 못 하는 일」의 '전체' 줄) */
export const MANUAL_EVERYWHERE = ['실제 채팅 시험(로어북 발동, 이미지 출력 확인)']

/** 계획 도구 결과에 넣는 "이 플랫폼에서 저장하면 생기는 일" 한 줄 (안내가 없는 연결부는 빈 객체) */
export const platformNote = (adapter: WorkAdapter): { platform_note?: string } =>
  adapter.guide ? { platform_note: adapter.guide.save } : {}

/** 작품 번호를 견주거나 저장 이름으로 쓸 때의 모양. 번호가 대소문자를 구분하는 플랫폼(티팟)은 그대로 둔다 */
export const workKey = (adapter: WorkAdapter, id: string): string =>
  adapter.caseSensitiveIds ? id : id.toLowerCase()

export function workAdapter(site: string): WorkAdapter {
  const key = String(site || '')
    .trim()
    .toLowerCase()
  const adapter = WORK_ADAPTERS[ALIASES[key] ?? key]
  if (!adapter) throw new Error('UNKNOWN_SITE')
  return adapter
}

/** 그 플랫폼 작품 읽기 주소로 허용된 것인지 (collector가 요청 전에 확인한다) */
export function workReadAllowed(platform: string, url: string, init?: WorkReadInit): boolean {
  const adapter = WORK_ADAPTERS[platform]
  if (!adapter) return false
  // 본문 없는 GET만 readAllowed로 본다. POST 읽기는 연결부가 주소·본문 종류·본문 모양까지 따로 허용해야 한다.
  if ((init?.method ?? 'GET') === 'GET')
    return init?.body === undefined && init?.contentType === undefined && adapter.readAllowed(url)
  return init?.method === 'POST' && (adapter.readPostAllowed?.(url, init) ?? false)
}

/** 그 플랫폼 작품 저장 요청으로 허용된 것인지 (collector가 요청 전에 확인한다) */
export function workWriteAllowed(platform: string, method: string, url: string): boolean {
  return WORK_ADAPTERS[platform]?.writeAllowed?.(method, url) ?? false
}

/**
 * JSON이 아니거나 플랫폼 밖 주소(파일 저장소 등)로 가는 요청의 규칙. 허용되지 않았으면 던진다.
 * 주소뿐 아니라 본문 종류와 덧붙이는 헤더 이름까지 규칙과 맞아야 한다 (collector가 요청 전에 확인한다).
 */
export function workSendRule(platform: string, request: WorkRequest): SendRule {
  const rule = WORK_ADAPTERS[platform]?.sendRule?.(request.method, request.url) ?? null
  if (!rule) throw new Error('UNAPPROVED_WRITE_ROUTE')
  const bodies = [
    request.json !== undefined ? 'json' : null,
    request.form ? 'form' : null,
    request.bytes ? 'bytes' : null
  ].filter(Boolean)
  if (bodies.length > 1 || (bodies[0] ?? 'none') !== rule.body)
    throw new Error('UNAPPROVED_WRITE_ROUTE')
  const allowed = rule.headers ?? []
  for (const name of Object.keys(request.headers ?? {}))
    if (!allowed.includes(name.toLowerCase())) throw new Error('UNAPPROVED_WRITE_ROUTE')
  return rule
}
