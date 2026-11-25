import { create } from 'zustand'
import { recordNav } from '../lib/nav-history'
import type { GenerationRequest, ListFolder, Scene, SceneImage, ScenePreset } from '@shared/types'
import { canonicalize, moveRow, toOrderEntries } from '../lib/folder-list'
import { moveFolderRow, orderFolders } from '../lib/preset-tree'
import { joinPromptSections } from '@shared/char-sections'
import { sceneSeedFrom } from '@shared/scene-seed'
import { enabledCharacters, useCharactersStore } from './characters-store'
import {
  enqueueBlockedMessage,
  mergePromptParts,
  randomSeed,
  useGenerationStore
} from './generation-store'
import { toast } from './toast-store'

const PAGE = 80 // 씬 상세 이미지 페이지 크기 (수만 장 대비: 한 번에 전부 로드 금지)
let loadSeq = 0 // load() 비동기 응답 순서 보장용
let imagesSeq = 0 // loadImages() 비동기 응답 순서 보장용

interface ScenesState {
  presets: ScenePreset[]
  /** 작품별 프리셋 폴더 */
  presetFolders: ListFolder[]
  activePresetId: number
  scenes: Scene[]
  selectedId: number | null // 상세로 연 씬
  editMode: boolean
  selection: Set<number> // 편집 모드 체크된 씬들
  selectionAnchor: number | null // shift 범위선택 기준점(마지막 단일 클릭 씬)
  /** 씬 목록 필터(이미지 없는 씬·예약된 씬)로 지금 보이는 씬 id 순서. null = 전체 */
  visibleIds: number[] | null
  columns: number // 2~5
  cardOrientation: 'portrait' | 'landscape' | 'square' // 카드 비율 고정 (해상도 무관)

  // 상세 이미지 (페이지네이션)
  images: SceneImage[]
  imagesTotal: number
  imagesLoading: boolean
  /** 씬 상세 "즐겨찾기만 보기" 필터 (N4) */
  favoritesOnly: boolean

  loadPresets: (loadScenes?: boolean) => Promise<void>
  setActivePreset: (id: number) => Promise<void>
  createPreset: (name: string, folderId?: number | null) => Promise<void>
  renamePreset: (id: number, name: string) => Promise<void>
  deletePreset: (id: number) => Promise<void>
  /** 프리셋 순서 이동 (dir: -1 위 / +1 아래) */
  /** 프리셋 드래그 정렬 — 새 id 순서 반영 */
  reorderPresets: (ids: number[]) => Promise<void>
  /** 폴더 목록 드래그 결과 반영 (rowKey: "f-1" | "i-3" | "divider") */
  movePresetRow: (activeKey: string, overKey: string) => Promise<void>
  movePresetsToFolder: (ids: number[], folderId: number | null) => Promise<void>
  /** parentId를 주면 그 폴더 아래 하위 폴더 (2단계까지) */
  createPresetFolder: (name: string, parentId?: number | null) => Promise<number>
  /** 폴더를 다른 폴더 아래로 넣거나 맨 위로 꺼낸다 */
  setPresetFolderParent: (
    id: number,
    parentId: number | null
  ) => Promise<{ ok: boolean; message: string }>
  renamePresetFolder: (id: number, name: string) => Promise<void>
  setPresetFolderCollapsed: (id: number, collapsed: boolean) => Promise<void>
  deletePresetFolder: (id: number) => Promise<void>

  load: () => Promise<void>
  select: (id: number | null) => void
  setEditMode: (v: boolean) => void
  setColumns: (n: number) => void
  setCardOrientation: (o: 'portrait' | 'landscape' | 'square') => void
  toggleSelected: (id: number, shift?: boolean) => void
  selectAll: () => void
  clearSelection: () => void
  /** 필터가 바뀌면 보이는 씬을 알려 준다 — 전체 선택·Shift 구간·선택이 숨은 씬을 잡지 않게 */
  setVisibleIds: (ids: number[] | null, prune?: boolean) => void

  create: (name: string) => Promise<void>
  update: (id: number, patch: Partial<Scene>) => Promise<void>
  duplicate: (id: number) => Promise<void>
  remove: (id: number) => Promise<void>
  reorder: (ids: number[]) => Promise<void>
  /** 프리셋의 새 씬 기본 해상도 설정 (N3) */
  setPresetDefaultResolution: (id: number, width: number, height: number) => Promise<void>

  // 예약
  /** 모든 프리셋의 예약 총합 — 좌측 "씬 생성 n장" 표시 */
  reservedTotal: number
  refreshReservedTotal: () => Promise<void>
  adjustReserve: (id: number, delta: number) => Promise<void>
  adjustReserveAll: (delta: number) => Promise<void>
  /** 전체(또는 편집 모드 선택) 씬의 예약을 count장으로 맞춘다 */
  /** ids를 주면 그 씬만, 없으면 편집 모드 선택 씬, 그것도 없으면 프리셋 전체 */
  setReserveAll: (count: number, ids?: number[]) => Promise<void>
  clearReserveAll: (forceAll?: boolean, ids?: number[]) => Promise<void>

