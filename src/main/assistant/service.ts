// AI 비서: 명령 바에서 받은 말을 Claude에 보내고, 앱 데이터는 읽기 도구로만 보여 준다.
// 앱을 바꾸는 일은 계획(propose_changes)으로만 돌려주고, 실제 적용은 화면에서 사용자가 실행을 눌렀을 때 한다.
import { BrowserWindow, dialog } from 'electron'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import {
  ASSISTANT_GUIDE_MAX,
  ASSISTANT_MODELS,
  ASSISTANT_PRICES,
  type AssistantContext,
  type AssistantDraft,
  type AssistantModel,
  type AssistantOp,
  type AssistantPlan,
  type AssistantReply,
  type AssistantStatus
} from '../../shared/assistant'
import { getDb } from '../db'
import { getClaudeKey, getSetting, setClaudeKey, setSetting } from '../db/settings'
import { listPresetFolders, listPresets, listScenes } from '../scenes/repo'
import { ClaudeError, claudeMessage, claudeVerify, type ClaudeResponse } from '../llm/claude'
import { PROFILE } from '../profile'
import { remoteConfigured } from '../remote/source'

const MODEL_KEY = 'assistant_model'
const GUIDE_KEY = 'assistant_guide'
const GUIDE_NAME_KEY = 'assistant_guide_name'
const DOCK_KEY = 'assistant_show_dock'
const MAX_ROUNDS = 8

const MESSAGES: Record<string, string> = {
  NO_KEY: 'Claude API 키가 아직 없어요. 설정 > AI 비서에서 키를 넣어주세요.',
  AUTH: 'Claude 인증에 실패했어요. 설정 > AI 비서의 API 키를 확인해주세요.',
  CREDIT: 'Claude 크레딧이 모자라요. Claude Console에서 남은 크레딧을 확인해주세요.',
  RATE: '요청이 잠깐 몰렸어요. 조금 뒤 다시 말해 주세요.',
  OVERLOADED: 'Claude 서버가 붐벼요. 조금 뒤 다시 말해 주세요.',
  BAD_REQUEST: 'Claude가 요청을 받지 않았어요. 새 대화로 다시 시도해 주세요.',
  SERVER: 'Claude 서버에 문제가 있어요. 잠시 뒤 다시 시도해 주세요.',
  NETWORK: '네트워크에 연결할 수 없어요. 인터넷 연결을 확인해주세요.',
  TIMEOUT: 'Claude 응답이 너무 늦어요. 다시 말해 주세요.',
  REFUSED: 'AI가 이 요청에는 답하지 않았어요.'
}

function model(): AssistantModel {
  return getSetting(MODEL_KEY) === 'haiku' ? 'haiku' : 'sonnet'
}
function guide(): string {
  return getSetting(GUIDE_KEY) || ''
}

/**
 * AI 비서가 사용자를 부르는 말(설정 assistant_user_title). 설정이 없으면 맥미니 연결이 설정된
 * 본 프로필(만든 사람의 PC)만 "아빠"로 부르고, 새로 깐 PC는 호칭 없이 "사용자"로 쓴다.
 */
const USER_TITLE_KEY = 'assistant_user_title'
function userTitle(): string {
  const saved = getSetting(USER_TITLE_KEY)?.trim()
  if (saved) return saved
  return PROFILE === 1 && remoteConfigured() ? '아빠' : ''
}
/** 받침이 있으면 "이라고", 없으면 "라고" */
function rago(word: string): string {
  const code = word.charCodeAt(word.length - 1) - 0xac00
  return code >= 0 && code < 11172 && code % 28 !== 0 ? '이라고' : '라고'
}
/** 프롬프트 속 {user}를 호칭으로, {call}을 "사용자를 ~라고 부르고, "로 바꾼다 */
function addressed(text: string, title: string): string {
  return text
    .replaceAll('{call}', title ? `사용자를 "${title}"${rago(title)} 부르고, ` : '')
    .replaceAll('{user}', title || '사용자')
}

