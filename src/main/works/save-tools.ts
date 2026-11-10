// 작품 저장 도구. 순서는 항상 "계획(work_plan) → 확인 → 저장(work_save)"이다.
//  - work_plan은 플랫폼에 아무것도 쓰지 않는다. 지금 값과 바꿀 값을 견줘 무엇이 달라지는지만 돌려준다.
//  - work_save는 계획 번호가 있어야 하고, 계획을 세운 뒤 플랫폼 내용이 바뀌었으면 저장하지 않는다.
//  - 저장 직전 원본을 스냅샷으로 남기고, 저장 뒤 다시 읽어 뜻대로 들어갔는지 견준다.
import { randomBytes } from 'node:crypto'
import { workAdapter, workKey } from './adapters'
import { loadImage } from './media-tools'
import type { ToolDef, WorkToolDeps } from './tools'
import {
  textLength,
  type LoreEntry,
  type WorkBody,
  type WorkChanges,
  type WorkDraft,
  type WorkIo
} from './types'

export const PLAN_TTL = 30 * 60_000
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
    out.push({
      where: '공개 상태',
      kind: 'changed',
      preview: {
        before: [before.visibility, before.status].filter(Boolean).join('/'),
        after: [after.visibility, after.status].filter(Boolean).join('/')
      }
    })

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
  if (args.visibility !== undefined) {
    if (typeof args.visibility !== 'string') throw new Error('BAD_VISIBILITY')
    changes.visibility = args.visibility
  }
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
      // html은 소개 칸, jsx·tsx·js는 JSX 컴포넌트 칸(우마이 `jsx:{파일 이름}`)용
      fields[name] = await readText(str(path), deps, /\.(md|txt|html|jsx|tsx|js)$/i)
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
      // 발동 방식·턴 값을 주지 않으면 비워 두고 연결부가 그 플랫폼 기본값을 넣는다
      // (에덴 keyword·5·5, 엘린 on_match·3, 이 칸이 없는 플랫폼은 그대로 통과)
      mode: null,
      offKeys: [],
      turnRange: null,
      offTurnRange: null,
      ...loreEntry(e, false)
    }))
  }
  if (lorebook !== undefined) changes.lorebook = whole(lorebook)
  if (args.lorebook_patch !== undefined) {
    if (changes.lorebook) throw new Error('BAD_CHANGES')
    changes.lorebookPatch = patches(args.lorebook_patch, (item) => loreEntry(item, true))
  }
  const removal = (v: unknown): number[] => {
    if (!Array.isArray(v)) throw new Error('BAD_CHANGES')
    if (v.some((i) => !Number.isInteger(i)) || new Set(v).size !== v.length)
      throw new Error('BAD_INDEX')
    return v as number[]
  }
  if (args.lorebook_remove !== undefined) {
    if (changes.lorebook) throw new Error('BAD_CHANGES')
    changes.lorebookRemove = removal(args.lorebook_remove)
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
  const START: [string, string][] = [
    ['title', 'title'],
    ['content', 'content'],
    ['sub_prompt', 'subPrompt'],
    ['dialogue', 'dialogue'],
    ['situation', 'situation'],
    ['description', 'description']
  ]
  const objects = (v: unknown): Obj[] => {
    if (!Array.isArray(v) || !v.every(isObj)) throw new Error('BAD_CHANGES')
    return v
  }
  if (args.start_scenarios_remove !== undefined)
    changes.startScenariosRemove = removal(args.start_scenarios_remove)
  if (args.start_scenarios_add !== undefined)
    changes.startScenariosAdd = objects(args.start_scenarios_add).map((item) =>
      optional(item, START)
    )
  if (args.characters_remove !== undefined)
    changes.charactersRemove = removal(args.characters_remove)
  if (args.characters_add !== undefined)
    changes.charactersAdd = objects(args.characters_add).map((item) => {
      if (typeof item.name !== 'string' || !item.name.trim()) throw new Error('EMPTY_FIELD')
      return {
        name: item.name,
        ...(typeof item.details === 'string' ? { details: item.details } : {}),
        ...(typeof item.info === 'string' ? { info: item.info } : {})
      }
    })
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

/** work_plan·edition_plan이 같이 쓰는 "바꿀 내용" 입력 모양 */
export const CHANGE_PROPERTIES = {
  visibility: {
    type: 'string',
    description:
      '공개 상태 바꾸기. 플랫폼마다 받는 값이 다르다 (sites_list의 visibilities). ' +
      '공개로 바꾸면 독자에게 바로 보이므로 사용자가 분명히 요청했을 때만 쓴다. ' +
      '우마이는 평소 저장이 임시저장(초안)이고, visibility를 주면 그 초안까지 발행한다. ' +
      '챗플은 공개(public)로 저장하면 수정본이 다시 심사를 받는다.'
  },
  fields: {
    type: 'object',
    description:
      '통째로 바꿀 글 칸. title / subtitle / description / main / creator_comment ' +
      '(플랫폼 전용 칸: 네코챗 persistent_context, 우마이 play_guide — work_read의 field_lengths 참고). ' +
      '우마이 JSX 컴포넌트 파일은 칸 이름 jsx:{파일 이름}에 소스 코드를 준다(저장할 때 컴파일된다. 빈 값이면 그 파일을 뺀다)',
    additionalProperties: text
  },
  field_files: {
    type: 'object',
    description:
      '글 칸 이름 → 그 칸에 넣을 로컬 파일 경로 (.md / .txt / .html, UTF-8. 우마이 jsx:{파일 이름} 칸은 .jsx / .tsx / .js)',
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
  },
  start_scenarios_remove: {
    type: 'array',
    items: { type: 'integer' },
    description: '지울 시작 상황 번호들 (고치기 전 번호. 기본 시작 상황은 지울 수 없다)'
  },
  start_scenarios_add: {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        title: text,
        content: text,
        sub_prompt: text,
        dialogue: text,
        situation: text,
        description: text
      }
    },
    description: '끝에 더할 새 시작 상황들'
  },
  characters_remove: {
    type: 'array',
    items: { type: 'integer' },
    description:
      '지울 캐릭터 번호들 (고치기 전 번호. 주연은 지울 수 없다). 그 캐릭터의 이미지도 함께 사라진다'
  },
  characters_add: {
    type: 'array',
    items: {
      type: 'object',
      properties: { name: text, details: text, info: text },
      required: ['name']
    },
    description: '끝에 더할 새 캐릭터들 (이미지는 따로 올린다)'
  }
}

