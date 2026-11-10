// 작품 저장 도구. 순서는 항상 "계획(work_plan) → 확인 → 저장(work_save)"이다.
//  - work_plan은 플랫폼에 아무것도 쓰지 않는다. 지금 값과 바꿀 값을 견줘 무엇이 달라지는지만 돌려준다.
//  - work_save는 계획 번호가 있어야 하고, 계획을 세운 뒤 플랫폼 내용이 바뀌었으면 저장하지 않는다.
//  - 저장 직전 원본을 스냅샷으로 남기고, 저장 뒤 다시 읽어 뜻대로 들어갔는지 견준다.
import { randomBytes } from 'node:crypto'
import { workAdapter } from './adapters'
import type { ToolDef, WorkToolDeps } from './tools'
import { textLength, type LoreEntry, type WorkBody, type WorkChanges } from './types'

const PLAN_TTL = 30 * 60_000
const FILE_MAX = 1_000_000

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

export interface DiffItem {
  where: string
  kind: 'changed' | 'added' | 'removed'
  before_length?: number
  after_length?: number
  /** 처음 달라지는 곳 앞뒤 */
  preview?: { before: string; after: string }
}

function preview(a: string, b: string): { before: string; after: string } {
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  const from = Math.max(0, i - 20)
  return { before: a.slice(from, i + 40), after: b.slice(from, i + 40) }
}
function textDiff(where: string, a: string, b: string): DiffItem[] {
  return a === b
    ? []
    : [
        {
          where,
          kind: 'changed',
          before_length: textLength(a),
          after_length: textLength(b),
          preview: preview(a, b)
        }
      ]
}

/** 공통 모양 두 편을 견줘 달라진 곳을 돌려준다 (수정 시각·이미지 수는 보지 않는다) */
export function diffBodies(before: WorkBody, after: WorkBody): DiffItem[] {
  const out: DiffItem[] = []
  for (const name of new Set([...Object.keys(before.fields), ...Object.keys(after.fields)]))
    out.push(...textDiff(name, before.fields[name] ?? '', after.fields[name] ?? ''))
  if (before.visibility !== after.visibility || before.status !== after.status)
    out.push({ where: 'visibility/status', kind: 'changed' })

  const lore = Math.max(before.lorebook.length, after.lorebook.length)
  for (let i = 0; i < lore; i++) {
    const a = before.lorebook[i]
    const b = after.lorebook[i]
    const where = 'lorebook[' + i + '] ' + (b ?? a).title
    if (!a) out.push({ where, kind: 'added', after_length: textLength(b.content) })
    else if (!b) out.push({ where, kind: 'removed', before_length: textLength(a.content) })
    else {
      out.push(...textDiff(where + ' · content', a.content, b.content))
      out.push(...textDiff(where + ' · title', a.title, b.title))
      out.push(...textDiff(where + ' · keys', a.keys, b.keys))
      const rest = (e: LoreEntry): string =>
        JSON.stringify([e.mode, e.offKeys, e.turnRange, e.offTurnRange])
      if (rest(a) !== rest(b)) out.push({ where: where + ' · 발동 조건', kind: 'changed' })
    }
  }

  const starts = Math.max(before.startScenarios.length, after.startScenarios.length)
  for (let i = 0; i < starts; i++) {
    const a = before.startScenarios[i]
    const b = after.startScenarios[i]
    const where = 'start_scenarios[' + i + '] ' + (b ?? a).title
    if (!a || !b) out.push({ where, kind: a ? 'removed' : 'added' })
    else
      for (const key of [
        'title',
        'content',
        'subPrompt',
        'dialogue',
        'situation',
        'description'
      ] as const)
        out.push(...textDiff(where + ' · ' + key, a[key], b[key]))
  }

  const chars = Math.max(before.characters.length, after.characters.length)
  for (let i = 0; i < chars; i++) {
    const a = before.characters[i]
    const b = after.characters[i]
    const where = 'characters[' + i + '] ' + (b ?? a).name
    if (!a || !b) out.push({ where, kind: a ? 'removed' : 'added' })
    else {
      for (const key of ['name', 'details', 'info'] as const)
        out.push(...textDiff(where + ' · ' + key, a[key], b[key]))
      if (a.id !== b.id || a.isMain !== b.isMain || a.imageCount !== b.imageCount)
        out.push({ where: where + ' · 번호·주연·이미지', kind: 'changed' })
    }
  }
  return out
}

