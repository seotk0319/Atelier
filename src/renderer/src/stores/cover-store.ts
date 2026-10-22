import { create } from 'zustand'
import type { CoverKind, CoverProject, CoverProjectSummary, CoverSelection } from '@shared/cover'
import * as censor from '../components/cover/engine/censor'
import { forgetBitmap } from '../components/cover/engine/render'
import {
  addImageFiles,
  addImagePaths,
  flushBlobDeletes,
  moveItem,
  removeItem,
  reorderItem
} from '../components/cover/engine/state'
import type {
  CoverBrushPrefs,
  CoverEditorApi,
  CoverHistoryState,
  CoverMode
} from '../components/cover/engine/types'
import { useLayoutStore } from './layout-store'
import { toast } from './toast-store'

/**
 * 표지 탭 상태. 프로젝트 객체는 엔진(편집기·합성)이 제자리에서 고치므로
 * 화면은 rev 숫자로 바뀜을 알아챈다. 저장은 300ms 디바운스.
 */

const BRUSH_KEY = 'nais3.cover.brush'
const LAST_KEY = 'nais3.cover.lastProject'
const DEFAULT_BRUSH: CoverBrushPrefs = {
  size: 60,
  softness: 30,
  opacity: 100,
  color: '#ffffff',
  erase: false
}

function loadBrush(): CoverBrushPrefs {
  try {
    const v = JSON.parse(localStorage.getItem(BRUSH_KEY) ?? 'null') as Partial<CoverBrushPrefs>
    if (!v || typeof v !== 'object') return DEFAULT_BRUSH
    const num = (x: unknown, lo: number, hi: number, d: number): number =>
      typeof x === 'number' && Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d
    return {
      size: num(v.size, 5, 400, DEFAULT_BRUSH.size),
      softness: num(v.softness, 0, 100, DEFAULT_BRUSH.softness),
      opacity: num(v.opacity, 10, 100, DEFAULT_BRUSH.opacity),
      color: typeof v.color === 'string' ? v.color : DEFAULT_BRUSH.color,
      erase: Boolean(v.erase)
    }
  } catch {
    return DEFAULT_BRUSH
  }
}

export type CoverSaveState = 'idle' | 'saving' | 'saved' | 'error'

interface CoverState {
  ready: boolean
  projects: CoverProjectSummary[]
  project: CoverProject | null
  /** 프로젝트가 바뀔 때마다 1씩 오른다 (화면 갱신 신호) */
  rev: number
  mode: CoverMode
  brush: CoverBrushPrefs
  history: CoverHistoryState
  saveState: CoverSaveState
  outputDir: string | null
  /** 가져오는 중인 이미지 수 (재료 패널 표시용) */
  importing: number
  /** 편집기 인스턴스 (cover-view 가 등록) */
  editor: CoverEditorApi | null

  init: () => Promise<void>
  openProject: (id: string) => Promise<void>
  createProject: (name?: string) => Promise<void>
  renameProject: (name: string) => void
  deleteProject: (id: string) => Promise<void>
  /** 프로젝트를 고치고 저장 예약. redraw 면 편집기를 다시 그림 */
  mutate: (fn: (p: CoverProject) => void, opts?: { redraw?: boolean }) => void
  /** 엔진이 이미 고친 뒤 알려 줄 때 (편집기 onChange) */
  touch: () => void
  select: (patch: Partial<CoverSelection>) => void
  setMode: (mode: CoverMode) => void
  setBrush: (patch: Partial<CoverBrushPrefs>) => void
  setHistory: (h: CoverHistoryState) => void
  setEditor: (e: CoverEditorApi | null) => void
  addFiles: (kind: CoverKind, files: File[]) => Promise<void>
  /** 넣은 장수를 돌려준다 */
  addPaths: (kind: CoverKind, paths: string[]) => Promise<number>
  removeItem: (kind: CoverKind, id: string) => void
  moveItem: (kind: CoverKind, id: string, delta: number) => void
  reorderItem: (kind: CoverKind, id: string, toIndex: number) => void
  renameItem: (kind: CoverKind, id: string, name: string) => void
  refreshOutputDir: () => Promise<void>
  pickOutputDir: () => Promise<string | null>
  /** 대기 중인 저장을 바로 실행 */
  flush: () => Promise<void>
}

