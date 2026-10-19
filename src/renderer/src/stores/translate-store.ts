import { create } from 'zustand'
import type { TranslateEngine, TranslateStatus } from '@shared/translate'

// 번역 엔진과 키 연결 상태. 설정의 번역 섹션이 바꾸고, 알림 화면이 읽는다.
interface TranslateState {
  status: TranslateStatus | null
  load: () => Promise<void>
  setEngine: (engine: TranslateEngine) => Promise<void>
  setStatus: (status: TranslateStatus) => void
}
const none: TranslateStatus = {
  hasKey: false,
  engine: 'deepl',
  deeplReady: false,
  deepseekReady: false,
  tail: '',
  free: false
}
export const useTranslateStore = create<TranslateState>((set) => ({
  status: null,
  load: async () => {
    try {
      set({ status: await window.nais.invoke('translate:status', undefined) })
    } catch {
      set({ status: none })
    }
  },
  setEngine: async (engine) => {
    try {
      set({ status: await window.nais.invoke('translate:setEngine', { engine }) })
    } catch {
      // 저장에 실패해도 화면 선택은 유지한다.
      set((s) => ({
        status: s.status
          ? {
              ...s.status,
              engine,
              hasKey: engine === 'deepl' ? s.status.deeplReady : s.status.deepseekReady
            }
          : { ...none, engine }
      }))
    }
  },
  setStatus: (status) => set({ status })
}))
