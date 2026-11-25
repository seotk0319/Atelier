import { create } from 'zustand'
import type {
  AssistantContext,
  AssistantDraft,
  AssistantOp,
  AssistantPlan,
  AssistantStatus
} from '@shared/assistant'
import { useGptStore } from './gpt-store'
import { useLayoutStore } from './layout-store'
import { useScenesStore } from './scenes-store'
import { canonicalize, toOrderEntries } from '../lib/folder-list'
import { folderPath, orderFolders } from '../lib/preset-tree'
import { toast } from './toast-store'

/**
 * AI 비서(명령 바). 대화는 본체가 돌려준 Claude 형식 그대로 들고 있다가 다음 질문에 다시 보낸다.
 * 계획은 여기서 실행하고(기존 씬 프리셋 동작을 그대로 씀), 되돌리기 정보도 여기서 들고 있다.
 */

export type PlanState = 'ready' | 'running' | 'done' | 'failed' | 'cancelled' | 'undone'

/** 계획 한 단계를 화면에 보일 글. 계획이 온 순간의 이름으로 만들어 두어, 실행 뒤에도 바뀌지 않는다. */
export interface PlanRow {
  kind: 'folder' | 'move' | 'rename' | 'reserve'
  lead: string
  strong: string
  tail: string
  names: string[]
}

type Undo =
  | { t: 'deleteFolder'; id: number }
  | { t: 'move'; groups: { folderId: number | null; ids: number[] }[] }
  | { t: 'renamePreset'; id: number; name: string }
  | { t: 'renameFolder'; id: number; name: string }
  | { t: 'folderParent'; id: number; parentId: number | null }
  | { t: 'reserve'; presetId: number; prev: { id: number; count: number }[] }
  | { t: 'prompt'; prompt: string }
  /** 실행 전 폴더·프리셋 순서. 되돌리기 끝에 순서까지 되살린다 */
  | { t: 'order'; folderIds: number[]; presetIds: number[] }

export type AssistantItem =
  | { id: number; kind: 'user'; text: string }
  | { id: number; kind: 'error'; text: string }
  | {
      id: number
      kind: 'ai'
      text: string
      trace: string[]
      plan: AssistantPlan | null
      rows: PlanRow[]
      planState: PlanState
      result: string | null
      drafts: AssistantDraft[]
      /** 입력칸에 넣은 시안 번호 */
      inserted: number | null
      cost: number
    }

interface AssistantState {
  status: AssistantStatus | null
  open: boolean
  /** 실행이 끝나 결과 한 줄로 접힌 상태 */
  minimized: boolean
  busy: boolean
  items: AssistantItem[]
  messages: unknown[]
  /** 답을 기다리는 도구 호출과 그 결과 (다음 질문 앞에 붙인다) */
  pending: { ids: string[]; result: string } | null
  undo: Record<number, Undo[]>
  focusTick: number
  loadStatus: () => Promise<void>
  setOpen: (open: boolean) => void
  toggle: () => void
  expand: () => void
  reset: () => void
  ask: (text: string) => Promise<void>
  run: (itemId: number) => Promise<void>
  cancel: (itemId: number) => void
  revert: (itemId: number) => Promise<void>
  insertDraft: (itemId: number, index: number) => void
}

let seq = 0
const nextId = (): number => ++seq
/** 「새 대화」마다 1씩 — 답을 기다리는 사이 새 대화를 열면 옛 답(대화 기록·실행 계획)을 새 대화에 넣지 않는다 */
let conversation = 0

const VIEW_LABELS: Record<string, string> = {
  main: '생성',
  scene: '씬',
  curation: '선별',
  director: '디렉터',
  library: '라이브러리',
  gpt: 'GPT 이미지',
  cover: '표지',
  inbox: '알림'
}
export const viewLabel = (mode: string): string => VIEW_LABELS[mode] ?? mode

