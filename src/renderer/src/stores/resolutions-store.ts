import { create } from 'zustand'

export interface CustomResolution {
  label: string
  width: number
  height: number
}

interface ResolutionsState {
  custom: CustomResolution[]
  add: (width: number, height: number) => CustomResolution | null
  remove: (index: number) => void
}

const KEY = 'custom_resolutions'

function load(): CustomResolution[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '[]')
    if (!Array.isArray(v)) return []
    // 예전에 상한 없이 저장한 큰 해상도(예: 2048×2048)는 보낼 수 있는 크기로 바꿔 보여 준다
    return (v as CustomResolution[]).map((r) => {
      const fit = snapResolution(r.width, r.height)
      return fit.width === r.width && fit.height === r.height
        ? r
        : { label: `${fit.width}×${fit.height}`, ...fit }
    })
  } catch {
    return []
  }
}
function save(list: CustomResolution[]): void {
  localStorage.setItem(KEY, JSON.stringify(list))
}

/** NAI 유효 해상도로 스냅 — 64의 배수, 각 변 [64, 2048]. 생성 실패 방지 */
export function snapDim(n: number): number {
  return Math.max(64, Math.min(2048, Math.round(n / 64) * 64))
}

/** NAI 생성 픽셀 상한 — 웹도 이보다 크면 보내지 않는다 (번들 3145728 = 3×1024×1024) */
export const MAX_GENERATION_PIXELS = 3 * 1024 * 1024

/** 64 배수로 맞추고, 넓이가 상한을 넘으면 비율을 유지한 채 64 배수로 줄인다 (upstream NAIS3 44ae993) */
export function snapResolution(width: number, height: number): { width: number; height: number } {
  let w = snapDim(width)
  let h = snapDim(height)
  if (w * h > MAX_GENERATION_PIXELS) {
    const scale = Math.sqrt(MAX_GENERATION_PIXELS / (w * h))
    w = Math.max(64, Math.floor((w * scale) / 64) * 64)
    h = Math.max(64, Math.floor((h * scale) / 64) * 64)
  }
  return { width: w, height: h }
}

export const useResolutionsStore = create<ResolutionsState>((set, get) => ({
  custom: load(),
  add: (width, height) => {
    if (!Number.isFinite(width) || !Number.isFinite(height)) return null
    const { width: w, height: h } = snapResolution(width, height)
    if (!Number.isFinite(w) || !Number.isFinite(h)) return null
    // 이미 있으면(기본/커스텀 무관) 추가 안 함 — 중복 방지는 UI에서, 여기선 커스텀 중복만 체크
    if (get().custom.some((r) => r.width === w && r.height === h)) return null
    const item = { label: `${w}×${h}`, width: w, height: h }
    const next = [...get().custom, item]
    set({ custom: next })
    save(next)
    return item
  },
  remove: (index) => {
    const next = get().custom.filter((_, i) => i !== index)
    set({ custom: next })
    save(next)
  }
}))
