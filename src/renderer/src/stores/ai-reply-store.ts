import { create } from 'zustand'
import type { AiReplyConfig, AiReplyStatus } from '@shared/ai-reply'

// AI 답글 상태(키·모드·오늘 개수). 설정의 AI 답글 섹션이 바꾸고, 알림 화면이 읽는다.
interface AiReplyState {
  status: AiReplyStatus | null
  load: () => Promise<void>
  setConfig: (
    patch: Partial<Pick<AiReplyConfig, 'mode' | 'excluded' | 'dailyLimit'>>
  ) => Promise<void>
}
export const useAiReplyStore = create<AiReplyState>((set) => ({
  status: null,
  load: async () => {
    try {
      set({ status: await window.nais.invoke('aiReply:status', undefined) })
    } catch {
      // 상태를 못 읽으면 이전 값을 그대로 둔다.
    }
  },
  setConfig: async (patch) => {
    try {
      set({ status: await window.nais.invoke('aiReply:setConfig', patch) })
    } catch {
      // 저장하지 못하면 화면도 바꾸지 않는다.
    }
  }
}))