// ───────────── 도구 입력 → 바꿀 내용 ─────────────

function loreEntry(v: unknown, partial: boolean): Partial<LoreEntry> {
  if (!isObj(v)) throw new Error('BAD_CHANGES')
  const out: Partial<LoreEntry> = {}
  if (typeof v.title === 'string') out.title = v.title
  if (typeof v.keys === 'string') out.keys = v.keys
  if (typeof v.content === 'string') out.content = v.content
  if (typeof v.mode === 'string') out.mode = v.mode
  if (Array.isArray(v.off_keys)) out.offKeys = v.off_keys.filter((k) => typeof k === 'string')
  if (typeof v.turn_range === 'number') out.turnRange = v.turn_range
  if (typeof v.off_turn_range === 'number') out.offTurnRange = v.off_turn_range
  if (!partial && (out.content === undefined || out.title === undefined))
    throw new Error('BAD_CHANGES')
  return out
}
function patches<T>(v: unknown, read: (item: Obj) => T): ({ index: number } & T)[] {
  if (!Array.isArray(v)) throw new Error('BAD_CHANGES')
  return v.map((item) => {
    if (!isObj(item) || !Number.isInteger(item.index)) throw new Error('BAD_INDEX')
    return { index: item.index as number, ...read(item) }
  })
}
const optional = (item: Obj, names: [string, string][]): Obj => {
  const out: Obj = {}
  for (const [from, to] of names) if (typeof item[from] === 'string') out[to] = item[from]
  return out
}

async function readText(path: string, deps: WorkToolDeps, kinds: RegExp): Promise<string> {
  if (!kinds.test(path)) throw new Error('BAD_FILE')
  let text: string
  try {
    text = await deps.readFile(path)
  } catch {
    throw new Error('BAD_FILE')
  }
  if (text.length > FILE_MAX) throw new Error('BAD_FILE')
  // 윈도우 줄바꿈과 BOM은 플랫폼 본문에 넣지 않는다
  return (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text).replace(/\r\n/g, '\n')
}

export async function parseChanges(args: Obj, deps: WorkToolDeps): Promise<WorkChanges> {
  const changes: WorkChanges = {}
  const fields: Record<string, string> = {}
  if (args.fields !== undefined) {
    if (!isObj(args.fields)) throw new Error('BAD_CHANGES')
    for (const [name, value] of Object.entries(args.fields)) {
      if (typeof value !== 'string') throw new Error('BAD_FIELD')
      fields[name] = value
    }
  }
  if (args.field_files !== undefined) {
    if (!isObj(args.field_files)) throw new Error('BAD_CHANGES')
    for (const [name, path] of Object.entries(args.field_files)) {
      if (name in fields) throw new Error('BAD_CHANGES')
      fields[name] = await readText(str(path), deps, /\.(md|txt)$/i)
    }
  }
  if (Object.keys(fields).length) changes.fields = fields

  let lorebook = args.lorebook
  if (args.lorebook_file !== undefined) {
    if (lorebook !== undefined) throw new Error('BAD_CHANGES')
    try {
      lorebook = JSON.parse(await readText(str(args.lorebook_file), deps, /\.json$/i))
    } catch (error) {
      throw error instanceof Error && error.message === 'BAD_FILE' ? error : new Error('BAD_FILE')
    }
  }
  const whole = (v: unknown): LoreEntry[] => {
    if (!Array.isArray(v)) throw new Error('BAD_CHANGES')
    return v.map((e) => ({
      title: '',
      keys: '',
      content: '',
      mode: 'keyword',
      offKeys: [],
      turnRange: 5,
      offTurnRange: 5,
      ...loreEntry(e, false)
    }))
  }
  if (lorebook !== undefined) changes.lorebook = whole(lorebook)
  if (args.lorebook_patch !== undefined) {
    if (changes.lorebook) throw new Error('BAD_CHANGES')
    changes.lorebookPatch = patches(args.lorebook_patch, (item) => loreEntry(item, true))
  }
  if (args.lorebook_remove !== undefined) {
    const gone = args.lorebook_remove
    if (changes.lorebook || !Array.isArray(gone)) throw new Error('BAD_CHANGES')
    if (gone.some((i) => !Number.isInteger(i)) || new Set(gone).size !== gone.length)
      throw new Error('BAD_INDEX')
    changes.lorebookRemove = gone as number[]
  }
  if (args.lorebook_add !== undefined) {
    if (changes.lorebook) throw new Error('BAD_CHANGES')
    changes.lorebookAdd = whole(args.lorebook_add)
  }
  if (args.start_scenarios !== undefined)
    changes.startScenarios = patches(args.start_scenarios, (item) =>
      optional(item, [
        ['title', 'title'],
        ['content', 'content'],
        ['sub_prompt', 'subPrompt'],
        ['dialogue', 'dialogue'],
        ['situation', 'situation'],
        ['description', 'description']
      ])
    )
  if (args.characters !== undefined)
    changes.characters = patches(args.characters, (item) =>
      optional(item, [
        ['name', 'name'],
        ['details', 'details'],
        ['info', 'info']
      ])
    )
  if (!Object.keys(changes).length) throw new Error('NO_CHANGES')
  return changes
}

