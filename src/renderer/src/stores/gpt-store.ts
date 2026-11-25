import { create } from 'zustand'
import { GPT_STARTER_PRESETS } from '@shared/gpt'
import type {
  GptAuthStatus,
  GptJob,
  GptModel,
  GptPreset,
  GptPromptMode,
  GptQuality,
  GptRef,
  GptRequest,
  GptSize
} from '@shared/gpt'
import type { HistoryItem } from '@shared/types'
import { useLayoutStore } from './layout-store'
import { toast } from './toast-store'

export interface GptRefItem extends GptRef {
  key: string
}

/** 고칠 그림. 칠하기 창에 원본 크기가 필요해서 크기도 들고 있다 */
export interface GptEditItem extends GptRef {
  width: number
  height: number
  /** 칠한 곳=흰색 PNG */
  maskB64?: string
}

interface Form {
  prompt: string
  size: GptSize
  quality: GptQuality
  model: GptModel
  mode: GptPromptMode
  count: number
}

interface GptState extends Form {
  status: GptAuthStatus | null
  jobs: GptJob[]
  images: HistoryItem[]
  total: number
  refs: GptRefItem[]
  edit: GptEditItem | null
  presets: GptPreset[]
  /** 실패한 장을 다시 보낼 때 쓰는 원래 요청 */
  requests: Record<string, GptRequest>
  setForm: (patch: Partial<Form>) => void
  addRefs: (refs: GptRef[]) => void
  removeRef: (key: string) => void
  clearRefs: () => void
  /** 이 그림을 고칠 그림으로 (마스크는 지운다) */
  setEdit: (ref: GptRef | null) => Promise<void>
  setMask: (maskB64: string | undefined) => void
  loadPresets: () => Promise<void>
  savePreset: (name: string, text: string) => void
  removePreset: (id: string) => void
  /** 프롬프트 칸 끝에 프리셋 문장을 이어 붙인다 */
  applyPreset: (preset: GptPreset) => void
  checkStatus: () => Promise<void>
  loadImages: (more?: boolean) => Promise<void>
  generate: () => Promise<void>
  retry: (jobId: string) => Promise<void>
  cancel: (jobId: string) => void
  clearFinished: () => void
}

const FORM_KEY = 'gpt_form'
const DEFAULT_FORM: Form = {
  prompt: '',
  size: 'auto',
  quality: 'auto',
  model: 'gpt-5.6-luna',
  mode: 'direct',
  count: 1
}

function loadForm(): Form {
  try {
    return {
      ...DEFAULT_FORM,
      ...(JSON.parse(localStorage.getItem(FORM_KEY) ?? '{}') as Partial<Form>)
    }
  } catch {
    return DEFAULT_FORM
  }
}

const PAGE = 60

function message(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e)
  return m.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

let imagesSeq = 0
let loadingMore = false