function context(): AssistantContext {
  const view = useLayoutStore.getState().centerMode
  const scenes = useScenesStore.getState()
  const preset = scenes.presets.find((p) => p.id === scenes.activePresetId)
  const gpt = useGptStore.getState()
  return {
    view: viewLabel(view),
    activePreset: preset ? { id: preset.id, name: preset.name } : null,
    gpt: { size: gpt.size, count: gpt.count, model: gpt.model, hasPrompt: !!gpt.prompt.trim() }
  }
}

function describe(plan: AssistantPlan | null): PlanRow[] {
  if (!plan) return []
  const s = useScenesStore.getState()
  const presetName = (id: number): string => s.presets.find((p) => p.id === id)?.name ?? '#' + id
  const folderName = (id: number | null | undefined): string =>
    id == null ? '폴더 밖' : folderPath(s.presetFolders, id) || '#' + id
  const refNames = new Map<string, string>()
  return plan.ops.map((op): PlanRow => {
    if (op.type === 'create_folder') {
      refNames.set(op.ref, op.name)
      const parent = op.parentRef
        ? (refNames.get(op.parentRef) ?? op.parentRef)
        : op.parentId != null
          ? folderName(op.parentId)
          : ''
      return {
        kind: 'folder',
        lead: '새 폴더',
        strong: op.name,
        tail: parent ? '(' + parent + ' 아래)' : '',
        names: []
      }
    }
    if (op.type === 'move_folder') {
      const name = op.folderRef
        ? (refNames.get(op.folderRef) ?? op.folderRef)
        : folderName(op.folderId)
      const parent = op.parentRef
        ? (refNames.get(op.parentRef) ?? op.parentRef)
        : op.parentId != null
          ? folderName(op.parentId)
          : null
      return {
        kind: 'move',
        lead: '폴더 ' + name + ' →',
        strong: parent ?? '맨 위 단계',
        tail: parent ? '아래로' : '로',
        names: []
      }
    }
    if (op.type === 'move_presets')
      return {
        kind: 'move',
        lead: '프리셋',
        strong: op.presetIds.length + '개',
        tail:
          '→ ' +
          (op.folderRef ? (refNames.get(op.folderRef) ?? op.folderRef) : folderName(op.folderId)),
        names: op.presetIds.map(presetName)
      }
    if (op.type === 'rename_preset')
      return {
        kind: 'rename',
        lead: presetName(op.presetId) + ' →',
        strong: op.name,
        tail: '',
        names: []
      }
    if (op.type === 'rename_folder')
      return {
        kind: 'rename',
        lead: '폴더 ' + folderName(op.folderId) + ' →',
        strong: op.name,
        tail: '',
        names: []
      }
    return {
      kind: 'reserve',
      lead: presetName(op.presetId),
      strong: (op.sceneIds ? '씬 ' + op.sceneIds.length + '개' : '씬마다') + ' ' + op.count + '장',
      tail: '예약',
      names: []
    }
  })
}

function patchItem(itemId: number, patch: Partial<Extract<AssistantItem, { kind: 'ai' }>>): void {
  useAssistantStore.setState((s) => ({
    items: s.items.map((it) => (it.id === itemId && it.kind === 'ai' ? { ...it, ...patch } : it))
  }))
}

