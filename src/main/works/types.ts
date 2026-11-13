// 플랫폼 작품 본문 읽기의 공통 모양. 도구 이름과 결과 모양은 모든 플랫폼이 같고,
// 플랫폼마다 다른 부분(주소·필드 이름)은 그 플랫폼 연결부 파일 안에만 둔다.

export interface WorkReadInit {
  /** 기본 GET. POST는 목록을 폼 요청으로만 주는 플랫폼(루나)용이고, 연결부의 readPostAllowed를 통과해야 나간다 */
  method?: 'GET' | 'POST'
  body?: string
  contentType?: string
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
  /**
   * 전체 교체로 받은 항목에서 호출한 쪽이 실제로 적어 준 칸 이름. 없는 칸은 "안 줬다"는 뜻이라
   * 짝지은 옛 항목의 값을 그대로 둔다(빈 값으로 "비웠다"와 구분한다). 읽기 결과에는 없다.
   */
  given?: string[]
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
  /**
   * 공통 칸에 들지 않는 그 플랫폼의 설정(태그·분류·성인 표시·모델 설정·통계 등). 읽기 전용으로 보여 준다.
   * 값은 짧은 것만 그대로, 긴 글·목록은 길이·개수로 줄여 싣는다. 작품 본문은 싣지 않는다.
   */
  extras?: Record<string, unknown>
  /** 사이트에는 있는데 이 연결부가 읽지 못하는 것. 빈 목록·빈 글을 "없음"으로 오해하지 않게 적는다 */
  unsupported?: string[]
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

/**
 * 도구 결과만 보고도 그 플랫폼에서 저장하면 무슨 일이 생기는지, 무엇은 사이트에서 직접 해야 하는지 알 수 있게
 * 하는 안내. 문장은 production-oneplan 스킬의 references/mcp.md와 sites/*.md 「작품 MCP」 절에 적힌 사실만 옮긴다.
 */
export interface WorkGuide {
  /** 저장하면 생기는 일 (한두 문장) */
  save: string
  /** 이 도구로 못 해서 사이트에서 직접 해야 하는 일 */
  manual: string[]
  /** 실제 계정에서 아직 확인하지 않은 동작 */
  unverified?: string[]
}

/** 기능 하나를 이 플랫폼에서 어디까지 할 수 있는지 */
export interface WorkFeature {
  /** 사이트에 그 기능이 있는지 */
  site: 'yes' | 'no' | 'unknown'
  read: 'yes' | 'no' | 'partial'
  write: 'yes' | 'no' | 'partial' | 'blocked'
  /** 실제 계정에서 확인했는지 */
  verified: 'yes' | 'no' | 'partial'
  /** 한도·막은 이유 등 한 줄 */
  note?: string
}

export interface WorkAdapter {
  id: string
  label: string
  capabilities: string[]
  /**
   * 할 수 있는 것 표. 열쇠는 title, description, main_prompt, first_message, start_scenarios, lorebook,
   * characters, example_dialogue, user_persona, output_rules, situation_images, cover, tags, visibility,
   * create_work, delete_work, versioning_review, language_editions, bgm_voice, jsx_html, model_settings,
   * comments_stats. sites_list가 그대로 돌려준다.
   */
  features?: Record<string, WorkFeature>
  /**
   * 저장 뒤 원본째 견줄 때(raw_check) 문제로 치지 않을 경로. 서버가 저장할 때마다 스스로 다시 만드는 값
   * (겹친 사본, 다시 매기는 번호·순서 등)이다. 2026-11-13 실제 저장 시험에서 본 것만 적는다.
   */
  rawIgnore?: RegExp[]
  /** sites_list와 계획 도구 결과에 싣는 플랫폼 안내 */
  guide?: WorkGuide
  /** 작품 번호가 대소문자를 구분한다 (공용 도구가 소문자로 바꾸지 않는다) */
  caseSensitiveIds?: boolean
  /** 이 연결부가 읽어도 되는 주소인지 (이 밖으로는 요청하지 않는다) */
  readAllowed(url: string): boolean
  /** 읽기를 POST로 해야 하는 주소인지. 주소·본문 종류·본문 모양까지 본다 (없으면 POST 읽기는 막는다) */
  readPostAllowed?(url: string, init: WorkReadInit): boolean
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
  /** io는 JSON이 아닌 저장(파일 묶음·CSRF 헤더)이 필요한 플랫폼용 통로 묶음 */
  /** 플랫폼이 "달라진 것이 없다"고 해서 보내지 않았으면 { skipped: true }를 돌려준다 */
  save?(
    write: WorkWrite,
    workId: string,
    next: unknown,
    io?: WorkIo
  ): Promise<void | { skipped: true }>
  /** 이 플랫폼이 받는 공개 상태 값 (work_plan의 visibility) */
  visibilities?: string[]
  /** 작품을 통째로 지운다. 되돌릴 수 없다. */
  remove?(write: WorkWrite, workId: string, io?: WorkIo): Promise<void>
  /** 비공개 새 작품을 만들고 작품 번호를 돌려준다 (read는 만든 작품 번호를 목록에서 찾을 때만 쓴다) */
  create?(write: WorkWrite, draft: WorkDraft, read?: WorkFetch, io?: WorkIo): Promise<string>
  /** 새 작품 내용이 플랫폼 규격에 맞는지 미리 본다 (대표 이미지 주소는 아직 없어도 된다) */
  checkDraft?(draft: WorkDraft): void

