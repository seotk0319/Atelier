// 언어 판본 저장 도구. 원문 저장과 같은 순서다: "계획(edition_plan) → 확인 → 저장(edition_save)".
// 판본은 편집기처럼 원문 위에 판본 값을 겹쳐서 본다. 판본에 아직 없는 칸은 원문 값이 보이고,
// 저장하면 그 겹친 내용이 통째로 판본에 들어간다 (편집기의 '번역 저장'과 같다).
// 사이트의 자동 번역은 부르지 않는다. 번역문은 부르는 쪽이 직접 준다.
import { randomBytes } from 'node:crypto'
import { workAdapter } from './adapters'
import { CHANGE_PROPERTIES, diffBodies, parseChanges, PLAN_TTL } from './save-tools'
import type { ToolDef, WorkToolDeps } from './tools'
import type { WorkAdapter, WorkBody, WorkChanges, WorkFetch } from './types'

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

interface EditionPlan {
  site: string
  workId: string
  language: string
  changes: WorkChanges
  /** 계획을 세울 때의 겹친 내용. 저장할 때 그대로인지 견준다 */
  base: string
  expires: number
}

// 판본에서 바꿀 수 있는 것만 입력으로 받는다 (구조와 공개 상태는 원문을 따른다)
const EDITION_KEYS = [
  'fields',
  'field_files',
  'lorebook',
  'lorebook_file',
  'lorebook_patch',
  'lorebook_remove',
  'lorebook_add',
  'start_scenarios',
  'characters'
] as const
const properties = Object.fromEntries(
  EDITION_KEYS.map((key) => [key, (CHANGE_PROPERTIES as Record<string, unknown>)[key]])
)

type EditionAdapter = WorkAdapter &
  Required<
    Pick<
      WorkAdapter,
      'editions' | 'readEditionRaw' | 'editionView' | 'applyEditionChanges' | 'saveEdition'
    >
  >
function editionAdapter(siteName: string): EditionAdapter {
  const adapter = workAdapter(siteName)
  if (
    !adapter.editions ||
    !adapter.readEditionRaw ||
    !adapter.editionView ||
    !adapter.applyEditionChanges ||
    !adapter.saveEdition
  )
    throw new Error('NO_EDITION_SAVE')
  return adapter as EditionAdapter
}

