// 작품 본문을 읽을 수 있는 플랫폼 연결부 등록부. 새 플랫폼은 여기 한 줄을 더한다.
import { edenWorks } from './eden'
import type { WorkAdapter } from './types'

export const WORK_ADAPTERS: Record<string, WorkAdapter> = {
  eden: edenWorks
}

// 사람이 부르는 이름 → 연결부 이름
const ALIASES: Record<string, string> = {
  에덴: 'eden',
  에덴챗: 'eden',
  edenchat: 'eden',
  'eden-chat': 'eden'
}

export function workAdapter(site: string): WorkAdapter {
  const key = String(site || '')
    .trim()
    .toLowerCase()
  const adapter = WORK_ADAPTERS[ALIASES[key] ?? key]
  if (!adapter) throw new Error('UNKNOWN_SITE')
  return adapter
}

/** 그 플랫폼 작품 읽기 주소로 허용된 것인지 (collector가 요청 전에 확인한다) */
export function workReadAllowed(platform: string, url: string): boolean {
  return WORK_ADAPTERS[platform]?.readAllowed(url) ?? false
}

/** 그 플랫폼 작품 저장 요청으로 허용된 것인지 (collector가 요청 전에 확인한다) */
export function workWriteAllowed(platform: string, method: string, url: string): boolean {
  return WORK_ADAPTERS[platform]?.writeAllowed?.(method, url) ?? false
}