export function assistantStatus(): AssistantStatus {
  const text = guide()
  return {
    claudeReady: !!getClaudeKey(),
    model: model(),
    guideName: text ? getSetting(GUIDE_NAME_KEY) || '지침' : null,
    guideChars: text.length,
    showDock: getSetting(DOCK_KEY) !== '0'
  }
}

export function setAssistantConfig(patch: {
  model?: AssistantModel
  guide?: string | null
  guideName?: string | null
  showDock?: boolean
}): AssistantStatus {
  if (patch.model === 'sonnet' || patch.model === 'haiku') setSetting(MODEL_KEY, patch.model)
  if (patch.guide !== undefined) {
    const text = String(patch.guide || '').slice(0, ASSISTANT_GUIDE_MAX)
    setSetting(GUIDE_KEY, text)
    setSetting(GUIDE_NAME_KEY, text ? String(patch.guideName || '지침').slice(0, 80) : '')
  }
  if (patch.showDock !== undefined) setSetting(DOCK_KEY, patch.showDock ? '1' : '0')
  return assistantStatus()
}

export async function importAssistantGuide(): Promise<AssistantStatus & { message: string }> {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  const result = await dialog.showOpenDialog(win, {
    title: 'AI 비서 지침 불러오기',
    properties: ['openFile'],
    filters: [{ name: '문서', extensions: ['md', 'txt'] }]
  })
  if (result.canceled || !result.filePaths[0]) return { ...assistantStatus(), message: '' }
  const path = result.filePaths[0]
  const text = (await readFile(path, 'utf-8')).replace(/^\uFEFF/, '')
  const cut = text.length > ASSISTANT_GUIDE_MAX
  const status = setAssistantConfig({ guide: text, guideName: basename(path) })
  return {
    ...status,
    message: cut
      ? '앞부분 ' + ASSISTANT_GUIDE_MAX.toLocaleString() + '자만 넣었어요.'
      : basename(path) + '을(를) 지침으로 넣었어요.'
  }
}

export async function saveAssistantKey(raw: string): Promise<{ ok: boolean; message: string }> {
  const key = String(raw || '').trim()
  if (!key || key.length > 300 || /\s/.test(key))
    return { ok: false, message: 'Claude API 키 모양이 아니에요. 다시 붙여넣어 주세요.' }
  try {
    await claudeVerify(key)
    setClaudeKey(key)
    return { ok: true, message: '키를 확인하고 저장했어요.' }
  } catch (error) {
    const code = error instanceof ClaudeError ? error.code : 'SERVER'
    return { ok: false, message: MESSAGES[code] || MESSAGES.SERVER }
  }
}

// ── 도구 ──