export function createEditionTools(deps: WorkToolDeps): ToolDef[] {
  const plans = new Map<string, EditionPlan>()
  const frozen = (body: WorkBody): string => JSON.stringify({ ...body, updatedAt: null })

  /** 원문과 판본을 읽어 겹친 원본을 만든다. 판본 원본은 백업용으로 같이 돌려준다 */
  async function load(
    adapter: EditionAdapter,
    read: WorkFetch,
    id: string,
    language: string
  ): Promise<{ view: unknown; edition: unknown }> {
    const source = await adapter.readRaw(read, id)
    const edition = await adapter.readEditionRaw(read, id, language)
    return { view: adapter.editionView(source, edition), edition }
  }

  return [
    {
      name: 'edition_plan',
      description:
        '언어 판본을 고치기 전에 무엇이 달라지는지 미리 본다. 플랫폼에는 아무것도 쓰지 않는다. ' +
        '순서: editions_list → edition_read → edition_plan → (사용자 확인) → edition_save. ' +
        '입력은 work_plan과 같되 글만 바꿀 수 있다(fields / field_files / lorebook… / start_scenarios / characters). ' +
        '시작 상황·캐릭터의 추가/삭제와 공개 상태는 원문을 따른다. 판본에 아직 없는 칸은 원문 글이 지금 값으로 ' +
        '보이고, 저장하면 바꾸지 않은 칸은 그 글 그대로 판본에 들어간다. 판본이 아직 없으면(exists: false) ' +
        '저장할 때 수동 번역 판본이 새로 생긴다. 사이트의 자동 번역은 쓰지 않으므로 번역문을 직접 준다.',
      inputSchema: {
        type: 'object',
        properties: {
          site: { type: 'string', description: '플랫폼 이름 (sites_list의 site)' },
          work_id: { type: 'string', description: '작품 번호 (works_list의 id)' },
          language: { type: 'string', description: '언어 코드 (editions_list의 language)' },
          ...properties
        },
        required: ['site', 'work_id', 'language']
      },
      async run(args) {
        const adapter = editionAdapter(str(args.site))
        const id = str(args.work_id).toLowerCase()
        const read = deps.reader(adapter.id)
        // 원문 언어나 목록에 없는 언어에는 쓰지 않는다
        const wanted = str(args.language).toLowerCase()
        const edition = (await adapter.editions(read, id)).find(
          (e) => e.language.toLowerCase() === wanted && !e.isSource
        )
        if (!edition) throw new Error('BAD_LANGUAGE')
        const changes = await parseChanges(
          Object.fromEntries(EDITION_KEYS.flatMap((k) => (k in args ? [[k, args[k]]] : []))),
          deps
        )
        const { view } = await load(adapter, read, id, edition.language)
        const before = adapter.normalize(view)
        const after = adapter.normalize(adapter.applyEditionChanges(view, changes))
        const diff = diffBodies(before, after)
        const head = { language: edition.language, exists: edition.exists, title: before.title }
        if (!diff.length) return { ...head, changes: [], nothing_to_save: true }

        const now = Date.now()
        for (const [key, plan] of plans) if (plan.expires < now) plans.delete(key)
        const planId = randomBytes(4).toString('hex')
        plans.set(planId, {
          site: adapter.id,
          workId: id,
          language: edition.language,
          changes,
          base: frozen(before),
          expires: now + PLAN_TTL
        })
        return {
          ...head,
          plan_id: planId,
          changes: diff,
          note: edition.exists
            ? '아직 저장하지 않았어요. 사용자가 확인한 뒤 edition_save를 불러 주세요.'
            : '아직 저장하지 않았어요. 이 판본은 아직 없어서, 저장하면 수동 번역 판본이 새로 생기고 바꾸지 않은 칸은 원문 글 그대로 들어가요.'
        }
      }
    },
    {
      name: 'edition_save',
      description:
        'edition_plan으로 세운 계획을 그 언어 판본에 저장한다 (편집기의 번역 저장과 같은 요청). 사용자가 ' +
        '변경 내용을 보고 저장하라고 한 뒤에만 부른다. 계획 뒤 원문이나 판본이 바뀌었으면 저장하지 않는다. ' +
        '저장 직전 판본 원본을 backup 경로에 남기고, 저장 뒤 다시 읽어 견준 결과를 verified로 돌려준다. ' +
        '원문의 공개 상태는 건드리지 않는다.',
      inputSchema: {
        type: 'object',
        properties: { plan_id: { type: 'string', description: 'edition_plan이 돌려준 plan_id' } },
        required: ['plan_id']
      },
      async run(args) {
        const planId = str(args.plan_id)
        const plan = plans.get(planId)
        if (!plan || plan.expires < Date.now()) {
          plans.delete(planId)
          throw new Error('PLAN_NOT_FOUND')
        }
        const adapter = editionAdapter(plan.site)
        const read = deps.reader(adapter.id)
        const name = plan.workId + '__' + plan.language

        const { view, edition } = await load(adapter, read, plan.workId, plan.language)
        if (frozen(adapter.normalize(view)) !== plan.base) {
          plans.delete(planId)
          throw new Error('PLAN_STALE')
        }
        const backup = await deps.snapshot(adapter.id, name, edition)
        const next = adapter.applyEditionChanges(view, plan.changes)
        const expected = adapter.normalize(next)

        plans.delete(planId)
        await adapter.saveEdition(deps.writer(adapter.id), plan.workId, plan.language, next)

        const saved = await load(adapter, read, plan.workId, plan.language)
        await deps.snapshot(adapter.id, name, saved.edition)
        const mismatches = diffBodies(expected, adapter.normalize(saved.view))
        return {
          saved: true,
          verified: mismatches.length === 0,
          mismatches,
          language: plan.language,
          title: expected.title,
          backup
        }
      }
    }
  ]
}