  // 편집 모드 일괄
  bulkMove: (presetId: number) => Promise<void>
  bulkDelete: () => Promise<void>
  bulkSetResolution: (width: number, height: number) => Promise<void>
  bulkClearFavorites: () => Promise<void>
  bulkClearImages: () => Promise<void>
  bulkExportZip: () => Promise<void>

  /** 완료 즉시 카드 썸네일을 새 원본으로 낙관적 갱신 (튐 방지) */
  setSceneThumb: (sceneId: number, filePath: string) => void
  loadImages: (sceneId: number, reset: boolean) => Promise<void>
  toggleFavorite: (imageId: number) => Promise<void>
  deleteImage: (imageId: number) => Promise<void>
  /** 즐겨찾기만 보기 토글 (N4) */
  setFavoritesOnly: (v: boolean) => void
  /** 즐겨찾기 제외 전체 삭제 (N5) */
  deleteNonFavorites: (sceneId: number) => Promise<number>

  /** 지금 연 프리셋의 예약만 큐에 넣는다 */
  generateReserved: () => Promise<void>
  /** 모든 프리셋의 예약을 프리셋 순서대로 전부 큐에 넣는다 (프리셋별 캐릭터 바인드 적용). 넣은 장수 */
  generateAllReserved: () => Promise<number>
  /** 프리셋 캐릭터 바인드 (null = 해제) */
  setPresetCharacters: (id: number, characterIds: number[] | null) => Promise<void>
  /** 이 씬 1장 바로 생성 (예약 없이 — NAIS2식 즉석 생성) */
  // 큐에 실제로 들어갔는지 돌려준다 (인페인트 확정 시 소스 정리 판단용)
  generateOne: (sceneId: number) => Promise<boolean>
}

/**
 * 씬 프롬프트를 기본 프롬프트 뒤에 이어붙임 (콤마 정리).
 * "# == char1 ==" 같은 구간 표시는 남겨서 생성할 때 캐릭터 프롬프트로 나뉘게 한다.
 */
export function appendPrompt(base: string, add: string): string {
  return joinPromptSections(base, add)
}

/**
 * 프리셋에 바인드된 캐릭터 카드 해석 — 바인드가 있으면 그 카드들(enabled 무시),
 * 없으면 사이드바에서 켜둔 캐릭터. 삭제된 카드 id는 건너뛴다.
 */
function resolveCharacters(
  boundIds: number[] | null | undefined
): ReturnType<typeof enabledCharacters> {
  if (!boundIds || boundIds.length === 0) return enabledCharacters()
  const byId = new Map(useCharactersStore.getState().items.map((c) => [c.id, c]))
  return boundIds.map((id) => byId.get(id)).filter((c) => c != null)
}

/** 생성 요청과 토큰 미리보기가 공유하는 순서: 고정 → 가변 → 씬 → 디테일. */
export function composeScenePrompt(
  base: Pick<GenerationRequest, 'prompt' | 'promptParts'>,
  splitEnabled: boolean,
  scenePrompt: string
): Pick<GenerationRequest, 'prompt' | 'promptParts'> {
  const promptParts =
    splitEnabled && base.promptParts
      ? { ...base.promptParts, detail: appendPrompt(scenePrompt, base.promptParts.detail) }
      : undefined
  return {
    prompt: promptParts ? mergePromptParts(promptParts) : appendPrompt(base.prompt, scenePrompt),
    promptParts
  }
}

/**
 * 씬 → 생성 요청. 사이드바의 모든 것(기본/네거 프롬프트·캐릭터·조각·바이브·레퍼런스·
 * 파라미터)을 그대로 쓰고, 3분할 씬 프롬프트는 가변 뒤·디테일 앞에 넣는다.
 * 단일 입력과 네거티브는 기존 프롬프트 뒤에 씬 내용을 이어붙인다.
 * 해상도만 씬 것을 사용 (소스가 있으면 소스 해상도가 우선). 바이브/레퍼런스/조각은
 * 메인 프로세스가 DB·와일드카드에서 읽어 적용하므로 여기선 프롬프트·캐릭터·파라미터만 구성.
 * 프리셋에 캐릭터 바인드가 있으면 사이드바 캐릭터 대신 그 캐릭터들로 교체.
 */