const TOOLS = [
  {
    name: 'list_scene_presets',
    description:
      '씬 프리셋 폴더와 프리셋 목록을 읽는다. 프리셋마다 id, 이름, 들어 있는 폴더 id, 씬 수, 남은 예약 수가 온다.',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'list_scenes',
    description:
      '프리셋 하나의 씬 목록(id, 이름, 예약 수, 이미지 수)을 읽는다. 많으면 앞 400개만 온다.',
    input_schema: {
      type: 'object',
      properties: { presetId: { type: 'integer' } },
      required: ['presetId']
    }
  },
  {
    name: 'propose_changes',
    description:
      '앱을 바꾸는 계획을 {user}에게 보여 준다. 실제 적용은 {user}가 실행 버튼을 눌렀을 때만 된다. 이 도구를 부르면 그 턴은 끝난다.',
    input_schema: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: '계획 한 줄 요약 (해요체)' },
        note: { type: 'string', description: '알아 둘 점 한 줄 (없으면 빈 문자열)' },
        ops: {
          type: 'array',
          description: '순서대로 실행할 단계',
          items: {
            type: 'object',
            properties: {
              type: {
                type: 'string',
                enum: [
                  'create_folder',
                  'move_folder',
                  'move_presets',
                  'rename_preset',
                  'rename_folder',
                  'set_reserve'
                ]
              },
              ref: {
                type: 'string',
                description: 'create_folder: 이 계획 안에서 부를 이름표 (예: f1)'
              },
              name: { type: 'string', description: 'create_folder / rename_*: 새 이름' },
              presetIds: { type: 'array', items: { type: 'integer' }, description: 'move_presets' },
              folderId: {
                type: ['integer', 'null'],
                description:
                  'move_presets: 기존 폴더 id, null이면 폴더 밖 / rename_folder: 대상 폴더'
              },
              folderRef: {
                type: 'string',
                description: 'move_presets: 이 계획에서 만든 폴더의 ref'
              },
              parentId: {
                type: ['integer', 'null'],
                description:
                  'create_folder / move_folder: 상위로 삼을 기존 맨 위 폴더 id. move_folder에서 null이면 맨 위 단계로 꺼낸다'
              },
              parentRef: {
                type: 'string',
                description:
                  'create_folder / move_folder: 이 계획에서 만든 맨 위 폴더의 ref를 상위로'
              },
              presetId: { type: 'integer', description: 'rename_preset / set_reserve 대상' },
              count: { type: 'integer', description: 'set_reserve: 씬마다 예약할 장수 (0~100)' },
              sceneIds: {
                type: 'array',
                items: { type: 'integer' },
                description: 'set_reserve: 일부 씬만 (비우면 프리셋 전체)'
              }
            },
            required: ['type']
          }
        }
      },
      required: ['summary', 'ops']
    }
  },
  {
    name: 'write_prompt',
    description:
      '이미지 생성 프롬프트(타이포·업데이트 문구·오버레이·사인 등)를 카드로 보여 준다. {user}가 카드에서 GPT 이미지 입력칸에 넣거나 복사한다. 시안이 여러 개면 drafts에 각각 완결된 전체 프롬프트로 넣는다. 이 도구를 부르면 그 턴은 끝난다.',
    input_schema: {
      type: 'object',
      properties: {
        drafts: {
          type: 'array',
          maxItems: 6,
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: '카드 제목 (예: 한국어 · 매거진형)' },
              prompt: { type: 'string', description: '그대로 붙여 넣을 완결된 전체 프롬프트' }
            },
            required: ['title', 'prompt']
          }
        }
      },
      required: ['drafts']
    }
  }
]
/** 도구 설명 속 {user}를 호칭으로 바꾼다 */
function addressedTools(title: string): typeof TOOLS {
  return TOOLS.map((t) => ({ ...t, description: addressed(t.description, title) }))
}
const TERMINAL = new Set(['propose_changes', 'write_prompt'])

const SYSTEM = [
  '너는 NAIS3 Custom 안에 들어 있는 AI 비서다. NAIS3 Custom은 NovelAI·GPT 이미지를 만드는 데스크톱 앱이고, 사용자는 캐릭터챗 크리에이터다.',
  '{call}짧고 부드러운 한국어 해요체로 답한다. 결과를 먼저 말하고 설명은 한두 문장으로 끝낸다.',
  '',
  '할 수 있는 일',
  '- 씬 프리셋 정리: 폴더 만들기, 프리셋을 폴더로 옮기기, 프리셋·폴더 이름 바꾸기, 씬 예약 장수 정하기. 반드시 propose_changes로 계획을 내고 멈춘다. {user}가 실행을 눌러야 적용된다. 적용했다고 말하지 않는다.',
  '- 이미지 프롬프트 쓰기: write_prompt로 완결된 전체 프롬프트를 낸다. 아래 작업 지침이 있으면 그대로 따른다.',
  '',
  '못 하는 일: 무엇을 지우는 일, 이미지 생성 버튼 누르기, 파일·폴더 작업, 설정 바꾸기. 요청받으면 못 한다고 짧게 말하고 앱에서 직접 하는 방법을 알려 준다.',
  '',
  '규칙',
  '- 앱 데이터는 도구로 읽은 것만 근거로 쓴다. id·이름·개수를 지어내지 않는다. 계획을 내기 전에 list_scene_presets를 먼저 읽는다.',
  '- 프리셋 폴더는 2단계까지다: 맨 위 작품 폴더 아래에 캐릭터 같은 하위 폴더를 둘 수 있고, 하위 폴더 안에는 또 폴더를 만들 수 없다. 작품 안에서 캐릭터별로 나눌 때는 작품 폴더 아래 하위 폴더(예: sm1, na1)를 만든다(create_folder의 parentId/parentRef). 하위 폴더가 있는 폴더는 다른 폴더 아래로 넣을 수 없다.',
  '- 예전 방식의 "작품 · 캐릭터" 이름 폴더는 move_folder로 작품 폴더 아래에 넣고 rename_folder로 캐릭터 이름만 남기면 2단계로 바뀐다. 폴더는 지울 수 없으니 빈 폴더가 남으면 note에 알려 준다.',
  '- 에셋 프리셋 이름은 보통 작품접두_캐릭터코드번호_상황... 모양이다(예: off_sm1_emotion15_..., off_na1_life45_...). 캐릭터별로 정리할 때는 캐릭터코드(sm1, na1처럼 영문+숫자)로 묶는다. 코드가 누구인지 모르면 코드를 그대로 폴더 이름에 쓴다.',
  '- 지금 화면 정보가 질문 앞에 붙어 온다. "이 프리셋", "여기"는 그 정보를 가리킨다.',
  '- 요청이 모호하면 계획을 내기 전에 한 문장으로 물어본다.'
].join('\n')