export const useGptStore = create<GptState>((set, get) => ({
  ...loadForm(),
  status: null,
  jobs: [],
  images: [],
  total: 0,
  refs: [],
  edit: null,
  presets: [],
  requests: {},
  setForm: (patch) => {
    set(patch)
    const { prompt, size, quality, model, mode, count } = { ...get(), ...patch }
    localStorage.setItem(FORM_KEY, JSON.stringify({ prompt, size, quality, model, mode, count }))
  },
  addRefs: (refs) =>
    set({
      refs: [
        ...get().refs,
        ...refs.map((r) => ({ ...r, key: Math.random().toString(36).slice(2) }))
      ].slice(0, 16)
    }),
  removeRef: (key) => set({ refs: get().refs.filter((r) => r.key !== key) }),
  clearRefs: () => set({ refs: [] }),
  setEdit: async (ref) => {
    if (!ref) return set({ edit: null })
    const size = await imageSize(ref)
    if (!size) {
      toast('그림을 읽지 못했어요', 'error')
      return
    }
    set({ edit: { b64: ref.b64, mime: ref.mime, name: ref.name, ...size } })
  },
  setMask: (maskB64) => {
    const edit = get().edit
    if (edit) set({ edit: { ...edit, maskB64 } })
  },
  loadPresets: async () => {
    const { value } = await window.nais.invoke('settings:get', { key: 'gpt_presets' })
    let presets = GPT_STARTER_PRESETS
    try {
      if (value) presets = JSON.parse(value) as GptPreset[]
    } catch {
      // 손상된 값이면 예시로
    }
    set({ presets })
  },
  savePreset: (name, text) => {
    const trimmed = text.trim()
    if (!trimmed) return
    const presets = [
      ...get().presets,
      {
        id: Math.random().toString(36).slice(2),
        name: name.trim() || trimmed.slice(0, 12),
        text: trimmed
      }
    ]
    set({ presets })
    void window.nais.invoke('settings:set', { key: 'gpt_presets', value: JSON.stringify(presets) })
  },
  removePreset: (id) => {
    const presets = get().presets.filter((p) => p.id !== id)
    set({ presets })
    void window.nais.invoke('settings:set', { key: 'gpt_presets', value: JSON.stringify(presets) })
  },
  applyPreset: (preset) => {
    const prompt = get().prompt.trimEnd()
    get().setForm({ prompt: prompt ? prompt + '\n' + preset.text : preset.text })
  },
  checkStatus: async () => {
    set({ status: await window.nais.invoke('gpt:status', undefined) })
  },
  loadImages: async (more = false) => {
    // 스크롤 끝에서는 onScroll이 연달아 불려 같은 쪽이 여러 번 붙었다 — 더 읽기는 한 번에 하나만,
    // 처음부터 다시 읽으면(새 그림 완료) 그 전에 나간 응답은 버린다
    if (more && loadingMore) return
    const seq = more ? imagesSeq : ++imagesSeq
    if (more) loadingMore = true
    try {
      const offset = more ? get().images.length : 0
      const { items, total } = await window.nais.invoke('gpt:images', { limit: PAGE, offset })
      if (seq !== imagesSeq) return
      if (!more) return set({ images: items, total })
      const have = new Set(get().images.map((i) => i.id))
      set({ images: [...get().images, ...items.filter((i) => !have.has(i.id))], total })
    } finally {
      if (more) loadingMore = false
    }
  },
  generate: async () => {
    const s = get()
    if (!s.prompt.trim()) {
      toast('무엇을 그릴지 적어 주세요', 'info')
      return
    }
    const request: GptRequest = {
      prompt: s.prompt,
      refs: s.refs.map(({ b64, mime, name }) => ({ b64, mime, name })),
      size: s.size,
      quality: s.quality,
      model: s.model,
      mode: s.mode,
      ...(s.edit
        ? {
            edit: { b64: s.edit.b64, mime: s.edit.mime, name: s.edit.name, maskB64: s.edit.maskB64 }
          }
        : {})
    }
    try {
      const { ids } = await window.nais.invoke('gpt:generate', { request, count: s.count })
      const requests = { ...get().requests }
      for (const id of ids) requests[id] = request
      set({ requests })
    } catch (e) {
      toast(message(e), 'error')
    }
  },
  retry: async (jobId) => {
    const request = get().requests[jobId]
    if (!request) return
    try {
      const { ids } = await window.nais.invoke('gpt:generate', { request, count: 1 })
      set({ requests: { ...get().requests, [ids[0]]: request } })
    } catch (e) {
      toast(message(e), 'error')
    }
  },
  cancel: (jobId) => void window.nais.invoke('gpt:cancel', { id: jobId }),
  clearFinished: () => void window.nais.invoke('gpt:clearFinished', undefined)
}))

let bound = false
export function bindGptEvents(): () => void {
  if (bound) return () => undefined
  bound = true
  const off = window.nais.on('gpt:changed', ({ jobs }) => {
    const prev = new Map(useGptStore.getState().jobs.map((j) => [j.id, j.state]))
    useGptStore.setState({ jobs })
    const newlyDone = jobs.some((j) => j.state === 'done' && prev.get(j.id) !== 'done')
    const newlyFailed = jobs.filter((j) => j.state === 'failed' && prev.get(j.id) !== 'failed')
    if (newlyDone) void useGptStore.getState().loadImages()
    if (newlyFailed.length === 1) toast(newlyFailed[0].error ?? 'GPT 생성 실패', 'error')
    else if (newlyFailed.length > 1) toast(newlyFailed.length + '장 생성 실패', 'error')
  })
  return () => {
    bound = false
    off()
  }
}

/** 파일·붙여넣기 이미지를 레퍼런스로 */
export async function fileToRef(file: File): Promise<GptRef | null> {
  if (!file.type.startsWith('image/')) return null
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(r.error)
    r.readAsDataURL(file)
  })
  const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
  return { b64, mime: file.type, name: file.name }
}

/** 앱 안 이미지 경로를 레퍼런스로 */
export async function pathToRef(filePath: string): Promise<GptRef | null> {
  const res = await window.nais.invoke('images:readForSource', { filePath })
  if (!('base64' in res)) return null
  const ext = filePath.toLowerCase().split('.').pop()
  const mime =
    ext === 'webp' ? 'image/webp' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'image/png'
  return { b64: res.base64, mime, name: filePath.split(/[\\/]/).pop() }
}

/** 그림의 원본 크기 (칠하기 창용) */
function imageSize(ref: GptRef): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight })
    img.onerror = () => resolve(null)
    img.src = 'data:' + ref.mime + ';base64,' + ref.b64
  })
}

/** 다른 탭(메인·씬·라이브러리 등)의 그림을 GPT 이미지로 보낸다: 고칠 그림 또는 레퍼런스 */
export async function sendToGpt(filePath: string, as: 'edit' | 'ref'): Promise<void> {
  const ref = await pathToRef(filePath)
  if (!ref) {
    toast('이미지를 읽지 못했어요', 'error')
    return
  }
  const st = useGptStore.getState()
  if (as === 'edit') await st.setEdit(ref)
  else st.addRefs([ref])
  useLayoutStore.getState().setCenterMode('gpt')
  toast(as === 'edit' ? '고칠 그림으로 넣었어요' : '레퍼런스로 넣었어요', 'success')
}