// ───────────── 도구 ─────────────

interface Plan {
  site: string
  workId: string
  changes: WorkChanges
  /** 계획을 세울 때의 플랫폼 내용. 저장할 때 그대로인지 견준다 */
  base: string
  expires: number
}

const site = { type: 'string', description: '플랫폼 이름 (sites_list의 site)' }
const workId = { type: 'string', description: '작품 번호 (works_list의 id)' }
const lorebookItem = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    keys: { type: 'string', description: '키워드를 쉼표로 이은 글' },
    content: { type: 'string' },
    mode: { type: 'string', description: 'keyword 또는 always' },
    off_keys: { type: 'array', items: { type: 'string' } },
    turn_range: { type: 'number' },
    off_turn_range: { type: 'number' }
  }
}
const withIndex = (properties: Obj): Obj => ({
  type: 'object',
  properties: { index: { type: 'integer', description: 'work_read의 index' }, ...properties },
  required: ['index']
})
const text = { type: 'string' }

export function createSaveTools(deps: WorkToolDeps, forget: (key: string) => void): ToolDef[] {
  const plans = new Map<string, Plan>()
  const frozen = (body: WorkBody): string => JSON.stringify({ ...body, updatedAt: null })

  return [
    {
      name: 'work_plan',
      description:
        '작품을 고치기 전에 무엇이 달라지는지 미리 본다. 플랫폼에는 아무것도 쓰지 않는다. ' +
        '적지 않은 칸은 지금 값 그대로 둔다. 결과의 changes를 사용자에게 보여 주고, 사용자가 ' +
        '저장하라고 한 뒤에만 plan_id로 work_save를 부른다. 긴 본문은 fields 대신 field_files에 ' +
        '로컬 파일 경로(.md / .txt)를 주면 그 파일 내용을 쓴다.',
      inputSchema: {
        type: 'object',
        properties: {
          site,
          work_id: workId,
          fields: {
            type: 'object',
            description:
              '통째로 바꿀 글 칸. title / subtitle / description / main / creator_comment',
            additionalProperties: text
          },
          field_files: {
            type: 'object',
            description: '글 칸 이름 → 그 칸에 넣을 로컬 파일 경로 (.md / .txt, UTF-8)',
            additionalProperties: text
          },
          lorebook: {
            type: 'array',
            items: lorebookItem,
            description: '로어북 전체를 이 목록으로 바꾼다'
          },
          lorebook_file: {
            type: 'string',
            description: '로어북 전체가 담긴 로컬 JSON 파일 경로 (lorebook과 같은 모양의 배열)'
          },
          lorebook_patch: {
            type: 'array',
            items: withIndex(lorebookItem.properties),
            description: '로어북 일부 항목만 고친다'
          },
          lorebook_remove: {
            type: 'array',
            items: { type: 'integer' },
            description: '지울 로어북 항목 번호들 (work_read의 index, 고치기 전 번호)'
          },
          lorebook_add: {
            type: 'array',
            items: lorebookItem,
            description: '로어북 끝에 더할 새 항목들 (title·keys·content)'
          },
          start_scenarios: {
            type: 'array',
            items: withIndex({
              title: text,
              content: text,
              sub_prompt: text,
              dialogue: text,
              situation: text,
              description: text
            }),
            description: '시작 상황 일부만 고친다'
          },
          characters: {
            type: 'array',
            items: withIndex({ name: text, details: text, info: text }),
            description: '캐릭터 일부만 고친다'
          }
        },
        required: ['site', 'work_id']
      },
      async run(args) {
        const adapter = workAdapter(str(args.site))
        if (!adapter.applyChanges || !adapter.save) throw new Error('NO_SAVE')
        const id = str(args.work_id).toLowerCase()
        const changes = await parseChanges(args, deps)
        const raw = await adapter.readRaw(deps.reader(adapter.id), id)
        const before = adapter.normalize(raw)
        const after = adapter.normalize(adapter.applyChanges(raw, changes))
        const diff = diffBodies(before, after)
        const head = {
          id: before.id,
          title: before.title,
          visibility: before.visibility,
          status: before.status
        }
        if (!diff.length) return { ...head, changes: [], nothing_to_save: true }

        const now = Date.now()
        for (const [key, plan] of plans) if (plan.expires < now) plans.delete(key)
        const planId = randomBytes(4).toString('hex')
        plans.set(planId, {
          site: adapter.id,
          workId: id,
          changes,
          base: frozen(before),
          expires: now + PLAN_TTL
        })
        return {
          ...head,
          plan_id: planId,
          changes: diff,
          note: '아직 저장하지 않았어요. 사용자가 확인한 뒤 work_save를 불러 주세요. 공개 상태는 바뀌지 않아요.'
        }
      }
    },
    {
      name: 'work_save',
      description:
        'work_plan으로 세운 계획을 플랫폼에 저장한다. 사용자가 그 계획의 변경 내용을 보고 저장하라고 ' +
        '한 뒤에만 부른다. 계획을 세운 뒤 플랫폼 내용이 바뀌었으면 저장하지 않는다. 저장 직전 원본을 ' +
        'backup 경로에 남기고, 저장 뒤 다시 읽어 견준 결과를 verified로 돌려준다.',
      inputSchema: {
        type: 'object',
        properties: {
          plan_id: { type: 'string', description: 'work_plan이 돌려준 plan_id' }
        },
        required: ['plan_id']
      },
      async run(args) {
        const planId = str(args.plan_id)
        const plan = plans.get(planId)
        if (!plan || plan.expires < Date.now()) {
          plans.delete(planId)
          throw new Error('PLAN_NOT_FOUND')
        }
        const adapter = workAdapter(plan.site)
        if (!adapter.applyChanges || !adapter.save) throw new Error('NO_SAVE')
        const read = deps.reader(adapter.id)

        const raw = await adapter.readRaw(read, plan.workId)
        const before = adapter.normalize(raw)
        if (frozen(before) !== plan.base) {
          plans.delete(planId)
          throw new Error('PLAN_STALE')
        }
        const backup = await deps.snapshot(adapter.id, plan.workId, raw)
        const next = adapter.applyChanges(raw, plan.changes)
        const expected = adapter.normalize(next)

        plans.delete(planId)
        forget(adapter.id + ':' + plan.workId)
        await adapter.save(deps.writer(adapter.id), plan.workId, next)

        const afterRaw = await adapter.readRaw(read, plan.workId)
        const after = adapter.normalize(afterRaw)
        await deps.snapshot(adapter.id, plan.workId, afterRaw)
        const mismatches = diffBodies(expected, after)
        return {
          saved: true,
          verified: mismatches.length === 0,
          mismatches,
          id: after.id,
          title: after.title,
          visibility: after.visibility,
          status: after.status,
          updated_at: after.updatedAt,
          backup
        }
      }
    }
  ]
}