function toolTrace(name: string, result: unknown): string {
  const r = result as {
    presets?: unknown[]
    folders?: unknown[]
    scenes?: unknown[]
    preset?: string
  }
  if (name === 'list_scene_presets')
    return (
      '씬 프리셋 ' +
      (r.presets?.length ?? 0) +
      '개와 폴더 ' +
      (r.folders?.length ?? 0) +
      '개를 읽었어요'
    )
  if (name === 'list_scenes')
    return '"' + (r.preset ?? '') + '" 씬 ' + (r.scenes?.length ?? 0) + '개를 읽었어요'
  return name
}

function runReadTool(name: string, input: Record<string, unknown>): unknown {
  if (name === 'list_scene_presets') {
    const counts = new Map<number, { n: number; r: number }>()
    for (const row of getDb()
      .prepare(
        'SELECT preset_id AS p, COUNT(*) AS n, COALESCE(SUM(reserve_count), 0) AS r FROM gen_scenes GROUP BY preset_id'
      )
      .all() as { p: number; n: number; r: number }[])
      counts.set(row.p, { n: row.n, r: row.r })
    return {
      folders: listPresetFolders().map((f) => ({
        id: f.id,
        name: f.name,
        parentId: f.parentId ?? null
      })),
      presets: listPresets().map((p) => ({
        id: p.id,
        name: p.name,
        folderId: p.folderId,
        scenes: counts.get(p.id)?.n ?? 0,
        reserved: counts.get(p.id)?.r ?? 0
      }))
    }
  }
  if (name === 'list_scenes') {
    const id = Number(input.presetId)
    const preset = listPresets().find((p) => p.id === id)
    if (!preset) return { error: '그런 프리셋이 없어요: ' + id }
    const scenes = listScenes(id)
    return {
      preset: preset.name,
      total: scenes.length,
      scenes: scenes.slice(0, 400).map((s) => ({
        id: s.id,
        name: s.name,
        reserve: s.reserveCount,
        images: s.imageCount
      }))
    }
  }
  return { error: '모르는 도구예요: ' + name }
}

const cleanName = (v: unknown): string =>
  String(v ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)

