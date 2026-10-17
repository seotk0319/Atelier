/**
 * GPT 이미지 (ChatGPT 로그인). Codex 로그인 파일의 토큰으로 ChatGPT의 Codex 응답 API에
 * image_generation 도구를 붙여 보낸다. 요청 모양은 ima2-gen(MIT, lidge-jun)을 참고했다.
 */

export const GPT_MODELS = [
  'gpt-6-astra',
  'gpt-5.6-luna',
  'gpt-5.6-terra',
  'gpt-5.6-sol',
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.4-mini'
] as const
export type GptModel = (typeof GPT_MODELS)[number]

/**
 * 모델별 추론 단계. gpt-6-astra는 'none'을 받지 않고 low부터 받는다 (2026-10-17 서버 응답 확인).
 * 이미지 만들기는 도구 호출 한 번이라 가장 낮은 단계로 둔다.
 */
export function reasoningEffortFor(model: string): 'none' | 'low' {
  return model.startsWith('gpt-6-astra') ? 'low' : 'none'
}

export const GPT_SIZES = [
  { value: 'auto', label: '자동' },
  { value: '1024x1024', label: '정사각' },
  { value: '1024x1536', label: '세로 2:3' },
  { value: '1536x1024', label: '가로 3:2' }
] as const
export type GptSize = (typeof GPT_SIZES)[number]['value']

export const GPT_QUALITIES = [
  { value: 'auto', label: '자동' },
  { value: 'low', label: '낮음' },
  { value: 'medium', label: '보통' },
  { value: 'high', label: '높음' }
] as const
export type GptQuality = (typeof GPT_QUALITIES)[number]['value']

/** direct: 프롬프트 그대로 / auto: 모델이 알아서 다듬기 */
export type GptPromptMode = 'direct' | 'auto'

export interface GptRef {
  /** data URL 없는 base64 */
  b64: string
  mime: string
  name?: string
}

export interface GptRequest {
  prompt: string
  refs: GptRef[]
  size: GptSize
  quality: GptQuality
  model: GptModel
  mode: GptPromptMode
  /** 고칠 그림. 있으면 이 그림을 첫 이미지로 보내 고친다 (부분 수정이면 마스크도) */
  edit?: GptEdit
}

export interface GptEdit {
  b64: string
  mime: string
  name?: string
  /** 칠한 곳=흰색, 나머지=검정인 PNG (마스크 에디터 출력). 본체가 알파 마스크로 바꿔 보낸다 */
  maskB64?: string
}

/** 자주 쓰는 지시 (프롬프트 칸에 이어 붙인다) */
export interface GptPreset {
  id: string
  name: string
  text: string
}

/** 저장된 프리셋이 아직 없을 때 처음 보여주는 예시. 지우거나 고쳐 쓸 수 있다 */
export const GPT_STARTER_PRESETS: GptPreset[] = [
  {
    id: 'starter-bubble',
    name: '말풍선 넣기',
    text: '오른쪽 위에 말풍선을 넣고 안에 "대사" 라고 써 줘'
  },
  {
    id: 'starter-sign',
    name: '글자 바꾸기',
    text: '그림 속 글자를 "새 글자" 로 바꿔 줘. 글씨체와 위치는 그대로'
  },
  { id: 'starter-bg', name: '배경만 바꾸기', text: '인물은 그대로 두고 배경만 ( ) 로 바꿔 줘' },
  {
    id: 'starter-outfit',
    name: '옷만 바꾸기',
    text: '얼굴·머리·자세는 그대로 두고 옷만 ( ) 로 바꿔 줘'
  }
]

export type GptJobState = 'running' | 'retrying' | 'done' | 'failed' | 'cancelled'

export interface GptJob {
  id: string
  state: GptJobState
  prompt: string
  size: GptSize
  model: GptModel
  refCount: number
  /** 그림을 고치는 작업인지 (부분 수정이면 'mask') */
  edit?: 'whole' | 'mask'
  startedAt: number
  finishedAt?: number
  attempt: number
  /** 재시도까지 남은 시간 표시용 */
  retryAt?: number
  error?: string
  filePath?: string
  revisedPrompt?: string
}

export interface GptAuthStatus {
  ready: boolean
  email?: string
  plan?: string
  /** 준비가 안 됐을 때 안내 문구 */
  reason?: string
}