export function buildSceneRequest(
  scene: Scene,
  boundCharacterIds?: number[] | null
): GenerationRequest {
  const base = useGenerationStore.getState().request
  const src = useGenerationStore.getState().source
  // 3분할 꺼진 상태면 promptParts를 요청/메타데이터에 싣지 않는다
  const splitEnabled = useGenerationStore.getState().promptSplitEnabled
  const characterPrompts = resolveCharacters(boundCharacterIds).map((c) => ({
    prompt: c.prompt,
    negativePrompt: c.negativePrompt,
    center: c.center,
    enabled: true as const
  }))
  return {
    ...base,
    ...composeScenePrompt(base, splitEnabled, scene.prompt),
    negativePrompt: appendPrompt(base.negativePrompt, scene.negativePrompt),
    width: src ? src.width : scene.width,
    height: src ? src.height : scene.height,
    characterPrompts,
    sceneId: scene.id,
    source: src
      ? {
          imageBase64: src.imageBase64,
          maskBase64: src.maskBase64,
          strength: base.i2iStrength ?? 0.7,
          noise: base.i2iNoise ?? 0
        }
      : undefined
  }
}

/**
 * 씬 id → 프리셋 id. 대기열 표를 프리셋별로 묶을 때 쓴다.
 * 이 화면이 불러온 씬과 이 화면이 큐에 넣은 예약만 안다 (따로 IPC를 부르지 않는다).
 */
const scenePresetIndex = new Map<number, number>()
export function presetIdOfScene(sceneId: number): number | undefined {
  return scenePresetIndex.get(sceneId)
}
function indexScenes(presetId: number, sceneIds: number[]): void {
  for (const id of sceneIds) scenePresetIndex.set(id, presetId)
}

