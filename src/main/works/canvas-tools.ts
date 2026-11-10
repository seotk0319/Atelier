// 캔버스 JSON 도구 (노드 캔버스로 만드는 플랫폼: 알플레이). 편집기의 "캔버스 내보내기 → 로컬에서 고치기 →
// 캔버스 가져오기 → 다시 내보내 대조"를 도구로 한다.
//  - canvas_export: 읽기만 한다. 내보낸 JSON을 스냅샷 폴더에 파일로 남기고 경로를 돌려준다.
//  - canvas_plan: 플랫폼에 아무것도 쓰지 않는다. 로컬 파일을 규격 검사하고 지금 캔버스와 견준 요약과 plan_id를 준다.
//  - canvas_apply: 계획 뒤 캔버스나 파일이 바뀌었으면 멈춘다. 직전 캔버스를 내보내 백업으로 남기고 가져온 뒤,
//    다시 내보내 넣은 파일과 견준다. 가져오기는 캔버스 전체를 바꾸므로 사용자가 계획을 본 뒤에만 부른다.
import { createHash, randomBytes } from 'node:crypto'
import { platformNote, workAdapter, workKey } from './adapters'
import type { ToolDef, WorkToolDeps } from './tools'
import type { CanvasFile, CanvasImportOptions, CanvasSummary, WorkAdapter, WorkIo } from './types'

const PLAN_TTL = 30 * 60_000
/** 캔버스 파일 한도. 실제 내보내기 파일은 0.5MB 안팎이다 */
export const CANVAS_FILE_MAX = 20_000_000

type Obj = Record<string, unknown>
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const fileName = (path: string): string => path.split(/[\\/]/).pop() ?? ''

interface CanvasPlan {
  site: string
  workId: string
  path: string
  /** 계획 때 읽은 파일 바이트의 SHA-256 */
  fileHash: string
  canvasId: string
  /** 계획 때의 캔버스 (내보낸 시각을 뺀 모습) */
  stamp: string
  options: Omit<CanvasImportOptions, 'canvasId'>
  expires: number
}

type CanvasAdapter = WorkAdapter &
  Required<Pick<WorkAdapter, 'exportCanvas' | 'checkCanvas' | 'importCanvas' | 'compareCanvas'>>
function canvasAdapter(site: unknown): CanvasAdapter {
  const adapter = workAdapter(str(site))
  if (
    !adapter.exportCanvas ||
    !adapter.checkCanvas ||
    !adapter.importCanvas ||
    !adapter.compareCanvas
  )
    throw new Error('NO_CANVAS')
  return adapter as CanvasAdapter
}

/** 로컬 캔버스 JSON 하나를 읽는다. UTF-8이 아니거나 JSON이 아니면 BAD_CANVAS_FILE (BOM은 뺀다) */
async function loadCanvas(
  path: unknown,
  deps: WorkToolDeps
): Promise<{ file: CanvasFile; parsed: unknown; hash: string }> {
  const p = str(path)
  const name = fileName(p)
  if (!name || !/\.json$/i.test(name)) throw new Error('BAD_CANVAS_FILE .json 파일이 아님')
  let raw: Uint8Array
  try {
    raw = await deps.readBinary(p, CANVAS_FILE_MAX)
  } catch {
    throw new Error('BAD_CANVAS_FILE 읽지 못함 (20MB 이하)')
  }
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(raw)
  } catch {
    throw new Error('BAD_CANVAS_FILE UTF-8 아님')
  }
  // 편집기는 파일을 글로 읽어(BOM 빠짐) 그 글을 그대로 올리고 해시한다
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('BAD_CANVAS_FILE JSON 아님')
  }
  const data = new TextEncoder().encode(text)
  return {
    file: { name, text, data },
    parsed,
    hash: createHash('sha256').update(data).digest('hex')
  }
}

const shown = (s: CanvasSummary): Obj => ({
  export_version: s.version,
  language: s.language,
  nodes: s.nodes,
  node_types: s.nodeTypes,
  connections: s.connections,
  metadata: s.metadata,
  annotations: s.annotations
})

/** 공통 설정 중 값이 다른 이름들 */
function settingsDiff(
  a: Record<string, unknown> | null,
  b: Record<string, unknown> | null
): string[] {
  if (!a || !b) return []
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(
    (k) => JSON.stringify(a[k]) !== JSON.stringify(b[k])
  )
}

