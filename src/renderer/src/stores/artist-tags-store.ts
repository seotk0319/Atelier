import { create } from 'zustand'
import type { ArtistTag } from '@shared/types'
import { imageUrl } from '../lib/constants'

/**
 * 작가 태그 분석 (NAIS2 이식) — 이미지를 Kaloscope 스타일 분류기에 보내
 * 닮은 작가들을 artist: 태그로 받아 다이얼로그에 표시한다.
 */
interface ArtistTagsState {
  open: boolean
  loading: boolean
  tags: ArtistTag[]
  error: string | null
  /** 다이얼로그에 표시할 이미지 src (파일=nais-image, 드롭=data URL) */
  imageSrc: string | null
  /** 파일 경로 또는 base64(외부 드롭)로 분석 시작 + 다이얼로그 열기 */
  show: (src: { filePath?: string; base64?: string }) => Promise<void>
  close: () => void
}

/** 창을 다시 열 때마다 1씩 — 앞 그림의 늦은 분석 결과가 새 그림 창에 들어가지 않게 */
let request = 0

export const useArtistTagsStore = create<ArtistTagsState>((set) => ({
  open: false,
  loading: false,
  tags: [],
  error: null,
  imageSrc: null,

  show: async (src) => {
    const imageSrc = src.base64
      ? src.base64.startsWith('data:')
        ? src.base64
        : `data:image/png;base64,${src.base64}`
      : src.filePath
        ? imageUrl(src.filePath)
        : null
    set({ open: true, loading: true, tags: [], error: null, imageSrc })
    const mine = ++request
    const res = await window.nais.invoke('images:analyzeArtists', src)
    // 분석은 수 초 걸린다 — 기다리는 동안 닫았거나 다른 그림으로 다시 열었으면 결과를 버린다
    if (!useArtistTagsStore.getState().open || mine !== request) return
    if ('error' in res) set({ loading: false, error: res.error })
    else set({ loading: false, tags: res.tags })
  },
  close: () => set({ open: false })
}))