/** 계획을 앱 데이터와 맞춰 본다. 문제가 있으면 이유를 돌려준다(AI에게 다시 고치게 한다). */
export function checkPlan(
  raw: Record<string, unknown>
): { plan: AssistantPlan } | { error: string } {
  const presets = new Map(listPresets().map((p) => [p.id, p]))
  const folders = new Set(listPresetFolders().map((f) => f.id))
  const refs = new Set<string>()
  // 폴더 2단계 검사용: 'id:5' / 'ref:f1' → 상위 키 (계획을 따라가며 바뀐다)
  const tree = new Map<string, string | null>(
    listPresetFolders().map((f) => ['id:' + f.id, f.parentId != null ? 'id:' + f.parentId : null])
  )
  const kids = (key: string): number => [...tree.values()].filter((p) => p === key).length
  const parentKey = (op: Record<string, unknown>): { key: string | null; error?: string } => {
    const pRef = op.parentRef == null ? '' : String(op.parentRef).trim()
    if (pRef)
      return refs.has(pRef)
        ? { key: 'ref:' + pRef }
        : { key: null, error: '앞에서 만들지 않은 parentRef: ' + pRef }
    if (op.parentId == null) return { key: null }
    const pId = Number(op.parentId)
    return folders.has(pId)
      ? { key: 'id:' + pId }
      : { key: null, error: '없는 상위 폴더 id: ' + op.parentId }
  }
  const parentOp = (key: string | null): { parentId?: number | null; parentRef?: string } =>
    key == null
      ? { parentId: null }
      : key.startsWith('ref:')
        ? { parentRef: key.slice(4) }
        : { parentId: Number(key.slice(3)) }
  const ops: AssistantOp[] = []
  const list = Array.isArray(raw.ops) ? (raw.ops as Record<string, unknown>[]) : []
  if (!list.length) return { error: '단계가 비어 있어요.' }
  if (list.length > 60) return { error: '단계가 너무 많아요. 60개 안으로 묶어 주세요.' }
  for (const [i, op] of list.entries()) {
    const at = i + 1 + '번째 단계: '
    const type = op.type
    if (type === 'create_folder') {
      const ref = String(op.ref ?? '').trim()
      const name = cleanName(op.name)
      if (!ref || refs.has(ref)) return { error: at + 'ref가 비었거나 겹쳐요.' }
      if (!name) return { error: at + '폴더 이름이 비었어요.' }
      refs.add(ref)
      const p = parentKey(op)
      if (p.error) return { error: at + p.error }
      if (p.key && tree.get(p.key) != null)
        return { error: at + '하위 폴더 안에는 폴더를 만들 수 없어요 (2단계까지).' }
      tree.set('ref:' + ref, p.key)
      ops.push(p.key ? { type, ref, name, ...parentOp(p.key) } : { type, ref, name })
    } else if (type === 'move_folder') {
      const fRef = op.folderRef == null ? '' : String(op.folderRef).trim()
      const self = fRef ? 'ref:' + fRef : op.folderId == null ? '' : 'id:' + Number(op.folderId)
      if (!self || !tree.has(self)) return { error: at + '옮길 폴더를 찾지 못했어요.' }
      const p = parentKey(op)
      if (p.error) return { error: at + p.error }
      if (p.key) {
        if (p.key === self) return { error: at + '자기 자신 아래로는 넣을 수 없어요.' }
        if (tree.get(p.key) != null)
          return { error: at + '하위 폴더 아래로는 넣을 수 없어요 (2단계까지).' }
        if (kids(self) > 0)
          return { error: at + '하위 폴더가 있는 폴더는 다른 폴더 아래로 넣을 수 없어요.' }
      }
      tree.set(self, p.key)
      ops.push({
        type,
        ...(fRef ? { folderRef: fRef } : { folderId: Number(op.folderId) }),
        ...parentOp(p.key)
      })
    } else if (type === 'move_presets') {
      const ids = Array.isArray(op.presetIds) ? op.presetIds.map(Number) : []
      if (!ids.length) return { error: at + '옮길 프리셋이 없어요.' }
      const bad = ids.filter((id) => !presets.has(id))
      if (bad.length) return { error: at + '없는 프리셋 id: ' + bad.join(', ') }
      const ref = op.folderRef == null ? '' : String(op.folderRef).trim()
      if (ref) {
        if (!refs.has(ref)) return { error: at + '앞에서 만들지 않은 folderRef: ' + ref }
        ops.push({ type, presetIds: [...new Set(ids)], folderRef: ref })
      } else {
        const folderId = op.folderId == null ? null : Number(op.folderId)
        if (folderId !== null && !folders.has(folderId))
          return { error: at + '없는 폴더 id: ' + folderId }
        ops.push({ type, presetIds: [...new Set(ids)], folderId })
      }
    } else if (type === 'rename_preset') {
      const presetId = Number(op.presetId)
      const name = cleanName(op.name)
      if (!presets.has(presetId)) return { error: at + '없는 프리셋 id: ' + op.presetId }
      if (!name) return { error: at + '새 이름이 비었어요.' }
      ops.push({ type, presetId, name })
    } else if (type === 'rename_folder') {
      const folderId = Number(op.folderId)
      const name = cleanName(op.name)
      if (!folders.has(folderId)) return { error: at + '없는 폴더 id: ' + op.folderId }
      if (!name) return { error: at + '새 이름이 비었어요.' }
      ops.push({ type, folderId, name })
    } else if (type === 'set_reserve') {
      const presetId = Number(op.presetId)
      const count = Number(op.count)
      if (!presets.has(presetId)) return { error: at + '없는 프리셋 id: ' + op.presetId }
      if (!Number.isInteger(count) || count < 0 || count > 100)
        return { error: at + '예약 장수는 0~100이에요.' }
      const sceneIds = Array.isArray(op.sceneIds) ? op.sceneIds.map(Number) : []
      if (sceneIds.length) {
        const own = new Set(listScenes(presetId).map((s) => s.id))
        const bad = sceneIds.filter((id) => !own.has(id))
        if (bad.length)
          return { error: at + '이 프리셋에 없는 씬 id: ' + bad.slice(0, 10).join(', ') }
      }
      ops.push(sceneIds.length ? { type, presetId, count, sceneIds } : { type, presetId, count })
    } else {
      return { error: at + '할 수 없는 종류예요: ' + String(type) }
    }
  }
  const summary = cleanName(raw.summary) || '바꿀 내용'
  const note =
    String(raw.note ?? '')
      .trim()
      .slice(0, 200) || null
  return { plan: { summary, ops, note } }
}