export const useScenesStore = create<ScenesState>((set, get) => ({
  presets: [],
  presetFolders: [],
  activePresetId: 1,
  scenes: [],
  selectedId: null,
  editMode: false,
  selection: new Set(),
  selectionAnchor: null,
  visibleIds: null,
  columns: Number(localStorage.getItem('scene_columns')) || 3,
  cardOrientation:
    (localStorage.getItem('scene_orientation') as 'portrait' | 'landscape' | 'square') ||
    'portrait',
  images: [],
  imagesTotal: 0,
  imagesLoading: false,
  favoritesOnly: false,

  loadPresets: async (loadScenes = true) => {
    const list = await window.nais.invoke('scenePresets:list', undefined)
    const items = list.items
    // 하위 폴더를 상위 폴더 바로 뒤에 둔 순서로 들고 있어야 공용 정렬·저장 규약이 맞는다
    const folders = orderFolders(list.folders)
    set({ presets: canonicalize(folders, items), presetFolders: folders })
    if (!items.some((p) => p.id === get().activePresetId) && items[0]) {
      // 보던 프리셋이 지워졌으면 그 씬을 가리키던 상세·선택도 비운다
      set({
        activePresetId: items[0].id,
        selectedId: null,
        images: [],
        imagesTotal: 0,
        selection: new Set(),
        selectionAnchor: null
      })
    }
    if (loadScenes) await get().load()
  },
  setActivePreset: async (id) => {
    set({ activePresetId: id, selectedId: null, selection: new Set(), selectionAnchor: null })
    await get().load()
  },
  createPreset: async (name, folderId = null) => {
    const { id } = await window.nais.invoke('scenePresets:create', { name, folderId })
    await get().loadPresets()
    await get().setActivePreset(id)
  },
  renamePreset: async (id, name) => {
    set({ presets: get().presets.map((p) => (p.id === id ? { ...p, name } : p)) })
    await window.nais.invoke('scenePresets:rename', { id, name })
  },
  deletePreset: async (id) => {
    await window.nais.invoke('scenePresets:delete', { id })
    await get().loadPresets()
  },
  reorderPresets: async (ids) => {
    const byId = new Map(get().presets.map((p) => [p.id, p]))
    set({ presets: ids.map((pid) => byId.get(pid)!).filter(Boolean) })
    await window.nais.invoke('scenePresets:reorder', { ids })
  },
  movePresetRow: async (activeKey, overKey) => {
    const { presetFolders, presets } = get()
    if (activeKey.startsWith('f-')) {
      // 폴더는 같은 단계 안에서만 순서를 바꾼다 (하위 폴더가 상위를 따라다닌다)
      const folders = moveFolderRow(presetFolders, presets, activeKey, overKey)
      if (!folders) return
      set({ presetFolders: folders, presets: canonicalize(folders, presets) })
      await window.nais.invoke('scenePresets:reorderTree', {
        order: toOrderEntries(folders, get().presets)
      })
      return
    }
    const next = moveRow(presetFolders, presets, activeKey, overKey)
    set({ presetFolders: next.folders, presets: canonicalize(next.folders, next.items) })
    await window.nais.invoke('scenePresets:reorderTree', {
      order: toOrderEntries(next.folders, next.items)
    })
  },
  movePresetsToFolder: async (ids, folderId) => {
    const moving = new Set(ids)
    const { presetFolders, presets } = get()
    // 옮긴 프리셋은 그 폴더 끝으로
    const rest = presets.filter((p) => !moving.has(p.id))
    const moved = presets.filter((p) => moving.has(p.id)).map((p) => ({ ...p, folderId }))
    set({ presets: canonicalize(presetFolders, [...rest, ...moved]) })
    await window.nais.invoke('scenePresets:moveToFolder', { ids, folderId })
  },
  createPresetFolder: async (name, parentId = null) => {
    const { id } = await window.nais.invoke('scenePresetFolders:create', { name, parentId })
    set({
      presetFolders: orderFolders([
        ...get().presetFolders,
        { id, name, collapsed: false, color: null, parentId }
      ])
    })
    return id
  },
  setPresetFolderParent: async (id, parentId) => {
    const result = await window.nais.invoke('scenePresetFolders:setParent', { id, parentId })
    if (result.ok) await get().loadPresets(false)
    return result
  },
  renamePresetFolder: async (id, name) => {
    set({ presetFolders: get().presetFolders.map((f) => (f.id === id ? { ...f, name } : f)) })
    await window.nais.invoke('scenePresetFolders:rename', { id, name })
  },
  setPresetFolderCollapsed: async (id, collapsed) => {
    set({
      presetFolders: get().presetFolders.map((f) => (f.id === id ? { ...f, collapsed } : f))
    })
    await window.nais.invoke('scenePresetFolders:setCollapsed', { id, collapsed })
  },
  deletePresetFolder: async (id) => {
    // 하위 폴더는 맨 위 단계로 올라온다 (본체도 같게 처리)
    const folders = orderFolders(
      get()
        .presetFolders.filter((f) => f.id !== id)
        .map((f) => (f.parentId === id ? { ...f, parentId: null } : f))
    )
    const items = get().presets.map((p) => (p.folderId === id ? { ...p, folderId: null } : p))
    set({ presetFolders: folders, presets: canonicalize(folders, items) })
    await window.nais.invoke('scenePresetFolders:delete', { id })
  },
  setPresetDefaultResolution: async (id, width, height) => {
    set({
      presets: get().presets.map((p) =>
        p.id === id ? { ...p, defaultWidth: width, defaultHeight: height } : p
      )
    })
    await window.nais.invoke('scenePresets:setDefaultResolution', { id, width, height })
  },

  load: async () => {
    // 시퀀스 가드: 생성 중 scenes:changed가 연달아 오면 응답이 뒤섞여 옛 썸네일이 남을 수 있음
    const seq = ++loadSeq
    const presetId = get().activePresetId
    const { items } = await window.nais.invoke('scenes:list', { presetId })
    void get().refreshReservedTotal() // 예약 총합(전 프리셋)도 함께 갱신
    indexScenes(
      presetId,
      items.map((s) => s.id)
    )
    if (seq !== loadSeq || get().activePresetId !== presetId) return // 더 최신 로드가 있으면 폐기
    set({ scenes: items })
  },
  select: (selectedId) => {
    if (selectedId !== get().selectedId) {
      recordNav() // 마우스 뒤로/앞으로용 히스토리
      // 씬을 옮기면 남아 있던 인페인트 마스크 소스는 지운다 (다음 씬에 번지지 않게)
      if (useGenerationStore.getState().source?.maskBase64) {
        useGenerationStore.getState().setSource(null)
      }
    }
    set({ selectedId, images: [], imagesTotal: 0, favoritesOnly: false })
    if (selectedId != null) void get().loadImages(selectedId, true)
  },
  setEditMode: (editMode) => set({ editMode, selection: new Set(), selectionAnchor: null }),
  setColumns: (columns) => {
    set({ columns })
    localStorage.setItem('scene_columns', String(columns))
  },
  setCardOrientation: (cardOrientation) => {
    set({ cardOrientation })
    localStorage.setItem('scene_orientation', cardOrientation)
  },
  toggleSelected: (id, shift) => {
    const next = new Set(get().selection)
    const anchor = get().selectionAnchor
    if (shift && anchor != null && anchor !== id) {
      // 앵커~클릭 씬 사이 구간 전체에 앵커의 현재 선택 상태를 적용 (범위 체크/해제 모두 지원)
      const ids = get().visibleIds ?? get().scenes.map((s) => s.id)
      const ai = ids.indexOf(anchor)
      const bi = ids.indexOf(id)
      if (ai !== -1 && bi !== -1) {
        const [lo, hi] = ai < bi ? [ai, bi] : [bi, ai]
        const want = next.has(anchor)
        for (let k = lo; k <= hi; k++) {
          if (want) next.add(ids[k])
          else next.delete(ids[k])
        }
        set({ selection: next }) // 앵커는 유지 — 연속으로 범위를 늘였다 줄였다 조정 가능
        return
      }
    }
    next.has(id) ? next.delete(id) : next.add(id)
    set({ selection: next, selectionAnchor: id })
  },
  selectAll: () => set({ selection: new Set(get().visibleIds ?? get().scenes.map((s) => s.id)) }),
  clearSelection: () => set({ selection: new Set() }),
  setVisibleIds: (visibleIds, prune = false) => {
    const prev = get().selection
    if (!visibleIds || !prune) return set({ visibleIds })
    // 필터를 바꾸면 가려진 씬은 선택에서 뺀다 (안 보이는 씬이 일괄 삭제·이미지 비우기에 들어가지 않게).
    // 그림이 생기거나 예약을 지워 필터에서 빠지는 것만으로는 빼지 않는다 (작업 중 선택이 사라지지 않게)
    const shown = new Set(visibleIds)
    const selection = new Set([...prev].filter((id) => shown.has(id)))
    set(selection.size === prev.size ? { visibleIds } : { visibleIds, selection })
  },

  create: async (name) => {
    await window.nais.invoke('scenes:create', { presetId: get().activePresetId, name })
    await get().load()
  },
  update: async (id, patch) => {
    set({ scenes: get().scenes.map((s) => (s.id === id ? { ...s, ...patch } : s)) })
    await window.nais.invoke('scenes:update', {
      id,
      patch: {
        name: patch.name,
        prompt: patch.prompt,
        negativePrompt: patch.negativePrompt,
        width: patch.width,
        height: patch.height,
        reserveCount: patch.reserveCount,
        // null = 씬 시드 해제 (메인 시드 설정을 따름)
        ...('seed' in patch ? { seed: patch.seed ?? null } : {})
      }
    })
  },
  duplicate: async (id) => {
    await window.nais.invoke('scenes:duplicate', { id })
    await get().load()
  },
  remove: async (id) => {
    await window.nais.invoke('scenes:delete', { id })
    if (get().selectedId === id) set({ selectedId: null })
    await get().load()
  },
  reorder: async (ids) => {
    set({ scenes: ids.map((id) => get().scenes.find((s) => s.id === id)!).filter(Boolean) })
    await window.nais.invoke('scenes:reorder', { ids })
  },

  reservedTotal: 0,
  refreshReservedTotal: async () => {
    const { total } = await window.nais.invoke('scenes:reservedTotal', undefined)
    set({ reservedTotal: total })
  },
  adjustReserve: async (id, delta) => {
    const scene = get().scenes.find((s) => s.id === id)
    if (!scene) return
    // 예약은 배치 생성 개수 단위로 (배치 3이면 +3/-3 — NAIS2 워크플로)
    const step = delta * (useGenerationStore.getState().batchCount || 1)
    const reserveCount = Math.max(0, scene.reserveCount + step)
    set({ scenes: get().scenes.map((s) => (s.id === id ? { ...s, reserveCount } : s)) })
    await window.nais.invoke('scenes:update', { id, patch: { reserveCount } })
    void get().refreshReservedTotal()
  },
  adjustReserveAll: async (delta) => {
    const step = delta * (useGenerationStore.getState().batchCount || 1)
    // 편집 모드에서 체크된 씬이 있으면 그 씬들만 예약, 아니면 전체
    const { editMode, selection } = get()
    const ids = editMode && selection.size > 0 ? [...selection] : undefined
    set({
      scenes: get().scenes.map((s) =>
        !ids || selection.has(s.id) ? { ...s, reserveCount: Math.max(0, s.reserveCount + step) } : s
      )
    })
    await window.nais.invoke('scenes:adjustReserveAll', {
      presetId: get().activePresetId,
      delta: step,
      ids
    })
    void get().refreshReservedTotal()
  },
  setReserveAll: async (count, idsArg) => {
    const n = Math.max(0, Math.floor(count))
    const { editMode, selection } = get()
    const ids = idsArg ?? (editMode && selection.size > 0 ? [...selection] : undefined)
    // 빈 목록을 본체에 넘기면 전체로 처리되므로 여기서 멈춘다.
    if (ids && ids.length === 0) return
    const target = ids ? new Set(ids) : null
    set({
      scenes: get().scenes.map((s) => (!target || target.has(s.id) ? { ...s, reserveCount: n } : s))
    })
    await window.nais.invoke('scenes:setReserveAll', {
      presetId: get().activePresetId,
      count: n,
      ids
    })
    void get().refreshReservedTotal()
  },
  clearReserveAll: async (forceAll = false, idsArg) => {
    // ids를 주면 그 씬만, 편집 모드에서 체크된 씬이 있으면 그 씬들만 취소, 아니면 전체
    const { editMode, selection } = get()
    const ids = forceAll
      ? undefined
      : (idsArg ?? (editMode && selection.size > 0 ? [...selection] : undefined))
    if (ids && ids.length === 0) return
    const target = ids ? new Set(ids) : null
    set({
      scenes: get().scenes.map((s) => (!target || target.has(s.id) ? { ...s, reserveCount: 0 } : s))
    })
    if (forceAll) {
      await window.nais.invoke('scenes:clearAllReservations', undefined)
      set({ reservedTotal: 0 })
      return
    }
    await window.nais.invoke('scenes:setReserveAll', {
      presetId: get().activePresetId,
      count: 0,
      ids
    })
    void get().refreshReservedTotal()
  },

  bulkMove: async (presetId) => {
    const ids = [...get().selection]
    await window.nais.invoke('scenes:bulkMove', { ids, presetId })
    set({ selection: new Set() })
    await get().load()
  },
  bulkDelete: async () => {
    const ids = [...get().selection]
    await window.nais.invoke('scenes:bulkDelete', { ids })
    set({ selection: new Set() })
    await get().load()
  },
  bulkSetResolution: async (width, height) => {
    const ids = [...get().selection]
    await window.nais.invoke('scenes:bulkSetResolution', { ids, width, height })
    await get().load()
  },
  bulkClearFavorites: async () => {
    await window.nais.invoke('scenes:bulkClearFavorites', { ids: [...get().selection] })
    await get().load() // 카드 썸네일은 즐겨찾기 우선이라 다시 읽어야 바뀐다
  },
  bulkClearImages: async () => {
    await window.nais.invoke('scenes:bulkClearImages', { ids: [...get().selection] })
    set({ selection: new Set() })
    await get().load()
  },
  bulkExportZip: async () => {
    await window.nais.invoke('scenes:bulkExportZip', { ids: [...get().selection] })
  },

  setSceneThumb: (sceneId, filePath) =>
    set({
      // thumbnail(base64) 비우고 thumbnailPath로 → 카드가 새 원본을 즉시 표시.
      // 즐겨찾기가 있는 씬은 즐겨찾기가 썸네일 고정이라 교체하지 않는다 (개수만 갱신)
      scenes: get().scenes.map((s) =>
        s.id === sceneId
          ? s.hasFavorite
            ? { ...s, imageCount: s.imageCount + 1 }
            : { ...s, thumbnail: '', thumbnailPath: filePath, imageCount: s.imageCount + 1 }
          : s
      )
    }),

  loadImages: async (sceneId, reset) => {
    if (!reset && get().imagesLoading) return // 페이지네이션 중복 방지 (reset은 항상 허용)
    const seq = ++imagesSeq
    set({ imagesLoading: true })
    const offset = reset ? 0 : get().images.length
    const { items, total } = await window.nais.invoke('scenes:images', {
      sceneId,
      limit: PAGE,
      offset,
      favoritesOnly: get().favoritesOnly
    })
    if (seq !== imagesSeq || get().selectedId !== sceneId) return // 더 최신 로드가 있으면 폐기
    set((s) => ({
      images: reset ? items : [...s.images, ...items],
      imagesTotal: total,
      imagesLoading: false
    }))
  },
  toggleFavorite: async (imageId) => {
    const img = get().images.find((i) => i.id === imageId)
    if (!img) return
    const favorite = !img.favorite
    const images = get().images.map((i) => (i.id === imageId ? { ...i, favorite } : i))
    // 카드 썸네일 낙관 반영 — 즐겨찾기 우선 규칙(최신 즐겨찾기, 없으면 최신)을 로드된
    // 이미지 기준으로 즉시 적용. 페이지네이션 밖 이미지는 아래 load()가 서버 기준으로 재동기화
    const favs = images.filter((i) => i.favorite)
    const pick = favs.length > 0 ? favs[0] : images[0]
    set({
      images,
      scenes: get().scenes.map((s) =>
        s.id === get().selectedId
          ? pick
            ? { ...s, hasFavorite: favs.length > 0, thumbnail: '', thumbnailPath: pick.filePath }
            : { ...s, hasFavorite: favs.length > 0 }
          : s
      )
    })
    await window.nais.invoke('images:setFavorite', { id: imageId, favorite })
    // 카드 썸네일이 즐겨찾기 우선이라 목록도 갱신 (낙관 반영의 최종 정합)
    await get().load()
  },
  deleteImage: async (imageId) => {
    const target = get().images.find((i) => i.id === imageId)
    set({
      images: get().images.filter((i) => i.id !== imageId),
      imagesTotal: Math.max(0, get().imagesTotal - 1)
    })
    // 메인 프리뷰가 이 파일을 보고 있으면 정리 — 삭제 후 깨진(NULL) 이미지 방지 (B8)
    const gen = useGenerationStore.getState()
    if (target && gen.viewingFilePath === target.filePath) gen.view(null)
    // 씬 상세의 명시적 삭제 — 파일까지 삭제 (히스토리 삭제와 달리)
    await window.nais.invoke('images:delete', { id: imageId, deleteFile: true })
    void get().load() // 카드 썸네일/카운트 갱신 — 지운 파일을 썸네일로 계속 보이지 않게
    void gen.refreshHistory()
  },
  setFavoritesOnly: (v) => {
    if (v === get().favoritesOnly) return
    set({ favoritesOnly: v, images: [], imagesTotal: 0 })
    const id = get().selectedId
    if (id != null) void get().loadImages(id, true)
  },
  deleteNonFavorites: async (sceneId) => {
    const { deleted } = await window.nais.invoke('scenes:deleteNonFavorites', { sceneId })
    if (deleted > 0) {
      await get().loadImages(sceneId, true)
      void get().load() // 카드 썸네일/카운트 갱신
      void useGenerationStore.getState().refreshHistory()
    }
    return deleted
  },

  generateReserved: async () => {
    // 넘기는 중에 또 누르면(단축키 연타) 같은 예약이 두 번 들어간다
    if (handingOff) return
    handingOff = true
    try {
      // 큐에 넘기는 사이에 프리셋을 바꿔도 넘긴 프리셋에서만 뺀다
      const presetId = get().activePresetId
      const preset = get().presets.find((p) => p.id === presetId)
      const reserved = get().scenes.filter((s) => s.reserveCount > 0)
      if (reserved.length === 0) return
      const requests = buildReservedRequests(reserved, preset?.characterIds ?? null)
      const sent = reserved.map((s) => ({ id: s.id, count: s.reserveCount }))
      const result = await window.nais.invoke('queue:enqueueMany', {
        requests,
        reservation: true
      })
      if (result.blockedReason) {
        toast(enqueueBlockedMessage(result.blockedReason), 'info')
        return
      }
      await consumeSentReserves(presetId, sent)
    } finally {
      handingOff = false
    }
    void get().refreshReservedTotal()
  },

  generateAllReserved: async () => {
    if (handingOff) return 0
    handingOff = true
    try {
      const requests: GenerationRequest[] = []
      const sentByPreset: { presetId: number; sent: SentReserve[] }[] = []
      for (const preset of get().presets) {
        const { items } = await window.nais.invoke('scenes:list', { presetId: preset.id })
        const reserved = items.filter((s) => s.reserveCount > 0)
        if (reserved.length === 0) continue
        indexScenes(
          preset.id,
          reserved.map((s) => s.id)
        )
        requests.push(...buildReservedRequests(reserved, preset.characterIds))
        sentByPreset.push({
          presetId: preset.id,
          sent: reserved.map((s) => ({ id: s.id, count: s.reserveCount }))
        })
      }
      if (requests.length === 0) return 0
      const result = await window.nais.invoke('queue:enqueueMany', {
        requests,
        reservation: true
      })
      if (result.blockedReason) {
        toast(enqueueBlockedMessage(result.blockedReason), 'info')
        return 0
      }
      await Promise.all(
        sentByPreset.map(({ presetId, sent }) => consumeSentReserves(presetId, sent))
      )
      return requests.length
    } finally {
      handingOff = false
      void get().refreshReservedTotal()
    }
  },

  setPresetCharacters: async (id, characterIds) => {
    const normalized = characterIds && characterIds.length > 0 ? characterIds : null
    set({
      presets: get().presets.map((p) => (p.id === id ? { ...p, characterIds: normalized } : p))
    })
    await window.nais.invoke('scenePresets:setCharacters', { id, characterIds: normalized })
  },

  generateOne: async (sceneId) => {
    const scene = get().scenes.find((s) => s.id === sceneId)
    if (!scene) return false
    const preset = get().presets.find((p) => p.id === get().activePresetId)
    // 바로 뽑기: 예약이 남아 있어도 받고, 예약보다 먼저 누른 순서대로 나간다.
    // 시드 고정이면 이 씬에 이미 걸린 장수만큼 밀어 같은 그림이 반복되지 않게 한다.
    const live =
      useGenerationStore
        .getState()
        .queue?.items.filter(
          (i) =>
            i.request.sceneId === sceneId && (i.state === 'pending' || i.state === 'generating')
        ).length ?? 0
    // 소스는 이 호출의 인자 평가 시점(첫 await 전)에 이미 요청에 담긴다
    const result = await window.nais.invoke('queue:enqueueQuick', {
      request: {
        ...buildSceneRequest(scene, preset?.characterIds ?? null),
        seed: sceneSeed(scene, live)
      }
    })
    if (result.blockedReason) {
      toast(enqueueBlockedMessage(result.blockedReason), 'info')
      return false
    }
    return true
  }
}))

