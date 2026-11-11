// 작품 MCP 도구 호출 기록. 도구 표를 감싸 호출이 끝날 때마다 한 줄씩 남긴다.
// Electron을 모른다 (파일 경로와 알림 함수만 받는다). 본문·토큰은 담지 않고 개수·플래그만 쓴다.
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { McpActivity } from '../../shared/types'
import { toolMessage, type ToolDef } from '../works/tools'
import { workAdapter } from '../works/adapters'

type Obj = Record<string, unknown>
type Kind = McpActivity['kind']

const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const len = (v: unknown): number | null => (Array.isArray(v) ? v.length : null)
/** 짧은 식별 글자(사이트·작품 번호·언어 코드)만 받는다 */
const ident = (v: unknown, max = 100): string | null => {
  if (typeof v !== 'string' && typeof v !== 'number') return null
  const s = String(v).trim()
  return s && s.length <= max && !/[\r\n]/.test(s) ? s : null
}
const clip = (s: string, max: number): string => (s.length > max ? s.slice(0, max - 1) + '…' : s)

export const SAVE_TOOLS = new Set([
  'work_save',
  'edition_save',
  'images_apply',
  'cover_apply',
  'canvas_apply'
])

export function activityKind(tool: string): Kind {
  if (tool === 'work_create') return 'create'
  if (tool === 'work_delete') return 'delete'
  if (SAVE_TOOLS.has(tool)) return 'save'
  if (tool.endsWith('_plan')) return 'plan'
  if (
    tool.endsWith('_read') ||
    tool.endsWith('_list') ||
    tool === 'sites_list' ||
    tool === 'canvas_export'
  )
    return 'read'
  return 'other'
}

const LABELS: Record<string, string> = {
  sites_list: '플랫폼 목록 읽음',
  works_list: '작품 목록 읽음',
  work_read: '작품 읽음',
  lorebook_read: '로어북 읽음',
  start_scenarios_read: '시작 상황 읽음',
  characters_read: '캐릭터 읽음',
  editions_list: '언어 판본 목록 읽음',
  edition_read: '언어 판본 읽음',
  images_list: '이미지 목록 읽음',
  canvas_export: '캔버스 내보냄',
  work_plan: '저장 계획',
  edition_plan: '판본 저장 계획',
  images_plan: '이미지 계획',
  cover_plan: '표지 계획',
  work_delete_plan: '삭제 계획',
  canvas_plan: '캔버스 가져오기 계획',
  work_save: '저장',
  edition_save: '판본 저장',
  images_apply: '이미지 바꿈',
  cover_apply: '표지 바꿈',
  canvas_apply: '캔버스 가져옴',
  work_create: '새 작품 만듦',
  work_delete: '작품 삭제'
}
const label = (tool: string): string => LABELS[tool] ?? clip(tool, 40)

/** 계획 도구가 남긴 것: 적용 도구는 plan_id만 받으므로 사이트·작품·개수를 여기서 이어 준다 */
interface PlanNote {
  site: string | null
  workId: string | null
  title: string | null
  detail: string | null
}

const checked = (verified: boolean | null): string =>
  verified === true ? ' · 확인됨' : verified === false ? ' · 확인 안 됨' : ''

function imageDetail(args: Obj): string | null {
  const parts: string[] = []
  const add = len(args.add)
  const remove = len(args.remove)
  if (add) parts.push(add + '장 올림')
  if (remove) parts.push(remove + '장 지움')
  if (typeof args.main_file === 'string') parts.push('대표 바꿈')
  if (len(args.order)) parts.push('순서 바꿈')
  return parts.length ? parts.join(' · ') : null
}

function changeCount(result: Obj): string {
  if (result.nothing_to_save === true) return '바뀔 곳 없음'
  const n = len(result.changes)
  return n === null ? '' : n + '곳 바뀜'
}

const join = (...parts: (string | null | undefined | false)[]): string =>
  parts.filter((p): p is string => !!p).join(' · ')

