// AI 비서(명령 바) 공용 정의. 본체와 화면이 함께 쓴다.

export const ASSISTANT_MODELS = {
  sonnet: { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
  haiku: { id: 'claude-haiku-5-5', label: 'Haiku 5.5' }
} as const
export type AssistantModel = keyof typeof ASSISTANT_MODELS

/** 100만 토큰당 달러 */
export const ASSISTANT_PRICES: Record<
  AssistantModel,
  { input: number; output: number; cacheRead: number; cacheWrite: number }
> = {
  sonnet: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  haiku: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 }
}

export interface AssistantStatus {
  claudeReady: boolean
  model: AssistantModel
  /** 지침 문서 이름과 글자 수 (없으면 0) */
  guideName: string | null
  guideChars: number
  /** 명령 바 버튼을 화면 아래에 늘 띄울지 (Ctrl+K는 늘 된다) */
  showDock: boolean
}

/** 지금 화면 상태. 매 질문에 같이 보낸다. */
export interface AssistantContext {
  view: string
  activePreset: { id: number; name: string } | null
  gpt: { size: string; count: number; model: string; hasPrompt: boolean } | null
}

/**
 * AI가 내는 변경 계획의 한 단계. ref는 같은 계획 안에서 새로 만든 폴더를 가리킨다.
 * 폴더는 2단계까지: parentId/parentRef가 있으면 그 폴더 아래 하위 폴더.
 */
export type AssistantOp =
  | {
      type: 'create_folder'
      ref: string
      name: string
      parentId?: number | null
      parentRef?: string
    }
  | {
      type: 'move_folder'
      folderId?: number
      folderRef?: string
      parentId?: number | null
      parentRef?: string
    }
  | { type: 'move_presets'; presetIds: number[]; folderId?: number | null; folderRef?: string }
  | { type: 'rename_preset'; presetId: number; name: string }
  | { type: 'rename_folder'; folderId: number; name: string }
  | { type: 'set_reserve'; presetId: number; count: number; sceneIds?: number[] }

export interface AssistantPlan {
  summary: string
  ops: AssistantOp[]
  note: string | null
}

export interface AssistantDraft {
  title: string
  prompt: string
}

export interface AssistantReply {
  ok: boolean
  /** 실패 이유 (ok가 false일 때) */
  error: string | null
  /** 다음 질문 때 그대로 돌려보낼 대화 (Claude 형식) */
  messages: unknown[]
  text: string
  /** AI가 읽은 것 ("씬 프리셋 65개를 읽었어요") */
  trace: string[]
  plan: AssistantPlan | null
  drafts: AssistantDraft[]
  /** 답을 기다리는 도구 호출 id. 다음 질문 앞에 결과를 붙여 보낸다. */
  pendingToolIds: string[]
  cost: number
}

export const ASSISTANT_GUIDE_MAX = 60_000