  // ── 이미지·표지 (JSON이 아닌 요청은 send 통로로만 나간다) ──
  /** JSON이 아니거나 다른 주소로 가는 요청이 허용된 것인지, 어떤 로그인 정보를 붙일지 */
  sendRule?(method: string, url: string): SendRule | null
  /** 이미지 파일로 받는 확장자와 크기 한도 */
  imageRules?: FileRules
  /** 작품 원본에서 이미지 목록을 뽑는다 (캐릭터가 없는 플랫폼은 묶음 하나) */
  imageGroups?(raw: unknown): ImageGroup[]
  /** 이미지 바꾸기가 되는지 미리 본다. 안 되는 조합이면 던지고, 되면 일어날 일을 돌려준다 */
  planImages?(raw: unknown, changes: ImageChanges): ImagePlanLine[]
  /** 이미지 바꾸기를 플랫폼에 적용한다 (올리기 → 지우기 → 순서) */
  applyImages?(io: WorkIo, workId: string, raw: unknown, changes: ImageChanges): Promise<void>
  /** 이미지 하나를 올리고 주소만 돌려준다 (대표 이미지가 있어야 만들 수 있는 플랫폼용) */
  uploadImage?(io: WorkIo, file: LocalImage): Promise<string>
  /** 표지 파일로 받는 확장자와 크기 한도 */
  coverRules?: FileRules
  /** 작품 원본에 적힌 표지 주소 */
  coverUrl?(raw: unknown): string | null
  /** 표지를 올리고 그 주소를 돌려준다. language를 주면 그 언어 판본의 표지다 */
  uploadCover?(io: WorkIo, workId: string, file: LocalImage, language?: string): Promise<string>

  // ── 언어 판본 저장 ──
  /** 원문과 판본을 편집기처럼 겹친 원본. 판본에 없는 칸은 원문 값이 들어간다 */
  editionView?(source: unknown, edition: unknown): unknown
  /** 겹친 원본에 바꿀 내용을 얹는다. 판본에서 못 바꾸는 것(구조·공개 상태)은 던진다 */
  applyEditionChanges?(view: unknown, changes: WorkChanges): unknown
  /** 겹친 원본을 그 언어 판본으로 저장한다 (자동 번역은 부르지 않는다) */
  saveEdition?(write: WorkWrite, workId: string, language: string, view: unknown): Promise<void>