/** 결과의 개수·플래그로 한 줄을 만든다. 본문은 쓰지 않는다 */
function describe(
  tool: string,
  args: Obj,
  result: Obj,
  verified: boolean | null,
  plan: PlanNote | null
): string {
  const lang = ident(result.language, 12) ?? ident(args.language, 12)
  switch (tool) {
    case 'sites_list': {
      const n = len(result.sites)
      return n === null ? label(tool) : '플랫폼 ' + n + '곳 확인'
    }
    case 'works_list': {
      const n = num(result.count) ?? len(result.works)
      return n === null ? label(tool) : '작품 목록 ' + n + '개 읽음'
    }
    case 'work_read': {
      const n = isObj(result.content) ? Object.keys(result.content).length : 0
      return n ? '작품 읽음 · 본문 ' + n + '칸' : '작품 개요 읽음'
    }
    case 'lorebook_read': {
      const n = len(result.entries)
      return n === null ? label(tool) : '로어북 ' + n + '개 읽음'
    }
    case 'start_scenarios_read': {
      const n = len(result.scenarios)
      return n === null ? label(tool) : '시작 상황 ' + n + '개 읽음'
    }
    case 'characters_read': {
      const n = len(result.characters)
      return n === null ? label(tool) : '캐릭터 ' + n + '개 읽음'
    }
    case 'editions_list': {
      const n = len(result.editions)
      return n === null ? label(tool) : '언어 판본 ' + n + '개 확인'
    }
    case 'edition_read': {
      const n = isObj(result.content) ? Object.keys(result.content).length : 0
      return join(lang ? lang + ' 판본 읽음' : label(tool), n ? '본문 ' + n + '칸' : null)
    }
    case 'images_list': {
      if (!Array.isArray(result.groups)) return label(tool)
      const total = result.groups.reduce<number>(
        (sum, g) => sum + (isObj(g) ? (num(g.count) ?? 0) : 0),
        0
      )
      return '이미지 목록 ' + total + '장 읽음'
    }
    case 'canvas_export': {
      const nodes = isObj(result.summary) ? num(result.summary.nodes) : null
      return join(label(tool), nodes === null ? null : '노드 ' + nodes + '개')
    }
    case 'work_plan':
      return join('저장 계획', changeCount(result))
    case 'edition_plan':
      return join(lang ? lang + ' 판본 계획' : label(tool), changeCount(result))
    case 'images_plan':
      return join('이미지 계획', imageDetail(args) ?? changeCount(result))
    case 'cover_plan': {
      const n = len(result.uploads)
      return join('표지 계획', n === null ? null : n + '곳')
    }
    case 'work_delete_plan':
      return '삭제 계획'
    case 'canvas_plan': {
      if (result.plan_id === null) {
        const n = len(result.problems)
        return join('캔버스 계획', '규격 문제' + (n === null ? '' : ' ' + n + '개'))
      }
      const n = isObj(result.changes) ? num(result.changes.different_places) : null
      return join('캔버스 계획', n === null ? null : n + '곳 다름')
    }
    case 'work_save': {
      const miss = verified === false ? len(result.mismatches) : null
      return '저장' + checked(verified) + (miss ? ' (' + miss + '곳 다름)' : '')
    }
    case 'edition_save':
      return (lang ? lang + ' 판본 저장' : label(tool)) + checked(verified)
    case 'images_apply':
      return (plan?.detail ? '이미지 ' + plan.detail : label(tool)) + checked(verified)
    case 'cover_apply': {
      const n = num(result.uploaded)
      return '표지 바꿈' + (n === null ? '' : ' · ' + n + '곳') + checked(verified)
    }
    case 'canvas_apply':
      if (result.imported === false) return '캔버스 가져오기 실패'
      return label(tool) + checked(verified)
    case 'work_create':
      return '새 작품 만듦'
    case 'work_delete':
      return '작품 삭제' + checked(verified)
    default:
      return label(tool)
  }
}

export interface ActivityLog {
  /** 도구 호출 하나를 기록한다. 절대 던지지 않는다 */
  record(tool: string, args: Obj, result: unknown, error: unknown): McpActivity | null
  /** 최근 것부터 */
  list(limit?: number): Promise<McpActivity[]>
  /** 밀린 파일 쓰기가 끝날 때까지 (테스트용) */
  flush(): Promise<void>
}

export const ACTIVITY_KEEP = 500
export const ACTIVITY_REWRITE_AT = 600