function readDrafts(raw: Record<string, unknown>): AssistantDraft[] {
  const list = Array.isArray(raw.drafts) ? (raw.drafts as Record<string, unknown>[]) : []
  return list
    .map((d) => ({
      title:
        String(d.title ?? '')
          .trim()
          .slice(0, 80) || '프롬프트',
      prompt: String(d.prompt ?? '')
        .trim()
        .slice(0, 8000)
    }))
    .filter((d) => d.prompt)
    .slice(0, 6)
}

function contextLine(ctx: AssistantContext | null): string {
  if (!ctx) return ''
  const parts = ['[지금 화면] ' + ctx.view]
  if (ctx.activePreset)
    parts.push('열린 씬 프리셋 #' + ctx.activePreset.id + ' ' + ctx.activePreset.name)
  if (ctx.gpt)
    parts.push(
      'GPT 이미지 설정: 크기 ' +
        ctx.gpt.size +
        ', ' +
        ctx.gpt.count +
        '장, ' +
        ctx.gpt.model +
        (ctx.gpt.hasPrompt ? ', 입력칸에 글 있음' : ', 입력칸 비어 있음')
    )
  return parts.join(' · ')
}

type Block = { type: string; [key: string]: unknown }
type Message = { role: 'user' | 'assistant'; content: string | Block[] }