  // ── 캔버스 JSON (노드 캔버스로 만드는 플랫폼: 알플레이) ──
  /** 편집기의 "캔버스 내보내기"와 같은 요청으로 작품의 캔버스 JSON을 받는다 */
  exportCanvas?(read: WorkFetch, workId: string): Promise<CanvasExport>
  /** 캔버스 JSON이 가져오기 규격에 맞는지 본다 (던지지 않고 문제 목록을 돌려준다) */
  checkCanvas?(data: unknown): CanvasCheck
  /** 캔버스 JSON을 편집기와 같은 순서로 가져온다 (캔버스 전체가 바뀐다). 끝날 때까지 기다린다 */
  importCanvas?(
    io: WorkIo,
    workId: string,
    file: CanvasFile,
    options: CanvasImportOptions
  ): Promise<{ runId: string | null }>
  /** 넣은 파일과 다시 내보낸 JSON을 견줘 다른 곳을 돌려준다 (서버가 붙이는 값은 빼고 본다) */
  compareCanvas?(expected: unknown, actual: unknown, options?: CanvasCompareOptions): string[]
}

/** 내보낸 캔버스 JSON */
export interface CanvasExport {
  /** 캔버스 번호 (작품 번호와 다르다) */
  canvasId: string
  /** 편집기 내보내기 파일과 같은 JSON */
  data: unknown
  /** 계획 뒤 캔버스가 바뀌었는지 견줄 값 (내보낸 시각처럼 매번 바뀌는 값은 뺀다) */
  stamp: string
}
export interface CanvasSummary {
  version: number | null
  language: string | null
  nodes: number
  nodeTypes: Record<string, number>
  connections: number
  metadata: number
  annotations: number
  /** 이 파일을 내보낸 작품·캔버스 번호 (파일에 적힌 값) */
  sourceWorkId: string | null
  sourceCanvasId: string | null
  /** 공통 설정 (가져올 때 지금 캔버스와 다르면 어느 쪽을 쓸지 골라야 한다) */
  settings: Record<string, unknown> | null
  nodeIds: string[]
}
export interface CanvasCheck {
  summary: CanvasSummary
  /** 규격에 맞지 않는 곳 (비어 있으면 가져올 수 있는 모양) */
  problems: string[]
}
/** 가져올 로컬 파일 (UTF-8 글과 그 글의 바이트. BOM은 뺀다) */
export interface CanvasFile {
  name: string
  text: string
  data: Uint8Array
}
export interface CanvasImportOptions {
  /** 계획 때 확인한 대상 캔버스 번호 (그 사이 바뀌었으면 멈춘다) */
  canvasId: string
  /** 파일의 캔버스 언어가 지금 캔버스와 다를 때 지금 캔버스 언어로 넣는다 */
  useCurrentLanguage?: boolean
  /** 공통 설정이 다를 때 고르는 쪽: current(지금 설정 유지) / imported(파일 설정) */
  settingsChoice?: 'current' | 'imported'
}
export interface CanvasCompareOptions {
  /** 공통 설정은 지금 캔버스 값을 남겼으니 견주지 않는다 */
  keepCurrentSettings?: boolean
  /** 캔버스 언어는 지금 캔버스 값을 남겼으니 견주지 않는다 */
  keepCurrentLanguage?: boolean
}

/** 로컬에서 읽은 이미지 파일 하나 */
export interface LocalImage {
  /** 파일 이름 (경로 없이) */
  name: string
  /** image/webp 같은 종류 */
  type: string
  data: Uint8Array
}
export interface FileRules {
  extensions: string[]
  maxBytes: number
}

export type FormField = { name: string; value: string } | { name: string; file: LocalImage }
/** 허용 목록을 통과해야 나가는 요청 하나. JSON 말고 파일 묶음(multipart)·바이너리도 보낸다 */
export interface WorkRequest {
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  url: string
  json?: unknown
  form?: FormField[]
  bytes?: { data: Uint8Array; contentType: string }
  /** 덧붙일 헤더. 그 주소의 규칙(SendRule.headers)이 허용한 이름만 쓸 수 있다 */
  headers?: Record<string, string>
}
export type WorkSend = (request: WorkRequest) => Promise<Response>

/** send 통로로 나가는 주소 하나의 규칙 */
export interface SendRule {
  /**
   * session: 플랫폼 로그인 헤더와 쿠키 / origin: 그 주소에 따로 저장된 헤더만 /
   * cookie: 쿠키만 / none: 로그인 정보를 붙이지 않는다 (다른 회사 저장소)
   */
  auth: 'session' | 'origin' | 'cookie' | 'none'
  body: 'json' | 'form' | 'bytes' | 'none'
  /** 요청이 직접 붙여도 되는 헤더 이름 (소문자) */
  headers?: string[]
  /** 보내기 전에 로그인 토큰을 이 쿠키로 맞춰 둔다 (사이트가 토큰을 쿠키에 적는 플랫폼) */
  cookieFromBearer?: { name: string; domain: string }
  /**
   * 사이트 쿠키에 든 CSRF 토큰을 이 헤더로 붙인다 (젠잇: wavechat_csrftoken → X-CSRFToken).
   * 쿠키가 없으면 보내지 않고 LOGIN_REQUIRED로 멈춘다.
   */
  csrfCookie?: { domain: string; name: string; header: string }
}

/** 읽기·JSON 쓰기·파일 보내기 통로 묶음 */
export interface WorkIo {
  read: WorkFetch
  write: WorkWrite
  send: WorkSend
}

export interface WorkImage {
  /** 플랫폼이 붙인 이미지 번호 (없는 플랫폼은 null) */
  id: string | null
  url: string
  /** 이미지 코드(에덴) 또는 감정 이름(베이비챗) */
  label: string
  description: string
  visibility: string | null
  /** 대표 이미지 여부 */
  isDefault: boolean
}
export interface ImageGroup {
  /** 캐릭터 번호 (캐릭터가 없는 플랫폼은 null) */
  character: number | null
  name: string
  images: WorkImage[]
}
export interface ImageAdd {
  file: LocalImage
  label?: string
  description?: string
  visibility?: string
  /** 올리면서 대표 이미지로 삼는다 */
  isDefault?: boolean
}
/** 이미지 바꾸기. 번호는 images_list의 index (바꾸기 전 기준) */
export interface ImageChanges {
  character?: number
  add?: ImageAdd[]
  remove?: number[]
  /** 대표 이미지를 이 파일로 바꾼다 (이미지가 저장 본문에 들어가는 플랫폼) */
  main?: LocalImage
  /** 지우고 남은 이미지의 새 순서 */
  order?: number[]
}
export interface ImagePlanLine {
  action: 'add' | 'remove' | 'main' | 'order'
  detail: string
}

/** 로그인한 계정으로 쓰는 통로. 허용 요청 검사는 통로를 만드는 쪽(collector)이 한다. */
export type WorkWrite = (
  method: 'PUT' | 'POST' | 'DELETE',
  url: string,
  body?: unknown
) => Promise<Response>

/** 새 작품의 내용. 만들어지는 작품은 항상 비공개다. */
export interface WorkDraft {
  title: string
  /** 메인 프롬프트 (베이비챗은 캐릭터 설정) */
  main: string
  /** 성인 작품 여부 */
  adult: boolean
  subtitle?: string
  description?: string
  categories?: string[]
  hashtags?: string[]
  /** 첫 번째가 주연이다 (캐릭터가 따로 없는 플랫폼은 비워 둔다) */
  characters: { name: string; details?: string; info?: string }[]
  lorebook?: LoreEntry[]
  /** 첫 번째가 기본 시작 상황이다 */
  startScenarios?: StartScenarioDraft[]
  /** 이미 올려 둔 대표 이미지 주소 (대표 이미지가 있어야 만들 수 있는 플랫폼) */
  coverUrl?: string
  /** 플랫폼마다 따로 필요한 값 (베이비챗: category·target_gender·recommended_model 등) */
  options?: Record<string, unknown>
}

export type StartScenarioDraft = Partial<
  Pick<StartScenario, 'title' | 'content' | 'subPrompt' | 'dialogue' | 'situation' | 'description'>
>

/** 바꿀 내용. 적지 않은 칸은 플랫폼에 있던 값 그대로 둔다. */
export interface WorkChanges {
  /** 공개 상태 바꾸기 (그 플랫폼의 visibilities 중 하나) */
  visibility?: string
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