async function execute(plan: AssistantPlan, undo: Undo[]): Promise<string> {
  const scenes = (): ReturnType<typeof useScenesStore.getState> => useScenesStore.getState()
  const refs = new Map<string, number>()
  let folders = 0
  let moved = 0
  let renamed = 0
  let nested = 0
  let reserved = 0
  const touchedReserve = new Set<number>()
  {
    const s = scenes()
    undo.push({
      t: 'order',
      folderIds: s.presetFolders.map((f) => f.id),
      presetIds: s.presets.map((p) => p.id)
    })
  }
  for (const op of plan.ops) {
    if (op.type === 'create_folder') {
      const parent = op.parentRef ? refs.get(op.parentRef) : (op.parentId ?? null)
      if (parent === undefined) throw new Error('상위 폴더를 찾지 못했어요: ' + op.parentRef)
      const id = await scenes().createPresetFolder(op.name, parent)
      refs.set(op.ref, id)
      undo.push({ t: 'deleteFolder', id })
      folders++
    } else if (op.type === 'move_folder') {
      const id = op.folderRef ? refs.get(op.folderRef) : op.folderId
      const parent = op.parentRef ? refs.get(op.parentRef) : (op.parentId ?? null)
      if (id == null || parent === undefined) throw new Error('폴더를 찾지 못했어요')
      const prev = scenes().presetFolders.find((f) => f.id === id)?.parentId ?? null
      const result = await scenes().setPresetFolderParent(id, parent)
      if (!result.ok) throw new Error(result.message)
      undo.push({ t: 'folderParent', id, parentId: prev })
      nested++
    } else if (op.type === 'move_presets') {
      const target = op.folderRef ? refs.get(op.folderRef) : (op.folderId ?? null)
      if (target === undefined) throw new Error('폴더를 찾지 못했어요: ' + op.folderRef)
      const before = new Map<number | null, number[]>()
      for (const id of op.presetIds) {
        const p = scenes().presets.find((x) => x.id === id)
        if (!p) continue
        before.set(p.folderId, [...(before.get(p.folderId) ?? []), id])
      }
      await scenes().movePresetsToFolder(op.presetIds, target)
      undo.push({ t: 'move', groups: [...before].map(([folderId, ids]) => ({ folderId, ids })) })
      moved += op.presetIds.length
    } else if (op.type === 'rename_preset') {
      const prev = scenes().presets.find((p) => p.id === op.presetId)?.name ?? ''
      await scenes().renamePreset(op.presetId, op.name)
      undo.push({ t: 'renamePreset', id: op.presetId, name: prev })
      renamed++
    } else if (op.type === 'rename_folder') {
      const prev = scenes().presetFolders.find((f) => f.id === op.folderId)?.name ?? ''
      await scenes().renamePresetFolder(op.folderId, op.name)
      undo.push({ t: 'renameFolder', id: op.folderId, name: prev })
      renamed++
    } else if (op.type === 'set_reserve') {
      const { items } = await window.nais.invoke('scenes:list', { presetId: op.presetId })
      const only = op.sceneIds ? new Set(op.sceneIds) : null
      const prev = items
        .filter((s) => (!only || only.has(s.id)) && s.reserveCount !== op.count)
        .map((s) => ({ id: s.id, count: s.reserveCount }))
      await window.nais.invoke('scenes:setReserveAll', {
        presetId: op.presetId,
        count: op.count,
        ...(op.sceneIds ? { ids: op.sceneIds } : {})
      })
      undo.push({ t: 'reserve', presetId: op.presetId, prev })
      touchedReserve.add(op.presetId)
      reserved += only ? only.size : items.length
    }
  }
  await scenes().loadPresets(touchedReserve.has(scenes().activePresetId))
  if (touchedReserve.size) await scenes().refreshReservedTotal()
  // [이어 쓸 때, 끝낼 때]
  const parts: [string, string][] = []
  if (folders)
    parts.push(['폴더 ' + folders + '개를 만들고', '폴더 ' + folders + '개를 만들었어요'])
  if (moved) parts.push(['프리셋 ' + moved + '개를 옮기고', '프리셋 ' + moved + '개를 옮겼어요'])
  if (renamed) parts.push(['이름 ' + renamed + '개를 바꾸고', '이름 ' + renamed + '개를 바꿨어요'])
  if (nested) parts.push(['폴더 ' + nested + '개를 옮기고', '폴더 ' + nested + '개를 옮겼어요'])
  if (reserved)
    parts.push(['씬 ' + reserved + '개의 예약을 정하고', '씬 ' + reserved + '개의 예약을 정했어요'])
  if (!parts.length) return '바꿀 것이 없었어요'
  return parts.map((p, i) => (i === parts.length - 1 ? p[1] : p[0])).join(' ')
}