let saveTimer: number | null = null
let initPromise: Promise<void> | null = null

export const useCoverStore = create<CoverState>((set, get) => {
  const save = async (): Promise<void> => {
    if (saveTimer !== null) {
      window.clearTimeout(saveTimer)
      saveTimer = null
    }
    const p = get().project
    if (!p) return
    set({ saveState: 'saving' })
    const res = await window.nais.invoke('cover:save', { project: p })
    if ('error' in res) {
      set({ saveState: 'error' })
      toast('표지를 저장하지 못했어요: ' + res.error, 'error')
      return
    }
    p.updatedAt = res.updatedAt
    flushBlobDeletes(p)
    set((s) => ({
      saveState: 'saved',
      projects: s.projects
        .map((it) =>
          it.id === p.id
            ? {
                ...it,
                name: p.name,
                updatedAt: p.updatedAt,
                backgrounds: p.backgrounds.length,
                typos: p.typos.length
              }
            : it
        )
        .sort((a, b) => b.updatedAt - a.updatedAt)
    }))
  }
  const schedule = (): void => {
    if (saveTimer !== null) window.clearTimeout(saveTimer)
    saveTimer = window.setTimeout(() => void save(), 300)
  }
  const bump = (redraw = false): void => {
    set((s) => ({ rev: s.rev + 1 }))
    schedule()
    if (redraw) void get().editor?.refresh()
  }
  const setProject = (p: CoverProject | null): void => {
    censor.closeAll()
    if (p && !p.selection.bgId && p.backgrounds[0]) p.selection.bgId = p.backgrounds[0].id
    if (p && !p.selection.typoId && p.typos[0]) p.selection.typoId = p.typos[0].id
    if (p) localStorage.setItem(LAST_KEY, p.id)
    set((s) => ({ project: p, rev: s.rev + 1, history: { canUndo: false, canRedo: false } }))
  }

  return {
    ready: false,
    projects: [],
    project: null,
    rev: 0,
    mode: 'typo',
    brush: loadBrush(),
    history: { canUndo: false, canRedo: false },
    saveState: 'idle',
    outputDir: null,
    importing: 0,
    editor: null,

    init: () => {
      if (initPromise) return initPromise
      initPromise = (async () => {
        const { items } = await window.nais.invoke('cover:list', undefined)
        set({ projects: items })
        void get().refreshOutputDir()
        const last = localStorage.getItem(LAST_KEY)
        const pick = items.find((it) => it.id === last) ?? items[0]
        if (pick) {
          const { project } = await window.nais.invoke('cover:load', { id: pick.id })
          if (project) {
            setProject(project)
            set({ ready: true })
            return
          }
        }
        await get().createProject('새 작품')
        set({ ready: true })
      })()
      initPromise.catch(() => {
        initPromise = null
      })
      return initPromise
    },

    openProject: async (id) => {
      if (get().project?.id === id) return
      await get().flush()
      const { project } = await window.nais.invoke('cover:load', { id })
      if (!project) {
        toast('작품을 열지 못했어요', 'error')
        return
      }
      setProject(project)
    },

    createProject: async (name = '새 작품') => {
      await get().flush()
      const { project } = await window.nais.invoke('cover:create', { name })
      set((s) => ({
        projects: [
          {
            id: project.id,
            name: project.name,
            updatedAt: project.updatedAt,
            backgrounds: 0,
            typos: 0
          },
          ...s.projects
        ]
      }))
      setProject(project)
    },

    renameProject: (name) => {
      const p = get().project
      if (!p) return
      p.name = name
      set((s) => ({ projects: s.projects.map((it) => (it.id === p.id ? { ...it, name } : it)) }))
      bump()
    },

    deleteProject: async (id) => {
      const isCurrent = get().project?.id === id
      if (isCurrent && saveTimer !== null) {
        window.clearTimeout(saveTimer)
        saveTimer = null
      }
      await window.nais.invoke('cover:delete', { id })
      const rest = get().projects.filter((it) => it.id !== id)
      set({ projects: rest })
      if (!isCurrent) return
      flushBlobDeletes(null)
      if (rest[0]) {
        const { project } = await window.nais.invoke('cover:load', { id: rest[0].id })
        if (project) return setProject(project)
      }
      await get().createProject('새 작품')
    },

    mutate: (fn, opts) => {
      const p = get().project
      if (!p) return
      fn(p)
      bump(opts?.redraw ?? true)
    },

    touch: () => bump(false),

    select: (patch) => {
      const p = get().project
      if (!p) return
      Object.assign(p.selection, patch)
      bump(false)
    },

    setMode: (mode) => set({ mode }),

    setBrush: (patch) => {
      const brush = { ...get().brush, ...patch }
      localStorage.setItem(BRUSH_KEY, JSON.stringify(brush))
      set({ brush })
    },

    setHistory: (history) => set({ history }),
    setEditor: (editor) => set({ editor }),

    addFiles: async (kind, files) => {
      const p = get().project
      if (!p || !files.length) return
      set((s) => ({ importing: s.importing + files.length }))
      try {
        const { added, failed } = await addImageFiles(p, kind, files)
        afterAdd(
          kind,
          added.map((a) => a.id),
          failed
        )
      } finally {
        set((s) => ({ importing: Math.max(0, s.importing - files.length) }))
      }
    },

    addPaths: async (kind, paths) => {
      await get().init()
      const p = get().project
      if (!p || !paths.length) return 0
      set((s) => ({ importing: s.importing + paths.length }))
      try {
        const { added, failed } = await addImagePaths(p, kind, paths)
        afterAdd(
          kind,
          added.map((a) => a.id),
          failed
        )
        return added.length
      } finally {
        set((s) => ({ importing: Math.max(0, s.importing - paths.length) }))
      }
    },

    removeItem: (kind, id) => {
      const p = get().project
      if (!p) return
      const item = removeItem(p, kind, id)
      if (!item) return
      forgetBitmap(item.blobKey)
      if (item.maskKey) forgetBitmap(item.maskKey)
      if (kind === 'backgrounds') censor.close(id)
      bump(true)
    },

    moveItem: (kind, id, delta) => {
      const p = get().project
      if (p && moveItem(p, kind, id, delta)) bump(false)
    },

    reorderItem: (kind, id, toIndex) => {
      const p = get().project
      if (p && reorderItem(p, kind, id, toIndex)) bump(false)
    },

    renameItem: (kind, id, name) => {
      const it = get().project?.[kind].find((v) => v.id === id)
      if (!it || it.name === name) return
      it.name = name
      bump(false)
    },

    refreshOutputDir: async () => {
      const { dir } = await window.nais.invoke('cover:outputDir', undefined)
      set({ outputDir: dir })
    },

    pickOutputDir: async () => {
      const { dir } = await window.nais.invoke('cover:pickOutputDir', undefined)
      if (dir) set({ outputDir: dir })
      return dir
    },

    flush: async () => {
      if (saveTimer !== null) await save()
    }
  }

  function afterAdd(kind: CoverKind, ids: string[], failed: number): void {
    const p = get().project
    if (!p) return
    if (ids.length) {
      // 처음 넣은 재료는 바로 편집 대상으로
      if (kind === 'backgrounds' && !p.selection.bgId) p.selection.bgId = ids[0]
      if (kind === 'typos' && !p.selection.typoId) p.selection.typoId = ids[0]
      bump(true)
    }
    const label = kind === 'backgrounds' ? '배경' : '타이포'
    if (ids.length && failed)
      toast(label + ' ' + ids.length + '장 추가 · ' + failed + '장은 읽지 못했어요', 'info')
    else if (failed) toast('이미지를 읽지 못했어요', 'error')
  }
})

/** 라이브러리·GPT·히스토리 우클릭 메뉴에서: 표지 탭으로 보내기 */
export async function sendToCover(paths: string[], kind: CoverKind): Promise<void> {
  const layout = useLayoutStore.getState()
  if (layout.centerMode !== 'cover') layout.setCenterMode('cover')
  const n = await useCoverStore.getState().addPaths(kind, paths)
  if (n)
    toast(
      (kind === 'backgrounds' ? '표지 배경' : '표지 타이포') + '으로 ' + n + '장 보냈어요',
      'success'
    )
}
