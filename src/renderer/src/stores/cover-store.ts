import { create } from 'zustand'
import type {
  CoverArchiveItem,
  CoverKind,
  CoverProject,
  CoverProjectSummary,
  CoverSelection
} from '@shared/cover'
import * as censor from '../components/cover/engine/censor'
import { forgetBitmap } from '../components/cover/engine/render'
import {
  addExtraFiles,
  addExtraPaths,
  addImageFiles,
  addImagePaths,
  flushBlobDeletes,
  moveExtra,
  moveItem,
  removeExtra,
  removeItem,
  reorderItem,
  typoToExtra
} from '../components/cover/engine/state'
import type {
  CoverBrushPrefs,
  CoverChangeKind,
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

/**
 * 되돌리기 기록: 배치(타이포 위치·크기)·배경 위치·액자. 이미지 추가·삭제와 검열 붓은 넣지 않는다
 * (검열은 편집기가 따로 기록). 0.5초 안에 이어진 바뀜(슬라이더 끌기, 방향키 연타)은 한 번으로 친다.
 */
const HISTORY_MAX = 100
const HISTORY_MERGE_MS = 500
type LayoutSnap = string

function layoutSnap(p: CoverProject): LayoutSnap {
  return JSON.stringify({ placements: p.placements, pans: p.pans, frame: p.frame })
}

function applySnap(p: CoverProject, snap: LayoutSnap): void {
  const v = JSON.parse(snap) as Pick<CoverProject, 'placements' | 'pans' | 'frame'>
  p.placements = v.placements
  p.pans = v.pans
  p.frame = v.frame
}

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
  /** 표지 기록: 표지에 넣었던 그림·타이포·문구 (작품에서 빼도 남는다) */
  archive: CoverArchiveItem[]
  loadArchive: () => Promise<void>
  removeArchive: (id: string) => Promise<void>
  /** 기록에서 지금 작품으로 다시 넣기. phrase 는 typoId(없으면 고른 타이포)의 문구로 */
  addFromArchive: (id: string, as: CoverKind | 'phrase', typoId?: string) => Promise<void>
  /** 배치·배경 위치·액자 되돌리기 가능 여부 */
  canUndo: boolean
  canRedo: boolean
  undo: () => void
  redo: () => void

  init: () => Promise<void>
  openProject: (id: string) => Promise<void>
  createProject: (name?: string) => Promise<void>
  renameProject: (name: string) => void
  deleteProject: (id: string) => Promise<void>
  /** 프로젝트를 고치고 저장 예약. redraw 면 편집기를 다시 그림 */
  mutate: (fn: (p: CoverProject) => void, opts?: { redraw?: boolean }) => void
  /** 엔진이 이미 고친 뒤 알려 줄 때 (편집기 onChange) */
  touch: (kind?: CoverChangeKind) => void
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
  /** 타이포에 문구 이미지 붙이기 (파일 또는 끌어온 경로) */
  addExtras: (typoId: string, source: File[] | string[]) => Promise<void>
  removeExtra: (typoId: string, extraId: string) => void
  moveExtra: (typoId: string, extraId: string, delta: number) => void
  renameExtra: (typoId: string, extraId: string, name: string) => void
  /** 타이포를 다른 타이포의 문구로 옮기기 */
  typoToExtra: (sourceId: string, targetId: string) => void
  refreshOutputDir: () => Promise<void>
  pickOutputDir: () => Promise<string | null>
  /** 대기 중인 저장을 바로 실행 */
  flush: () => Promise<void>
}

let saveTimer: number | null = null
let archiveSeq = 0
let initPromise: Promise<void> | null = null
let undoStack: LayoutSnap[] = []
let redoStack: LayoutSnap[] = []
/** 마지막으로 기록에 반영된 상태 (다음 바뀜의 "이전" 값) */
let baseline: LayoutSnap | null = null
let lastPushAt = 0
let lastSource = ''
/** 같은 종류가 잇따를 때만 한 단계로 묶는다 (끌기는 매번 따로) */
const MERGEABLE = new Set(['nudge', 'inspector'])

