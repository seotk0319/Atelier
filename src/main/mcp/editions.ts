// MCP로 바꾼 작품의 마지막 저장 시각을 남기는 곳 (<userData>/mcp/editions.json).
// 도구 호출 기록(activity.ts)이 만든 한 줄을 받아, 작품을 바꾸는 도구가 성공했을 때만 쓴다.
// Electron을 모른다 (파일 경로만 받는다). 본문은 담지 않고 제목·시각·도구 이름만 쓴다.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { McpActivity } from '../../shared/types'
import type { EditionRecord } from '../../shared/work-freshness'

/** 성공하면 그 작품이 바뀐 것으로 보는 도구 */
export const CHANGE_TOOLS = new Set([
  'work_save',
  'edition_save',
  'work_create',
  'images_apply',
  'cover_apply',
  'canvas_apply'
])

const recordKey = (site: string, workId: string): string => site + ':' + workId

/**
 * 기록 한 줄이 저장 기록에 주는 변화. 바꾸는 도구가 성공(ok)했고 저장 확인이 명시적으로
 * 실패(verified === false)하지 않았으면 'save', 작품 삭제가 성공했으면 'delete', 그 밖은 null.
 * 사이트나 작품 번호를 모르면 어느 작품인지 몰라 null.
 */
export function editionChange(a: McpActivity): 'save' | 'delete' | null {
  if (!a.ok || !a.site || !a.workId) return null
  if (a.tool === 'work_delete') return 'delete'
  if (CHANGE_TOOLS.has(a.tool) && a.verified !== false) return 'save'
  return null
}

export interface EditionStore {
  /** 도구 호출 기록 하나를 반영한다. 절대 던지지 않는다 */
  apply(activity: McpActivity): void
  /** 저장된 기록 전부 (최근 저장 순) */
  list(): Promise<EditionRecord[]>
  /** 밀린 파일 쓰기가 끝날 때까지 (테스트용) */
  flush(): Promise<void>
}

const isRecord = (v: unknown): v is EditionRecord => {
  if (!v || typeof v !== 'object') return false
  const r = v as Record<string, unknown>
  return (
    typeof r.site === 'string' &&
    typeof r.workId === 'string' &&
    typeof r.lastSavedAt === 'string' &&
    typeof r.lastTool === 'string' &&
    (r.title === null || typeof r.title === 'string')
  )
}

export function createEditionStore(options: { file: string }): EditionStore {
  const records = new Map<string, EditionRecord>()
  let chain: Promise<void> = Promise.resolve()
  const queue = (job: () => Promise<void>): Promise<void> =>
    (chain = chain.then(job).catch(() => undefined))

  const ready = queue(async () => {
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(options.file, 'utf8'))
    } catch {
      return // 처음이거나 손상된 파일
    }
    const list = Array.isArray((parsed as { records?: unknown })?.records)
      ? (parsed as { records: unknown[] }).records
      : []
    for (const r of list)
      if (isRecord(r) && !records.has(recordKey(r.site, r.workId)))
        records.set(recordKey(r.site, r.workId), r)
  })

  const sorted = (): EditionRecord[] =>
    [...records.values()].sort((a, b) => b.lastSavedAt.localeCompare(a.lastSavedAt))

  async function save(): Promise<void> {
    await mkdir(dirname(options.file), { recursive: true })
    const text = JSON.stringify({ version: 1, records: sorted() }, null, 2)
    const tmp = options.file + '.tmp'
    await writeFile(tmp, text)
    // 바꿔치기가 막히면(다른 프로그램이 잡고 있음 등) 바로 쓴다
    await rename(tmp, options.file).catch(() => writeFile(options.file, text))
  }

  return {
    apply(activity) {
      let change: 'save' | 'delete' | null
      try {
        change = editionChange(activity)
      } catch {
        return
      }
      if (!change) return
      const site = activity.site!
      const workId = activity.workId!
      // 파일을 다 읽은 뒤에 반영해야 읽은 내용이 새 기록을 덮지 않는다
      void queue(async () => {
        const key = recordKey(site, workId)
        if (change === 'delete') {
          if (!records.delete(key)) return
        } else {
          const prev = records.get(key)
          records.set(key, {
            site,
            workId,
            title: activity.workTitle ?? prev?.title ?? null,
            lastSavedAt: activity.at,
            lastTool: activity.tool
          })
        }
        await save()
      })
    },
    async list() {
      await ready
      await chain
      return sorted()
    },
    flush() {
      return chain
    }
  }
}
