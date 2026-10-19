// OpenRouter(DeepSeek) 공용 정의. 번역 엔진과 AI 태그 도우미가 같은 키·모델을 쓴다.

/** 기본 모델: 그림 입력도 받는 DeepSeek V4.1 Flash (2026-10-17판) */
export const DEEPSEEK_MODEL = 'deepseek/deepseek-v4.1-flash-1017'

export interface OpenRouterStatus {
  hasKey: boolean
  /** 키 끝 6자리 (나머지는 화면에 보내지 않는다) */
  tail: string
}

export interface OpenRouterKeyResult {
  ok: boolean
  message: string
  /** 키 확인 때 OpenRouter가 알려준 사용액(달러). 모르면 null */
  usage?: number | null
  limit?: number | null
}
