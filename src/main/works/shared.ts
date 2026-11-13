// 작품 연결부들이 함께 쓰는 작은 도우미. 플랫폼마다 다른 것(주소·칸 이름)은 여기 두지 않는다.

import type { WorkFeature } from './types'

export type Obj = Record<string, unknown>

export const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)

export const text = (v: unknown): string => (typeof v === 'string' ? v : '')

export const list = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter(isObj) : [])

export const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)

export function at(index: unknown, length: number): number {
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= length)
    throw new Error('BAD_INDEX')
  return index
}

export const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []

export const keyList = (keys: string): string[] =>
  keys
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean)

export const str = (v: unknown): string => (typeof v === 'string' ? v : '')

export const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'

export const UUID_RE = new RegExp('^' + UUID + '$', 'i')

// extras에 그대로 싣는 짧은 값의 한도. 넘으면 글자 수·개수만 싣는다
export const EXTRA_TEXT_MAX = 80

export const EXTRA_LIST_MAX = 20

/** 할 수 있는 것 표의 한 줄 */
export const feature = (
  site: WorkFeature['site'],
  read: WorkFeature['read'],
  write: WorkFeature['write'],
  verified: WorkFeature['verified'],
  note?: string
): WorkFeature => ({ site, read, write, verified, ...(note ? { note } : {}) })