/** 예약을 큐에 넘기는 중인지 — 연타로 같은 예약이 두 번 들어가지 않게 */
let handingOff = false

export interface SentReserve {
  id: number
  count: number
}

/** 넘긴 장수만큼만 뺀다 — 넘기는 사이에 누른 +1은 남는다 */
export function subtractSentReserves<T extends { id: number; reserveCount: number }>(
  scenes: T[],
  sent: SentReserve[]
): T[] {
  const byId = new Map(sent.map((s) => [s.id, s.count]))
  return scenes.map((s) =>
    byId.has(s.id) ? { ...s, reserveCount: Math.max(0, s.reserveCount - byId.get(s.id)!) } : s
  )
}

/** 같은 장수를 넘긴 씬끼리 묶는다 — 본체 adjustReserveAll 한 번에 한 묶음 */
export function groupSentByCount(sent: SentReserve[]): Map<number, number[]> {
  const groups = new Map<number, number[]>()
  for (const s of sent) {
    if (s.count <= 0) continue
    groups.set(s.count, [...(groups.get(s.count) ?? []), s.id])
  }
  return groups
}

/**
 * 큐에 넘긴 예약을 씬에서 뺀다. 화면 값과 본체 요청을 같은 틱에 보내서, 이 뒤에 누른 +1 요청은
 * 반드시 이 빼기 다음에 본체에 도착한다 (예전처럼 0으로 덮어쓰지 않는다).
 */