export async function askAssistant(req: {
  messages: unknown[]
  text: string
  context: AssistantContext | null
  toolResults?: { id: string; content: string }[]
}): Promise<AssistantReply> {
  const reply: AssistantReply = {
    ok: false,
    error: null,
    messages: Array.isArray(req.messages) ? [...req.messages] : [],
    text: '',
    trace: [],
    plan: null,
    drafts: [],
    pendingToolIds: [],
    cost: 0
  }
  const key = getClaudeKey()
  if (!key) return { ...reply, error: MESSAGES.NO_KEY }
  const which = model()
  const prices = ASSISTANT_PRICES[which]
  const messages = reply.messages as Message[]
  const userBlocks: Block[] = (req.toolResults || []).map((r) => ({
    type: 'tool_result',
    tool_use_id: r.id,
    content: r.content
  }))
  const line = contextLine(req.context)
  userBlocks.push({
    type: 'text',
    text: (line ? line + '\n\n' : '') + String(req.text || '').slice(0, 4000)
  })
  messages.push({ role: 'user', content: userBlocks })

  const g = guide()
  const title = userTitle()
  const system: Block[] = [{ type: 'text', text: addressed(SYSTEM, title) }]
  if (g)
    system.push({
      type: 'text',
      text: addressed('## 작업 지침 ({user}가 넣은 문서)\n\n', title) + g
    })
  system[system.length - 1].cache_control = { type: 'ephemeral' }

  try {
    let finished = false
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const response: ClaudeResponse = await claudeMessage(key, {
        model: ASSISTANT_MODELS[which].id,
        max_tokens: 4000,
        system,
        tools: addressedTools(title),
        messages
      })
      const u = response.usage || {}
      reply.cost +=
        ((u.input_tokens || 0) * prices.input +
          (u.output_tokens || 0) * prices.output +
          (u.cache_read_input_tokens || 0) * prices.cacheRead +
          (u.cache_creation_input_tokens || 0) * prices.cacheWrite) /
        1_000_000
      if (response.stop_reason === 'refusal') throw new ClaudeError('REFUSED')
      const content = (response.content || []) as Block[]
      messages.push({ role: 'assistant', content })
      const texts = content
        .filter((b) => b.type === 'text')
        .map((b) => String(b.text || '').trim())
        .filter(Boolean)
      if (texts.length) reply.text = texts.join('\n\n')
      const calls = content.filter((b) => b.type === 'tool_use') as (Block & {
        id: string
        name: string
        input: Record<string, unknown>
      })[]
      if (!calls.length) {
        finished = true
        break
      }

      const terminal = calls.find((c) => TERMINAL.has(c.name))
      if (terminal) {
        let problem: string | null = null
        if (terminal.name === 'propose_changes') {
          const checked = checkPlan(terminal.input || {})
          if ('error' in checked) problem = checked.error
          else reply.plan = checked.plan
        } else {
          reply.drafts = readDrafts(terminal.input || {})
          if (!reply.drafts.length) problem = '프롬프트가 비었어요.'
        }
        if (!problem) {
          // 다른 읽기 도구 호출이 같이 왔으면 그건 건너뛴 것으로 함께 답한다
          reply.pendingToolIds = calls.map((c) => c.id)
          finished = true
          break
        }
        messages.push({
          role: 'user',
          content: calls.map((c) => ({
            type: 'tool_result',
            tool_use_id: c.id,
            is_error: c === terminal,
            content:
              c === terminal
                ? '계획이 앱과 맞지 않아요: ' + problem + ' 고쳐서 다시 내 주세요.'
                : '건너뜀'
          }))
        })
        reply.plan = null
        reply.drafts = []
        continue
      }
      const results: Block[] = []
      for (const call of calls) {
        const result = runReadTool(call.name, call.input || {})
        reply.trace.push(toolTrace(call.name, result))
        results.push({ type: 'tool_result', tool_use_id: call.id, content: JSON.stringify(result) })
      }
      messages.push({ role: 'user', content: results })
    }
    if (!finished)
      return {
        ...reply,
        ok: false,
        messages: req.messages,
        error: '일이 너무 길어졌어요. 조금 더 짧게 나눠서 말해 주세요.'
      }
    reply.ok = true
    if (!reply.text && !reply.plan && !reply.drafts.length)
      reply.text = '음… 답을 정리하지 못했어요. 한 번만 더 말해 주세요.'
    return reply
  } catch (error) {
    const code = error instanceof ClaudeError ? error.code : 'SERVER'
    // 실패한 질문은 대화에서 뺀다 (다음 질문 때 짝이 안 맞는 대화를 보내지 않게)
    return { ...reply, ok: false, messages: req.messages, error: MESSAGES[code] || MESSAGES.SERVER }
  }
}
