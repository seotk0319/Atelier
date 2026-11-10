// 플랫폼 작품 본문 읽기의 공통 모양. 도구 이름과 결과 모양은 모든 플랫폼이 같고,
// 플랫폼마다 다른 부분(주소·필드 이름)은 그 플랫폼 연결부 파일 안에만 둔다.

export interface WorkReadInit {
  method?: 'GET'
}
/** 로그인한 계정으로 읽는 통로. 허용 주소 검사는 통로를 만드는 쪽(collector)이 한다. */
export type WorkFetch = (url: string, init?: WorkReadInit) => Promise<Response>

export interface WorkListItem {
  id: string
  title: string
  visibility: string | null
  status: string | null
  updatedAt: string | null
  characters: number | null
}

export interface LoreEntry {
  title: string
  keys: string
  content: string
  mode: string | null
  offKeys: string[]
  turnRange: number | null
  offTurnRange: number | null
}
export interface StartScenario {
  id: string | number | null
  title: string
  isDefault: boolean
  content: string
  subPrompt: string
  dialogue: string
  situation: string
  description: string
}
export interface WorkCharacter {
  id: string | null
  name: string
  isMain: boolean
  order: number | null
  details: string
  info: string
  imageCount: number
}

/** 플랫폼 원본을 공통 이름으로 옮긴 작품 한 편 */
export interface WorkBody {
  id: string | null
  title: string
  visibility: string | null
  status: string | null
  updatedAt: string | null
  /** 글 칸: title / subtitle / description / main / creator_comment */
  fields: Record<string, string>
  lorebook: LoreEntry[]
  startScenarios: StartScenario[]
  characters: WorkCharacter[]
}

export interface EditionInfo {
  language: string
  isSource: boolean
  exists: boolean
  status: string | null
  stale: boolean
}
export interface EditionBody extends WorkBody {
  language: string
  exists: boolean
  stale: boolean
}

export interface WorkAdapter {
  id: string
  label: string
  capabilities: string[]
  /** 이 연결부가 읽어도 되는 주소인지 (이 밖으로는 요청하지 않는다) */
  readAllowed(url: string): boolean
  list(read: WorkFetch): Promise<WorkListItem[]>
  /** 작품 원본 전체 (스냅샷으로 남기는 값) */
  readRaw(read: WorkFetch, workId: string): Promise<unknown>
  normalize(raw: unknown): WorkBody
  editions?(read: WorkFetch, workId: string): Promise<EditionInfo[]>
  readEditionRaw?(read: WorkFetch, workId: string, language: string): Promise<unknown>
  normalizeEdition?(raw: unknown): EditionBody
  /** 이 연결부가 저장해도 되는 요청인지 (이 밖으로는 쓰지 않는다) */
  writeAllowed?(method: string, url: string): boolean
  /** 원본에 바꿀 내용을 얹은 새 원본을 돌려준다 (원본은 건드리지 않는다) */
  applyChanges?(raw: unknown, changes: WorkChanges): unknown
  /** 새 원본을 플랫폼에 저장한다. 공개 상태는 원본에 있던 값 그대로 보낸다. */
  save?(write: WorkWrite, workId: string, next: unknown): Promise<void>
}

/** 로그인한 계정으로 쓰는 통로. 허용 요청 검사는 통로를 만드는 쪽(collector)이 한다. */
export type WorkWrite = (method: 'PUT' | 'POST', url: string, body: unknown) => Promise<Response>

export type StartScenarioDraft = Partial<
  Pick<StartScenario, 'title' | 'content' | 'subPrompt' | 'dialogue' | 'situation' | 'description'>
>

/** 바꿀 내용. 적지 않은 칸은 플랫폼에 있던 값 그대로 둔다. */
export interface WorkChanges {
  /** 글 칸 통째 교체: title / subtitle / description / main / creator_comment */
  fields?: Record<string, string>
  /** 로어북 전체 교체 */
  lorebook?: LoreEntry[]
  /** 로어북 일부 항목만 고치기 (index는 work_read의 번호) */
  lorebookPatch?: ({ index: number } & Partial<LoreEntry>)[]
  /** 로어북 항목 지우기 (index는 고치기 전 번호) */
  lorebookRemove?: number[]
  /** 로어북 끝에 새 항목 더하기 */
  lorebookAdd?: LoreEntry[]
  /** 시작 상황 일부만 고치기 */
  startScenarios?: ({ index: number } & Partial<
    Pick<
      StartScenario,
      'title' | 'content' | 'subPrompt' | 'dialogue' | 'situation' | 'description'
    >
  >)[]
  /** 시작 상황 지우기 (index는 고치기 전 번호. 기본 시작 상황은 지울 수 없다) */
  startScenariosRemove?: number[]
  /** 시작 상황 끝에 새로 더하기 */
  startScenariosAdd?: StartScenarioDraft[]
  /** 캐릭터 지우기 (index는 고치기 전 번호. 주연은 지울 수 없다) */
  charactersRemove?: number[]
  /** 캐릭터 끝에 새로 더하기 */
  charactersAdd?: { name: string; details?: string; info?: string }[]
  /** 캐릭터 일부만 고치기 */
  characters?: ({ index: number } & Partial<Pick<WorkCharacter, 'name' | 'details' | 'info'>>)[]
}

/** 사이트 글자 수와 같은 기준(이모지는 2)으로 센 길이. JS 문자열 길이가 곧 그 값이다. */
export const textLength = (text: string): number => text.length