function consumeSentReserves(presetId: number, sent: SentReserve[]): Promise<unknown> {
  const st = useScenesStore.getState()
  if (st.activePresetId === presetId) {
    useScenesStore.setState({ scenes: subtractSentReserves(st.scenes, sent) })
  }
  return Promise.all(
    [...groupSentByCount(sent)].map(([count, ids]) =>
      window.nais.invoke('scenes:adjustReserveAll', { presetId, delta: -count, ids })
    )
  )
}

/** 예약된 씬들을 큐에 — 시드 고정 시 모든 씬이 같은 base 시드 (같은 씬 반복만 +i로 동일 그림 방지) */
function buildReservedRequests(
  scenes: Scene[],
  characterIds: number[] | null
): GenerationRequest[] {
  const requests: GenerationRequest[] = []
  for (const scene of scenes) {
    const request = buildSceneRequest(scene, characterIds)
    for (let i = 0; i < scene.reserveCount; i++) {
      requests.push({ ...request, seed: sceneSeed(scene, i) })
    }
  }
  return requests
}

/**
 * 씬 생성 시드 — 씬에 시드가 있으면 그 값+offset, 없으면 메인 시드 고정을 따른다
 * (고정이면 base+offset, 아니면 랜덤)
 */
function sceneSeed(scene: Scene, offset: number): number {
  if (scene.seed != null) return sceneSeedFrom(scene.seed, offset)
  const g = useGenerationStore.getState()
  return g.seedLocked && g.request.seed >= 0 ? (g.request.seed + offset) % 4294967296 : randomSeed()
}