export function createActivityLog(options: {
  file: string
  onAdd?: (activity: McpActivity) => void
  keep?: number
  rewriteAt?: number
  now?: () => Date
}): ActivityLog {
  const keep = options.keep ?? ACTIVITY_KEEP
  const rewriteAt = Math.max(keep, options.rewriteAt ?? ACTIVITY_REWRITE_AT)
  const items: McpActivity[] = [] // 화면용, 오래된 것부터
  let persisted: McpActivity[] = [] // 파일에 쓴 줄들 (쓰기 순서 안에서만 바뀐다)
  const plans = new Map<string, PlanNote>()
  const titles = new Map<string, string>()
  let chain: Promise<void> = Promise.resolve()
  const queue = (job: () => Promise<void>): Promise<void> =>
    (chain = chain.then(job).catch(() => undefined))

  // 처음 한 번 파일을 읽는다. 깨진 줄이 있거나 끝이 줄바꿈이 아니면 깨끗하게 다시 쓴다
  const ready = queue(async () => {
    let text = ''
    try {
      text = await readFile(options.file, 'utf8')
    } catch {
      return
    }
    const loaded: McpActivity[] = []
    let broken = text.length > 0 && !text.endsWith('\n')
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        const parsed = JSON.parse(line) as McpActivity
        if (isObj(parsed) && typeof parsed.id === 'string' && typeof parsed.tool === 'string')
          loaded.push(parsed)
        else broken = true
      } catch {
        broken = true
      }
    }
    // 읽기 전에 기록된 것이 있으면 그 앞에 붙인다
    items.unshift(...loaded.slice(-keep))
    if (items.length > keep) items.splice(0, items.length - keep)
    persisted = loaded
    if (broken || persisted.length > rewriteAt) await rewrite()
  })

  async function rewrite(): Promise<void> {
    persisted = persisted.slice(-keep)
    await mkdir(dirname(options.file), { recursive: true })
    await writeFile(options.file, persisted.map((a) => JSON.stringify(a) + '\n').join(''))
  }

  function build(tool: string, args: Obj, result: unknown, error: unknown): McpActivity {
    const res = isObj(result) ? result : {}
    const planId = ident(args.plan_id, 40)
    const plan = planId ? (plans.get(planId) ?? null) : null
    if (planId && plan && error === undefined) plans.delete(planId)

    let site = ident(args.site, 40) ?? ident(res.site, 40) ?? plan?.site ?? null
    if (site)
      try {
        site = workAdapter(site).id
      } catch {
        // 모르는 사이트 이름은 받은 그대로 둔다
      }
    const workId =
      ident(args.work_id) ??
      ident(res.work_id) ??
      plan?.workId ??
      (tool.startsWith('work_') ? ident(res.id) : null) ??
      null
    const key = site && workId ? site + ':' + workId : null
    const ownTitle = typeof res.title === 'string' ? clip(res.title.trim(), 100) : null
    const workTitle = ownTitle || plan?.title || (key ? (titles.get(key) ?? null) : null)
    if (key && ownTitle) {
      titles.delete(key)
      titles.set(key, ownTitle)
      if (titles.size > 200) titles.delete(titles.keys().next().value as string)
    }

    const thrown = error !== undefined
    const failed = thrown || res.ok === false || (tool === 'canvas_apply' && res.imported === false)
    const verified = !thrown && typeof res.verified === 'boolean' ? res.verified : null
    let errorText: string | null = null
    if (thrown) errorText = clip(toolMessage(error), 200)
    else if (failed) {
      const code = ident(res.error, 400) ?? ident(res.message, 400)
      errorText = code ? clip(code, 200) : '실패'
    }
    const summary = clip(
      thrown ? label(tool) + ' 실패' : describe(tool, args, res, verified, plan),
      60
    )

    // 계획 결과를 적용 도구가 이어 쓰도록 남긴다
    const newPlan = !thrown ? ident(res.plan_id, 40) : null
    if (newPlan) {
      plans.set(newPlan, {
        site,
        workId,
        title: workTitle,
        detail: tool === 'images_plan' ? imageDetail(args) : null
      })
      if (plans.size > 200) plans.delete(plans.keys().next().value as string)
    }

    return {
      id: randomBytes(6).toString('hex'),
      at: (options.now?.() ?? new Date()).toISOString(),
      tool: clip(tool, 60),
      kind: activityKind(tool),
      site,
      workId,
      workTitle: workTitle || null,
      ok: !failed,
      verified,
      summary,
      error: errorText
    }
  }

  return {
    record(tool, args, result, error) {
      let activity: McpActivity
      try {
        activity = build(tool, isObj(args) ? args : {}, result, error)
      } catch {
        return null
      }
      items.push(activity)
      if (items.length > keep) items.splice(0, items.length - keep)
      void queue(async () => {
        await mkdir(dirname(options.file), { recursive: true })
        persisted.push(activity)
        if (persisted.length > rewriteAt) await rewrite()
        else await appendFile(options.file, JSON.stringify(activity) + '\n')
      })
      try {
        options.onAdd?.(activity)
      } catch {
        // 알림 실패는 도구 호출과 무관하다
      }
      return activity
    },
    async list(limit) {
      await ready
      const n = Math.max(1, Math.min(keep, Math.floor(Number(limit) || 100)))
      return items.slice(-n).reverse()
    },
    flush() {
      return chain
    }
  }
}

/** 도구 표를 감싸 호출마다 기록한다. 결과·오류는 그대로 돌려준다 */
export function withActivity(tools: ToolDef[], log: ActivityLog): ToolDef[] {
  return tools.map((tool) => ({
    ...tool,
    async run(args) {
      let result: unknown
      try {
        result = await tool.run(args)
      } catch (error) {
        log.record(tool.name, args, undefined, error ?? new Error('UNKNOWN'))
        throw error
      }
      log.record(tool.name, args, result, undefined)
      return result
    }
  }))
}