async function applyUndo(steps: Undo[]): Promise<void> {
  const scenes = (): ReturnType<typeof useScenesStore.getState> => useScenesStore.getState()
  const touched = new Set<number>()
  for (const step of [...steps].reverse()) {
    if (step.t === 'move') {
      for (const g of step.groups) await scenes().movePresetsToFolder(g.ids, g.folderId)
    } else if (step.t === 'renamePreset') {
      await scenes().renamePreset(step.id, step.name)
    } else if (step.t === 'renameFolder') {
      await scenes().renamePresetFolder(step.id, step.name)
    } else if (step.t === 'folderParent') {
      await scenes().setPresetFolderParent(step.id, step.parentId)
    } else if (step.t === 'deleteFolder') {
      await scenes().deletePresetFolder(step.id)
    } else if (step.t === 'reserve') {
      for (const s of step.prev)
        await window.nais.invoke('scenes:update', { id: s.id, patch: { reserveCount: s.count } })
      touched.add(step.presetId)
    } else if (step.t === 'prompt') {
      useGptStore.getState().setForm({ prompt: step.prompt })
    } else if (step.t === 'order') {
      // 남은 폴더·프리셋을 실행 전 순서대로 다시 줄 세운다 (소속은 이미 되돌린 그대로)
      await scenes().loadPresets(false)
      const s = scenes()
      const rank = (ids: number[], id: number): number => {
        const i = ids.indexOf(id)
        return i < 0 ? ids.length : i
      }
      const folders = orderFolders(
        [...s.presetFolders].sort((a, b) => rank(step.folderIds, a.id) - rank(step.folderIds, b.id))
      )
      const presets = canonicalize(
        folders,
        [...s.presets].sort((a, b) => rank(step.presetIds, a.id) - rank(step.presetIds, b.id))
      )
      useScenesStore.setState({ presetFolders: folders, presets })
      await window.nais.invoke('scenePresets:reorderTree', {
        order: toOrderEntries(folders, presets)
      })
    }
  }
  await scenes().loadPresets(touched.has(scenes().activePresetId))
  if (touched.size) await scenes().refreshReservedTotal()
}

