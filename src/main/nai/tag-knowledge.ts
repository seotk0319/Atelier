// NAI 태그 지식 지표 조회. 모델별로 디스크에 캐시하고(14일), 한 번 받은 추천 목록의 다른 태그 값도 함께 저장한다.
// 조회는 NAI 웹이 글자를 칠 때마다 부르는 추천 API라 이미지 생성 비용이 들지 않는다.
import { app } from 'electron'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { knowledgeModel, normalizeTag } from '../../shared/tag-knowledge'
import { getNaiToken } from '../db/settings'
import { isArtistTag } from '../tags'
import { ENDPOINTS } from './endpoints'

const TTL_MS = 14 * 24 * 60 * 60_000
const MAX_PER_CALL = 120
const PARALLEL = 4
/** [count(-1 = 목록에 없음), 받은 시각] */
type Entry = [number, number]
interface Store {
  v: 1
  models: Record<string, Record<string, Entry>>
}

const file = (): string => join(app.getPath('userData'), 'tag-knowledge.json')
let store: Store | null = null
let saveTimer: ReturnType<typeof setTimeout> | null = null

async function load(): Promise<Store> {
  if (store) return store
  try {
    const raw = JSON.parse(await readFile(file(), 'utf8')) as Partial<Store>
    store = { v: 1, models: raw.models && typeof raw.models === 'object' ? raw.models : {} }
  } catch {
    store = { v: 1, models: {} }
  }
  return store
}

function scheduleSave(): void {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    if (!store) return
    const tmp = file() + '.' + process.pid + '.tmp'
    void writeFile(tmp, JSON.stringify(store))
      .then(() => rename(tmp, file()))
      .catch(() => undefined)
  }, 1500)
}

interface SuggestTag {
  tag?: unknown
  count?: unknown
}

async function ask(token: string, model: string, tag: string): Promise<SuggestTag[]> {
  const url =
    ENDPOINTS.suggestTags +
    '?model=' +
    encodeURIComponent(model) +
    '&prompt=' +
    encodeURIComponent(tag) +
    '&lang=en'
  const res = await fetch(url, {
    headers: { Authorization: 'Bearer ' + token.trim() },
    signal: AbortSignal.timeout(10_000)
  })
  if (res.status === 401 || res.status === 403) throw new Error('AUTH')
  if (!res.ok) throw new Error('HTTP ' + res.status)
  const data = (await res.json()) as { tags?: SuggestTag[] }
  return Array.isArray(data?.tags) ? data.tags : []
}

export async function tagKnowledge(
  tags: string[],
  model: string
): Promise<{ counts: Record<string, number | null>; artists?: string[]; error?: string }> {
  const m = knowledgeModel(model)
  const s = await load()
  const table = (s.models[m] ??= {})
  const now = Date.now()
  const all = [...new Set(tags.map(normalizeTag).filter(Boolean))]
  // 작가 이름은 추천 목록에 나오지 않아 "모름"으로 잘못 보인다 → 로컬 태그 사전으로 걸러 따로 돌려준다
  const artists = all.filter((k) => isArtistTag(k))
  const keys = all.filter((k) => !isArtistTag(k)).slice(0, MAX_PER_CALL)
  const fresh = (k: string): boolean => !!table[k] && now - table[k][1] < TTL_MS
  const todo = keys.filter((k) => !fresh(k))
  let error: string | undefined
  if (todo.length) {
    const token = getNaiToken()
    if (!token) error = 'NAI 계정을 먼저 연결해 주세요.'
    else {
      let next = 0
      const worker = async (): Promise<void> => {
        while (next < todo.length && !error) {
          const key = todo[next++]
          if (fresh(key)) continue
          try {
            const list = await ask(token, m, key)
            let found = -1
            for (const t of list) {
              if (typeof t.tag !== 'string' || typeof t.count !== 'number') continue
              const k = normalizeTag(t.tag)
              table[k] = [t.count, now]
              if (k === key) found = t.count
            }
            if (found < 0) table[key] = [-1, now]
          } catch (e) {
            error =
              e instanceof Error && e.message === 'AUTH'
                ? 'NAI 인증에 실패했어요. 계정을 확인해 주세요.'
                : '태그 지표를 받지 못했어요. 잠시 뒤 다시 해 주세요.'
          }
        }
      }
      await Promise.all(Array.from({ length: PARALLEL }, worker))
      scheduleSave()
    }
  }
  const counts: Record<string, number | null> = {}
  for (const k of keys) {
    const e = table[k]
    if (e) counts[k] = e[0] < 0 ? null : e[0]
  }
  return { counts, ...(artists.length ? { artists } : {}), ...(error ? { error } : {}) }
}