export const useCoverStore = create<CoverState>((set, get) => {
  const resetHistory = (p: CoverProject | null): void => {
    undoStack = []
    redoStack = []
    baseline = p ? layoutSnap(p) : null
    lastPushAt = 0
    lastSource = ''
  }
  /** 바뀜이 생긴 뒤 부른다. 배치·위치·액자가 실제로 달라졌을 때만 기록 */
  const recordHistory = (source: string): void => {
    const p = get().project
    if (!p || baseline === null) return
    const now = layoutSnap(p)
    if (now === baseline) return
    const t = Date.now()
    const merge =
      undoStack.length > 0 &&
      source === lastSource &&
      MERGEABLE.has(source) &&
      t - lastPushAt <= HISTORY_MERGE_MS
    if (!merge) {
      undoStack.push(baseline)
      if (undoStack.length > HISTORY_MAX) undoStack.shift()
    }
    lastPushAt = t
    lastSource = source
    redoStack = []
    baseline = now
    set({ canUndo: true, canRedo: false })
  }
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
    if (res.archiveChanged) void get().loadArchive()
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
  const bump = (redraw = false, source = 'inspector'): void => {
    recordHistory(source)
    set((s) => ({ rev: s.rev + 1 }))
    schedule()
    if (redraw) void get().editor?.refresh()
  }
  const setProject = (p: CoverProject | null): void => {
    censor.closeAll()
    if (p && !p.selection.bgId && p.backgrounds[0]) p.selection.bgId = p.backgrounds[0].id
    if (p && !p.selection.typoId && p.typos[0]) p.selection.typoId = p.typos[0].id
    if (p) localStorage.setItem(LAST_KEY, p.id)
    resetHistory(p)
    set((s) => ({
      project: p,
      rev: s.rev + 1,
      history: { canUndo: false, canRedo: false },
      canUndo: false,
      canRedo: false
    }))
  }
  const restore = (from: LayoutSnap[], to: LayoutSnap[]): void => {
    const p = get().project
    const snap = from.pop()
    if (!p || snap === undefined) return
    to.push(baseline ?? layoutSnap(p))
    applySnap(p, snap)
    baseline = snap
    lastPushAt = 0
    lastSource = ''
    set((s) => ({ rev: s.rev + 1, canUndo: undoStack.length > 0, canRedo: redoStack.length > 0 }))
    schedule()
    void get().editor?.refresh()
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
    archive: [],
    canUndo: false,
    canRedo: false,
    undo: () => restore(undoStack, redoStack),
    redo: () => restore(redoStack, undoStack),

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

    touch: (kind) => bump(false, kind ?? 'placement'),

    select: (patch) => {
      const p = get().project
      if (!p) return
      // 다른 타이포로 바꾸면 그 타이포 본체부터 편집
      if (
        patch.typoId !== undefined &&
        patch.typoId !== p.selection.typoId &&
        !('layerId' in patch)
      )
        patch = { ...patch, layerId: null }
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

    loadArchive: async () => {
      const seq = ++archiveSeq
      const { items } = await window.nais.invoke('cover:archiveList', undefined)
      if (seq === archiveSeq) set({ archive: items })
    },

    removeArchive: async (id) => {
      set((s) => ({ archive: s.archive.filter((a) => a.id !== id) }))
      await window.nais.invoke('cover:archiveDelete', { id })
      await get().loadArchive()
    },

    addFromArchive: async (id, as, typoId) => {
      await get().init()
      const p = get().project
      const a = get().archive.find((x) => x.id === id)
      if (!p || !a) return
      set((s) => ({ importing: s.importing + 1 }))
      try {
        const target = typoId ?? p.selection.typoId
        if (as === 'phrase' && target && p.typos.some((t) => t.id === target)) {
          const { added } = await addExtraPaths(p, target, [a.path])
          const item = added[0]
          if (!item) {
            toast('이미지를 읽지 못했어요', 'error')
            return
          }
          item.name = a.name
          p.selection.typoId = target
          p.selection.layerId = item.id
          bump(true)
          toast('문구로 붙였어요', 'success')
          return
        }
        const kind: CoverKind = as === 'backgrounds' ? 'backgrounds' : 'typos'
        const { added } = await addImagePaths(p, kind, [a.path])
        const item = added[0]
        if (!item) {
          toast('이미지를 읽지 못했어요', 'error')
          return
        }
        item.name = a.name
        if (kind === 'backgrounds') {
          // 검열 마스크도 그때 그대로
          if (a.maskPath) {
            const res = await window.nais.invoke('cover:importPaths', { paths: [a.maskPath] })
            if (res.items[0]) item.maskKey = res.items[0].key
          }
          p.selection.bgId = item.id
        } else {
          p.selection.typoId = item.id
          p.selection.layerId = null
        }
        bump(true)
        toast(kind === 'backgrounds' ? '배경으로 넣었어요' : '타이포로 넣었어요', 'success')
      } finally {
        set((s) => ({ importing: Math.max(0, s.importing - 1) }))
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
      // 삭제로 정리된 배치는 되돌리기 대상이 아니다
      baseline = layoutSnap(p)
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

    addExtras: async (typoId, source) => {
      await get().init()
      const p = get().project
      if (!p || !source.length) return
      set((s) => ({ importing: s.importing + source.length }))
      try {
        const { added, failed } =
          typeof source[0] === 'string'
            ? await addExtraPaths(p, typoId, source as string[])
            : await addExtraFiles(p, typoId, source as File[])
        if (added.length) {
          // 넣은 문구를 바로 편집 대상으로
          p.selection.typoId = typoId
          p.selection.layerId = added[added.length - 1].id
          bump(true)
          toast('문구 ' + added.length + '장을 붙였어요', 'success')
        }
        if (failed) toast('이미지 ' + failed + '장을 읽지 못했어요', 'error')
      } finally {
        set((s) => ({ importing: Math.max(0, s.importing - source.length) }))
      }
    },

    removeExtra: (typoId, extraId) => {
      const p = get().project
      if (!p) return
      const item = removeExtra(p, typoId, extraId)
      if (!item) return
      baseline = layoutSnap(p)
      forgetBitmap(item.blobKey)
      bump(true)
    },

    moveExtra: (typoId, extraId, delta) => {
      const p = get().project
      if (p && moveExtra(p, typoId, extraId, delta)) bump(true)
    },

    renameExtra: (typoId, extraId, name) => {
      const e = get()
        .project?.typos.find((t) => t.id === typoId)
        ?.extras?.find((x) => x.id === extraId)
      if (!e || e.name === name) return
      e.name = name
      bump(false)
    },

    typoToExtra: (sourceId, targetId) => {
      const p = get().project
      if (!p || !typoToExtra(p, sourceId, targetId)) return
      bump(true)
      toast('문구로 옮겼어요', 'success')
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