export const useAssistantStore = create<AssistantState>((set, get) => ({
  status: null,
  open: false,
  minimized: false,
  busy: false,
  items: [],
  messages: [],
  pending: null,
  undo: {},
  focusTick: 0,

  loadStatus: async () => {
    try {
      set({ status: await window.nais.invoke('assistant:status', undefined) })
    } catch {
      // 본체가 아직 준비되지 않았으면 다음에 다시 읽는다
    }
  },
  setOpen: (open) => {
    set({ open, focusTick: open ? get().focusTick + 1 : get().focusTick })
    // 열 때마다 키·지침 상태를 다시 읽는다 (다른 곳에서 키를 넣었을 수 있다)
    if (open) void get().loadStatus()
  },
  toggle: () => get().setOpen(!get().open),
  expand: () => set({ minimized: false, open: true }),
  reset: () => {
    conversation++
    set({
      items: [],
      messages: [],
      pending: null,
      undo: {},
      minimized: false,
      focusTick: get().focusTick + 1
    })
  },

  ask: async (raw) => {
    const text = raw.trim()
    if (!text || get().busy) return
    const conv = conversation
    const pending = get().pending
    set({
      busy: true,
      minimized: false,
      items: [...get().items, { id: nextId(), kind: 'user', text }]
    })
    if (!useScenesStore.getState().presets.length)
      await useScenesStore.getState().loadPresets(false)
    try {
      const reply = await window.nais.invoke('assistant:ask', {
        messages: get().messages,
        text,
        context: context(),
        toolResults: pending ? pending.ids.map((id) => ({ id, content: pending.result })) : []
      })
      if (conv !== conversation) return
      if (!reply.ok) {
        set({
          items: [
            ...get().items,
            { id: nextId(), kind: 'error', text: reply.error || '답을 받지 못했어요.' }
          ]
        })
        return
      }
      set({
        messages: reply.messages,
        pending: reply.pendingToolIds.length
          ? {
              ids: reply.pendingToolIds,
              result: reply.plan
                ? '아빠가 아직 실행하지 않았어요.'
                : '카드를 보여 줬어요. 아직 입력칸에 넣지 않았어요.'
            }
          : null,
        items: [
          ...get().items,
          {
            id: nextId(),
            kind: 'ai',
            text: reply.text,
            trace: reply.trace,
            plan: reply.plan,
            rows: describe(reply.plan),
            planState: 'ready',
            result: null,
            drafts: reply.drafts,
            inserted: null,
            cost: reply.cost
          }
        ]
      })
    } catch {
      if (conv !== conversation) return
      set({
        items: [
          ...get().items,
          { id: nextId(), kind: 'error', text: '본체와 연결이 끊겼어요. 다시 말해 주세요.' }
        ]
      })
    } finally {
      set({ busy: false })
    }
  },

  run: async (itemId) => {
    const item = get().items.find((it) => it.id === itemId)
    if (!item || item.kind !== 'ai' || !item.plan || item.planState !== 'ready') return
    patchItem(itemId, { planState: 'running' })
    const undo: Undo[] = []
    try {
      const result = await execute(item.plan, undo)
      set({ undo: { ...get().undo, [itemId]: undo }, minimized: true })
      patchItem(itemId, { planState: 'done', result })
      if (get().pending) set({ pending: { ...get().pending!, result: '실행했어요: ' + result } })
    } catch (error) {
      set({ undo: { ...get().undo, [itemId]: undo } })
      const message = error instanceof Error ? error.message : String(error)
      patchItem(itemId, { planState: 'failed', result: '하다가 멈췄어요: ' + message })
      if (get().pending)
        set({ pending: { ...get().pending!, result: '실행하다 멈췄어요: ' + message } })
    }
  },

  cancel: (itemId) => {
    patchItem(itemId, { planState: 'cancelled' })
    if (get().pending)
      set({ pending: { ...get().pending!, result: '아빠가 이 계획을 취소했어요.' } })
  },

  revert: async (itemId) => {
    const steps = get().undo[itemId]
    if (!steps) return
    try {
      await applyUndo(steps)
      const rest = { ...get().undo }
      delete rest[itemId]
      set({ undo: rest })
      const item = get().items.find((it) => it.id === itemId)
      if (item?.kind === 'ai' && item.drafts.length && !item.plan)
        patchItem(itemId, { inserted: null })
      else patchItem(itemId, { planState: 'undone', result: '되돌렸어요' })
      if (get().pending) set({ pending: { ...get().pending!, result: '아빠가 되돌렸어요.' } })
      toast('되돌렸어요', 'success')
    } catch {
      toast('되돌리다 멈췄어요. 씬 프리셋 목록을 확인해 주세요.', 'error')
    }
  },

  insertDraft: (itemId, index) => {
    const item = get().items.find((it) => it.id === itemId)
    if (!item || item.kind !== 'ai' || !item.drafts[index]) return
    const gpt = useGptStore.getState()
    const prev = get().undo[itemId]
    // 처음 넣기 전의 입력칸 내용을 되돌리기 값으로 둔다
    const original =
      prev?.[0]?.t === 'prompt' ? prev : [{ t: 'prompt', prompt: gpt.prompt } as Undo]
    gpt.setForm({ prompt: item.drafts[index].prompt })
    useLayoutStore.getState().setCenterMode('gpt')
    set({ undo: { ...get().undo, [itemId]: original }, minimized: true })
    patchItem(itemId, { inserted: index })
    if (get().pending)
      set({
        pending: {
          ...get().pending!,
          result: '아빠가 "' + item.drafts[index].title + '"을(를) GPT 입력칸에 넣었어요.'
        }
      })
  }
}))

/** Ctrl+K: 명령 바 열고 닫기 */
export function bindAssistantKeys(): () => void {
  const onKey = (e: KeyboardEvent): void => {
    if (e.defaultPrevented || e.altKey || e.shiftKey) return
    if (!(e.ctrlKey || e.metaKey) || (e.key !== 'k' && e.key !== 'K')) return
    e.preventDefault()
    useAssistantStore.getState().toggle()
  }
  window.addEventListener('keydown', onKey)
  return () => window.removeEventListener('keydown', onKey)
}

export type { AssistantOp }