// 저장·삭제·만들기에 JSON이 아닌 요청(파일 묶음, CSRF 헤더 등)이 필요한 플랫폼용 통로 묶음.
// 파일 통로는 실제로 쓸 때 연다 (JSON 통로만 쓰는 플랫폼은 건드리지 않는다).
const workIo = (deps: WorkToolDeps, platform: string): WorkIo => ({
  read: deps.reader(platform),
  write: deps.writer(platform),
  send: (request) => deps.sender(platform)(request)
})

export function createSaveTools(deps: WorkToolDeps, forget: (key: string) => void): ToolDef[] {
  const plans = new Map<string, Plan>()
  const deletions = new Map<
    string,
    { site: string; workId: string; title: string; expires: number }
  >()
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
        properties: { site, work_id: workId, ...CHANGE_PROPERTIES },
        required: ['site', 'work_id']
      },
      async run(args) {
        const adapter = workAdapter(str(args.site))
        if (!adapter.applyChanges || !adapter.save) throw new Error('NO_SAVE')
        const id = workKey(adapter, str(args.work_id))
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
        await adapter.save(deps.writer(adapter.id), plan.workId, next, workIo(deps, adapter.id))

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
    },
    {
      name: 'work_delete_plan',
      description:
        '작품을 통째로 지우기 전 확인 단계. 아무것도 지우지 않고, 지워질 작품의 제목·공개 상태·분량과 ' +
        'plan_id를 돌려준다. 삭제는 되돌릴 수 없다. 결과를 사용자에게 보여 주고, 사용자가 그 작품을 ' +
        '지우라고 분명히 말한 뒤에만 work_delete를 부른다.',
      inputSchema: {
        type: 'object',
        properties: { site, work_id: workId },
        required: ['site', 'work_id']
      },
      async run(args) {
        const adapter = workAdapter(str(args.site))
        if (!adapter.remove) throw new Error('NO_DELETE')
        const id = workKey(adapter, str(args.work_id))
        const body = adapter.normalize(await adapter.readRaw(deps.reader(adapter.id), id))
        const now = Date.now()
        for (const [key, plan] of deletions) if (plan.expires < now) deletions.delete(key)
        const planId = randomBytes(4).toString('hex')
        deletions.set(planId, {
          site: adapter.id,
          workId: id,
          title: body.title,
          expires: now + PLAN_TTL
        })
        return {
          plan_id: planId,
          id: body.id,
          title: body.title,
          visibility: body.visibility,
          status: body.status,
          main_length: textLength(body.fields.main ?? ''),
          lorebook_count: body.lorebook.length,
          start_scenario_count: body.startScenarios.length,
          character_count: body.characters.length,
          note: '아직 지우지 않았어요. 지우면 되돌릴 수 없어요. 사용자가 확인한 뒤 work_delete에 plan_id와 작품 제목을 그대로 넣어 불러 주세요.'
        }
      }
    },
    {
      name: 'work_delete',
      description:
        'work_delete_plan으로 확인한 작품을 통째로 지운다. 되돌릴 수 없다. plan_id와 함께 그 작품의 ' +
        '제목을 글자 그대로 넣어야 한다. 지우기 직전 원본을 backup 경로에 남긴다.',
      inputSchema: {
        type: 'object',
        properties: {
          plan_id: { type: 'string', description: 'work_delete_plan이 돌려준 plan_id' },
          title: { type: 'string', description: '지울 작품의 제목 (글자 그대로)' }
        },
        required: ['plan_id', 'title']
      },
      async run(args) {
        const planId = str(args.plan_id)
        const plan = deletions.get(planId)
        if (!plan || plan.expires < Date.now()) {
          deletions.delete(planId)
          throw new Error('PLAN_NOT_FOUND')
        }
        const adapter = workAdapter(plan.site)
        if (!adapter.remove) throw new Error('NO_DELETE')
        const read = deps.reader(adapter.id)
        const raw = await adapter.readRaw(read, plan.workId)
        const body = adapter.normalize(raw)
        // 계획 때와 같은 작품인지, 사용자가 말한 제목과 같은지 둘 다 본다
        if (body.title !== plan.title || str(args.title) !== plan.title)
          throw new Error('TITLE_MISMATCH')
        const backup = await deps.snapshot(adapter.id, plan.workId, raw)
        deletions.delete(planId)
        forget(adapter.id + ':' + plan.workId)
        await adapter.remove(deps.writer(adapter.id), plan.workId, workIo(deps, adapter.id))
        // 지워졌으면 다시 읽을 수 없어야 한다
        let gone = await adapter.readRaw(read, plan.workId).then(
          () => false,
          (error: unknown) => error instanceof Error && /WORK_NOT_FOUND/.test(error.message)
        )
        // 지운 작품을 번호로 읽으면 "없음" 말고 다른 답을 주는 플랫폼이 있다(베이비챗).
        // 그럴 때는 내 작품 목록에서 사라졌는지로 확인한다.
        if (!gone)
          gone = await adapter.list(read).then(
            (works) => !works.some((w) => workKey(adapter, w.id) === plan.workId),
            () => false
          )
        return { deleted: true, verified: gone, id: plan.workId, title: plan.title, backup }
      }
    },
    {
      name: 'work_create',
      description:
        '새 작품을 만든다. 만들어지는 작품은 항상 비공개이고, 공개하려면 만든 뒤 work_plan의 ' +
        'visibility로 바꾼다. 긴 본문은 main 대신 main_file에 로컬 파일 경로(.md / .txt)를 준다. ' +
        '에덴: characters가 필요하고(첫 번째가 주연) 표지·이미지는 만든 뒤 cover_plan / images_plan으로 올린다. ' +
        '베이비챗: 대표 이미지가 있어야 만들 수 있어 cover_file이 필수다(이 도구가 먼저 올린다). characters는 주지 않고, ' +
        'description·hashtags(1~10개)·start_scenarios(첫 번째의 title·content·dialogue 필수)와 ' +
        'options {category: 숫자, target_gender: male|female|all, recommended_model: 글}이 필요하다. ' +
        'category·recommended_model 값은 같은 계정의 기존 작품 스냅샷(work_read의 snapshot 파일 edit.category / ' +
        'edit.recommendedModel)에서 가져온다.',
      inputSchema: {
        type: 'object',
        properties: {
          site,
          title: text,
          main: { type: 'string', description: '메인 프롬프트' },
          main_file: { type: 'string', description: '메인 프롬프트가 담긴 로컬 파일 경로' },
          adult: { type: 'boolean', description: '성인 작품 여부' },
          subtitle: text,
          description: text,
          categories: { type: 'array', items: text },
          hashtags: { type: 'array', items: text },
          cover_file: {
            type: 'string',
            description:
              '대표 이미지 로컬 파일 경로 (베이비챗 필수. webp / png / jpg / gif, 5MB 이하)'
          },
          options: {
            type: 'object',
            description:
              '플랫폼별 값. 베이비챗: category(숫자) · target_gender · recommended_model · system_prompt(선택)'
          },
          characters: {
            type: 'array',
            items: {
              type: 'object',
              properties: { name: text, details: text, info: text },
              required: ['name']
            },
            description: '캐릭터들. 첫 번째가 주연'
          },
          lorebook: { type: 'array', items: lorebookItem },
          lorebook_file: {
            type: 'string',
            description: '로어북이 담긴 로컬 JSON 파일 경로 (lorebook과 같은 모양의 배열)'
          },
          start_scenarios_file: {
            type: 'string',
            description:
              '시작 상황들이 담긴 로컬 JSON 파일 경로 (start_scenarios와 같은 모양의 배열)'
          },
          start_scenarios: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                title: text,
                content: text,
                sub_prompt: text,
                dialogue: text,
                situation: text,
                description: text
              }
            },
            description: '시작 상황들. 첫 번째가 기본'
          }
        },
        required: ['site', 'title', 'adult']
      },
      async run(args) {
        const adapter = workAdapter(str(args.site))
        if (!adapter.create) throw new Error('NO_CREATE')
        if (typeof args.adult !== 'boolean') throw new Error('BAD_CHANGES')
        if (args.main !== undefined && args.main_file !== undefined) throw new Error('BAD_CHANGES')
        const main =
          args.main_file !== undefined
            ? await readText(str(args.main_file), deps, /\.(md|txt)$/i)
            : str(args.main)
        // 바꾸기 도구와 같은 읽기 규칙으로 로어북·시작 상황·캐릭터를 받는다
        // 긴 로어북·시작 상황은 로컬 JSON 파일(같은 모양의 배열)로 받을 수 있다
        const fromFile = async (inline: unknown, file: unknown): Promise<unknown> => {
          if (file === undefined) return inline
          if (inline !== undefined) throw new Error('BAD_CHANGES')
          try {
            return JSON.parse(await readText(str(file), deps, /.json$/i))
          } catch (error) {
            throw error instanceof Error && error.message === 'BAD_FILE'
              ? error
              : new Error('BAD_FILE')
          }
        }
        const lorebook = await fromFile(args.lorebook, args.lorebook_file)
        const starts = await fromFile(args.start_scenarios, args.start_scenarios_file)
        const given = {
          ...(lorebook !== undefined ? { lorebook_add: lorebook } : {}),
          ...(starts !== undefined ? { start_scenarios_add: starts } : {}),
          ...(args.characters !== undefined ? { characters_add: args.characters } : {})
        }
        const parts = Object.keys(given).length ? await parseChanges(given, deps) : {}
        if (args.options !== undefined && !isObj(args.options)) throw new Error('BAD_CHANGES')
        const strings = (v: unknown): string[] | undefined =>
          Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : undefined
        const draft: WorkDraft = {
          title: str(args.title),
          main,
          adult: args.adult,
          ...(typeof args.subtitle === 'string' ? { subtitle: args.subtitle } : {}),
          ...(typeof args.description === 'string' ? { description: args.description } : {}),
          categories: strings(args.categories),
          hashtags: strings(args.hashtags),
          characters: parts.charactersAdd ?? [],
          lorebook: parts.lorebookAdd,
          startScenarios: parts.startScenariosAdd,
          ...(isObj(args.options) ? { options: args.options } : {})
        }
        adapter.checkDraft?.(draft)
        // 대표 이미지는 만들기 전에 올려 주소를 받아 둔다 (올리기만으로는 작품이 생기지 않는다)
        let coverUrl: string | undefined
        if (args.cover_file !== undefined) {
          if (!adapter.uploadImage || !adapter.imageRules) throw new Error('NO_IMAGES')
          const file = await loadImage(args.cover_file, deps, adapter.imageRules)
          coverUrl = await adapter.uploadImage(
            {
              read: deps.reader(adapter.id),
              write: deps.writer(adapter.id),
              send: deps.sender(adapter.id)
            },
            file
          )
        }
        const id = await adapter.create(
          deps.writer(adapter.id),
          { ...draft, ...(coverUrl ? { coverUrl } : {}) },
          deps.reader(adapter.id),
          workIo(deps, adapter.id)
        )
        const raw = await adapter.readRaw(deps.reader(adapter.id), id)
        const body = adapter.normalize(raw)
        const snapshot = await deps.snapshot(adapter.id, id, raw)
        return {
          created: true,
          id,
          title: body.title,
          visibility: body.visibility,
          status: body.status,
          main_length: textLength(body.fields.main ?? ''),
          lorebook_count: body.lorebook.length,
          start_scenario_count: body.startScenarios.length,
          characters: body.characters.map((c) => c.name),
          snapshot
        }
      }
    }
  ]
}