/**
 * 씬 생성 완료 이벤트 바인딩 (목록 썸네일/개수 + 열린 상세 이미지 갱신).
 * 대량 배치 시 이벤트가 쏟아지므로 디바운스로 DB 부하·리렌더를 줄인다.
 */
export function bindSceneEvents(): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  let reloadSelected = false
  // 취소한 예약이 씬으로 돌아옴 — 예약 수만 다시 읽어 맞춘다 (썸네일·장수는 건드리지 않는다)
  const offReserves = window.nais.on('scenes:reservesChanged', ({ sceneIds }) => {
    const st = useScenesStore.getState()
    void st.refreshReservedTotal()
    const changed = new Set(sceneIds)
    if (!st.scenes.some((s) => changed.has(s.id))) return
    const presetId = st.activePresetId
    void window.nais.invoke('scenes:list', { presetId }).then(({ items }) => {
      const now = useScenesStore.getState()
      if (now.activePresetId !== presetId) return
      const counts = new Map(items.map((s) => [s.id, s.reserveCount]))
      useScenesStore.setState({
        scenes: now.scenes.map((s) =>
          changed.has(s.id) && counts.has(s.id) ? { ...s, reserveCount: counts.get(s.id)! } : s
        )
      })
    })
  })
  const offChanged = window.nais.on('scenes:changed', ({ sceneId, filePath }) => {
    const st = useScenesStore.getState()
    // 완료 즉시 카드 낙관적 갱신 — 스트리밍 프레임이 사라진 뒤 옛 썸네일이 튀는 것 방지.
    // 새 원본을 바로 표시(thumbnail 비워 thumbnailPath로 폴백), load()가 곧 정식 썸네일로 대체.
    st.setSceneThumb(sceneId, filePath)
    if (st.selectedId === sceneId) reloadSelected = true
    clearTimeout(timer)
    timer = setTimeout(() => {
      const s = useScenesStore.getState()
      if (reloadSelected && s.selectedId != null) void s.loadImages(s.selectedId, true)
      reloadSelected = false
    }, 300)
  })
  return () => {
    offReserves()
    offChanged()
  }
}