const site = {
  type: 'string',
  description: '플랫폼 이름 (sites_list의 site. 캔버스는 can_canvas가 true인 곳)'
}
const workId = { type: 'string', description: '작품 번호 (works_list의 id)' }

export function createCanvasTools(deps: WorkToolDeps, forget: (key: string) => void): ToolDef[] {
  const plans = new Map<string, CanvasPlan>()
  const io = (platform: string): WorkIo => ({
    read: deps.reader(platform),
    write: deps.writer(platform),
    send: (request) => deps.sender(platform)(request)
  })
  const snapshotName = (adapter: WorkAdapter, id: string): string =>
    workKey(adapter, id) + '__canvas'

  return [
    {
      name: 'canvas_export',
      description:
        '작품의 캔버스 JSON을 편집기의 "캔버스 내보내기"와 같은 요청으로 받아 로컬 파일로 남긴다 (알플레이). ' +
        '플랫폼에는 아무것도 쓰지 않는다. 결과의 file 경로가 내보낸 JSON이다(편집기 내보내기 파일과 같은 모양: ' +
        'exportVersion · canvas · storyChat · nodes · connections · annotations · metadataSet, metadataSet의 키 = 노드 uid). ' +
        '이 파일을 작업 폴더로 복사해 고친 뒤 canvas_plan의 file로 준다. 노드 종류·연결·고급 설정·유저 노드처럼 ' +
        'work_plan으로 못 고치는 곳은 이 방법으로 고친다.',
      inputSchema: {
        type: 'object',
        properties: { site, work_id: workId },
        required: ['site', 'work_id']
      },
      async run(args) {
        const adapter = canvasAdapter(args.site)
        const id = workKey(adapter, str(args.work_id))
        const got = await adapter.exportCanvas(deps.reader(adapter.id), id)
        const file = await deps.snapshot(adapter.id, snapshotName(adapter, id), got.data)
        const { summary, problems } = adapter.checkCanvas(got.data)
        return {
          site: adapter.id,
          work_id: id,
          canvas_id: got.canvasId,
          file,
          summary: shown(summary),
          ...(problems.length ? { problems } : {})
        }
      }
    },
    {
      name: 'canvas_plan',
      description:
        '캔버스 JSON을 가져오기 전 확인 단계 (알플레이). 플랫폼에는 아무것도 쓰지 않는다. 순서: canvas_export → ' +
        '로컬에서 고치기 → canvas_plan → (사용자 확인) → canvas_apply. 로컬 파일의 규격(JSON 모양, exportVersion, ' +
        'nodes[].uid와 metadataSet 키, 연결 양 끝 노드, 캔버스 언어)을 검사하고, 지금 캔버스와 노드·연결 수를 견준 요약과 ' +
        'plan_id를 돌려준다. 규격에 안 맞으면 problems만 돌려주고 plan_id는 주지 않는다. 가져오면 캔버스 전체가 이 ' +
        '파일로 바뀌고 컴파일된 데이터가 지워진다(되돌리려면 apply가 남긴 backup 파일을 다시 가져온다). ' +
        '파일의 캔버스 언어가 지금 캔버스와 다르면 use_current_language, 고급 설정(storyChat.advancedSettings)이 ' +
        '다르면 settings_choice가 필요하다.',
      inputSchema: {
        type: 'object',
        properties: {
          site,
          work_id: workId,
          file: {
            type: 'string',
            description: '가져올 캔버스 JSON 로컬 파일 경로 (.json, UTF-8, 20MB 이하)'
          },
          use_current_language: {
            type: 'boolean',
            description:
              '파일의 캔버스 언어가 지금 캔버스와 다를 때 지금 캔버스 언어로 넣는다 (편집기의 "현재 캔버스 언어로 가져오기")'
          },
          settings_choice: {
            type: 'string',
            description:
              '고급 설정이 다를 때 고르는 쪽: current(지금 설정 유지) 또는 imported(파일 설정). 다르지 않으면 주지 않아도 된다'
          }
        },
        required: ['site', 'work_id', 'file']
      },
      async run(args) {
        const adapter = canvasAdapter(args.site)
        const id = workKey(adapter, str(args.work_id))
        if (
          args.use_current_language !== undefined &&
          typeof args.use_current_language !== 'boolean'
        )
          throw new Error('BAD_CHANGES')
        const choice = args.settings_choice
        if (choice !== undefined && choice !== 'current' && choice !== 'imported')
          throw new Error('BAD_CHANGES settings_choice')
        const { file, parsed, hash } = await loadCanvas(args.file, deps)
        const check = adapter.checkCanvas(parsed)
        if (check.problems.length)
          return {
            plan_id: null,
            file: { name: file.name, bytes: file.data.byteLength, summary: shown(check.summary) },
            problems: check.problems,
            note: '규격에 맞지 않아 계획을 세우지 않았어요. problems를 고친 뒤 다시 canvas_plan을 불러 주세요.'
          }

        const current = await adapter.exportCanvas(deps.reader(adapter.id), id)
        const now = adapter.checkCanvas(current.data).summary
        const fileSummary = check.summary

        const fileLanguage = (fileSummary.language ?? '').toLowerCase()
        const nowLanguage = (now.language ?? '').toLowerCase()
        const languageMismatch = !!nowLanguage && fileLanguage !== nowLanguage
        if (languageMismatch && args.use_current_language !== true)
          throw new Error('IMPORT_LANGUAGE_MISMATCH ' + fileLanguage + '→' + nowLanguage)
        const settings = settingsDiff(now.settings, fileSummary.settings)
        if (settings.length && !choice)
          throw new Error('IMPORT_SETTINGS_CHOICE_REQUIRED ' + settings.slice(0, 12).join(','))

        const before = new Set(now.nodeIds)
        const after = new Set(fileSummary.nodeIds)
        const differences = adapter.compareCanvas(parsed, current.data, {
          keepCurrentLanguage: languageMismatch,
          keepCurrentSettings: choice === 'current'
        })
        const warnings: string[] = [
          '가져오면 지금 캔버스 전체가 이 파일로 바뀌고, 컴파일된 데이터가 지워져 다시 컴파일해야 대화에 반영돼요 (여기서는 컴파일하지 않아요).'
        ]
        if (fileSummary.sourceWorkId && fileSummary.sourceWorkId !== id)
          warnings.push(
            '다른 작품(' +
              fileSummary.sourceWorkId +
              ')에서 내보낸 파일이에요. 편집기 안내대로 작품 번호나 노드가 바뀐 파일은 기존 데이터(이미지 등)가 제대로 옮겨지지 않을 수 있어요.'
          )
        if (languageMismatch)
          warnings.push(
            '파일 언어(' +
              fileLanguage +
              ')가 아니라 지금 캔버스 언어(' +
              nowLanguage +
              ')로 넣어요.'
          )
        if (settings.length)
          warnings.push(
            '고급 설정이 달라요(' +
              settings.join(', ') +
              '). ' +
              (choice === 'current' ? '지금 설정을 남겨요.' : '파일 설정으로 바꿔요.')
          )

        const nowTime = Date.now()
        for (const [key, plan] of plans) if (plan.expires < nowTime) plans.delete(key)
        const planId = randomBytes(4).toString('hex')
        plans.set(planId, {
          site: adapter.id,
          workId: id,
          path: str(args.file),
          fileHash: hash,
          canvasId: current.canvasId,
          stamp: current.stamp,
          options: {
            ...(languageMismatch ? { useCurrentLanguage: true } : {}),
            ...(choice ? { settingsChoice: choice } : {})
          },
          expires: nowTime + PLAN_TTL
        })
        return {
          plan_id: planId,
          target: { work_id: id, canvas_id: current.canvasId, language: now.language },
          file: { name: file.name, bytes: file.data.byteLength, summary: shown(fileSummary) },
          current: shown(now),
          changes: {
            nodes_kept: [...after].filter((u) => before.has(u)).length,
            nodes_added: [...after].filter((u) => !before.has(u)).length,
            nodes_removed: [...before].filter((u) => !after.has(u)).length,
            connections: { before: now.connections, after: fileSummary.connections },
            different_places: differences.length,
            preview: differences.slice(0, 30)
          },
          warnings,
          note: '아직 가져오지 않았어요. 사용자가 확인한 뒤 canvas_apply를 불러 주세요. 가져오면 캔버스 전체가 바뀌어요.',
          ...platformNote(adapter)
        }
      }
    },
    {
      name: 'canvas_apply',
      description:
        'canvas_plan으로 세운 계획대로 캔버스 JSON을 가져온다 (알플레이). 사용자가 계획을 보고 진행하라고 한 뒤에만 ' +
        '부른다. 계획 뒤 캔버스나 로컬 파일이 바뀌었으면 멈춘다. 직전 캔버스를 내보내 backup 파일로 남기고, 편집기와 ' +
        '같은 순서(업로드 주소 받기 → 파일 올리기 → 가져오기 → 끝날 때까지 상태 확인)로 넣은 뒤, 다시 내보내 넣은 ' +
        '파일과 노드·연결·노드 내용을 견준 결과를 verified와 mismatches로 돌려준다(서버가 붙이는 createdAt · updatedAt · ' +
        '토큰 수는 빼고 본다). 컴파일은 하지 않는다. 중간에 실패하면 imported:false와 함께 캔버스가 바뀌었는지(canvas_changed)를 ' +
        '알려 준다. 되돌리려면 backup 파일로 canvas_plan → canvas_apply를 한다.',
      inputSchema: {
        type: 'object',
        properties: { plan_id: { type: 'string', description: 'canvas_plan이 돌려준 plan_id' } },
        required: ['plan_id']
      },
      async run(args) {
        const planId = str(args.plan_id)
        const plan = plans.get(planId)
        if (!plan || plan.expires < Date.now()) {
          plans.delete(planId)
          throw new Error('PLAN_NOT_FOUND')
        }
        const adapter = canvasAdapter(plan.site)
        const read = deps.reader(adapter.id)
        const { file, parsed, hash } = await loadCanvas(plan.path, deps)
        const current = await adapter.exportCanvas(read, plan.workId)
        if (
          hash !== plan.fileHash ||
          current.canvasId !== plan.canvasId ||
          current.stamp !== plan.stamp
        ) {
          plans.delete(planId)
          throw new Error('PLAN_STALE')
        }
        const backup = await deps.snapshot(
          adapter.id,
          snapshotName(adapter, plan.workId),
          current.data
        )
        plans.delete(planId)
        forget(adapter.id + ':' + plan.workId)
        const compare = {
          keepCurrentLanguage: plan.options.useCurrentLanguage === true,
          keepCurrentSettings: plan.options.settingsChoice === 'current'
        }

        let runId: string | null = null
        try {
          ;({ runId } = await adapter.importCanvas(io(adapter.id), plan.workId, file, {
            ...plan.options,
            canvasId: plan.canvasId
          }))
        } catch (error) {
          const code = error instanceof Error ? error.message.slice(0, 160) : String(error)
          // 캔버스가 바뀌었는지는 다시 내보내 직전 백업과 견줘 본다
          let changed: boolean | null = null
          let after: string | null = null
          try {
            const now = await adapter.exportCanvas(read, plan.workId)
            after = await deps.snapshot(adapter.id, snapshotName(adapter, plan.workId), now.data)
            changed = adapter.compareCanvas(current.data, now.data).length > 0
          } catch {
            changed = null
          }
          return {
            imported: false,
            error: code,
            canvas_changed: changed,
            backup,
            after,
            note:
              changed === false
                ? '가져오지 못했고 캔버스는 그대로예요.'
                : changed === true
                  ? '가져오기가 끝까지 되지 않았는데 캔버스가 바뀌었어요(일부만 들어갔을 수 있어요). 잠시 뒤 canvas_export로 확인하고, 되돌리려면 backup 파일로 canvas_plan → canvas_apply를 해 주세요.'
                  : '캔버스 상태를 확인하지 못했어요. 잠시 뒤 canvas_export로 확인해 주세요.'
          }
        }

        const after = await adapter.exportCanvas(read, plan.workId)
        const afterFile = await deps.snapshot(
          adapter.id,
          snapshotName(adapter, plan.workId),
          after.data
        )
        const mismatches = adapter.compareCanvas(parsed, after.data, compare)
        return {
          imported: true,
          verified: mismatches.length === 0,
          mismatch_count: mismatches.length,
          mismatches: mismatches.slice(0, 50),
          run_id: runId,
          canvas_id: after.canvasId,
          summary: shown(adapter.checkCanvas(after.data).summary),
          backup,
          after: afterFile,
          note: '가져왔어요. 컴파일된 데이터가 지워졌으니 대화에 반영하려면 사이트 편집기에서 스토리 컴파일을 해 주세요.'
        }
      }
    }
  ]
}

/** sites_list 표시용: 이 연결부가 캔버스 도구를 다 갖췄는지 */
export const canCanvas = (adapter: WorkAdapter): boolean =>
  !!(adapter.exportCanvas && adapter.checkCanvas && adapter.importCanvas && adapter.compareCanvas)
