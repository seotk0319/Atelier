// MCP로 내놓는 작품 도구. 여기는 화면·Electron을 모르고, 읽기 통로와 스냅샷 저장만 받아서 쓴다.
// 읽기 도구는 여기, 계획·저장 도구는 save-tools.ts, 언어 판본 저장은 edition-tools.ts,
// 이미지·표지는 media-tools.ts, 캔버스 JSON 내보내기·가져오기는 canvas-tools.ts에 있다.
import { MANUAL_EVERYWHERE, WORK_ADAPTERS, workAdapter, workKey } from './adapters'
import { canCanvas, createCanvasTools } from './canvas-tools'
import { createEditionTools } from './edition-tools'
import { createMediaTools } from './media-tools'
import { createSaveTools } from './save-tools'
import { createStatusTool, type WorksStatusSource } from './status-tool'
import { textLength, type WorkBody, type WorkFetch, type WorkSend, type WorkWrite } from './types'

export interface WorkToolDeps {
  /** 그 플랫폼의 로그인 통로 */
  reader(platform: string): WorkFetch
  /** 사이트 원본을 파일로 남기고 경로를 돌려준다 (저장 전 백업·긴 본문 읽기용) */
  snapshot(platform: string, name: string, raw: unknown): Promise<string>
  /** 그 플랫폼의 저장 통로 */
  writer(platform: string): WorkWrite
  /** 로컬 글 파일 읽기 (UTF-8). work_plan의 field_files·lorebook_file이 쓴다 */
  readFile(path: string): Promise<string>
  /** 그 플랫폼의 파일 통로 (이미지·표지: 파일 묶음·바이너리·파일 저장소) */
  sender(platform: string): WorkSend
  /** 로컬 파일을 바이트로 읽는다. maxBytes보다 크면 읽지 않고 던진다 */
  readBinary(path: string, maxBytes: number): Promise<Uint8Array>
  /** 폴더 바로 아래 파일 이름들 (하위 폴더는 보지 않는다) */
  listFolder(path: string): Promise<string[]>
  /** works_status용: 저장해 둔 작품 목록과 MCP 저장 기록 (플랫폼에 묻지 않는다) */
  worksStatus?(): Promise<WorksStatusSource>
}

export interface ToolDef {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  run(args: Record<string, unknown>): Promise<unknown>
}

const MESSAGES: [RegExp, string][] = [
  [/UNKNOWN_SITE/, '그 플랫폼 연결부는 아직 없어요. sites_list로 되는 곳을 확인해 주세요.'],
  [
    /LOGIN_REQUIRED|SESSION/,
    '그 플랫폼에 로그인돼 있지 않아요. NAIS3 알림 탭의 연결 관리에서 로그인해 주세요.'
  ],
  [/WORK_NOT_FOUND/, '그 번호의 작품을 찾지 못했어요.'],
  [/BAD_WORK_ID/, '작품 번호 모양이 맞지 않아요. works_list의 id를 써 주세요.'],
  [/BAD_LANGUAGE/, '언어 코드가 맞지 않아요. editions_list의 language를 써 주세요.'],
  [/BAD_INDEX/, '없는 번호예요. work_read의 index를 써 주세요.'],
  [
    /BAD_RANGE/,
    '나눠 읽기 값이 맞지 않아요. work_read·edition_read의 offset은 fields에 칸을 하나만 줬을 때만 쓰고 0 이상 그 칸 길이 미만이어야 해요. max_chars는 숫자, images_list의 group은 있는 묶음 번호, offset은 0 이상, limit은 1~500이에요.'
  ],
  [
    /BAD_FIELD/,
    '그 플랫폼에 없는 칸이에요. work_read의 field_lengths에 나오는 이름 중에서 골라 주세요.'
  ],
  [
    /NO_LOREBOOK_REPLACE/,
    '이 플랫폼은 아직 로어북 전체 교체를 지원하지 않아요. lorebook_patch로 항목별로 고쳐 주세요.'
  ],
  [/NO_EDITIONS/, '언어 판본이 없는 플랫폼이에요.'],
  [/UNAPPROVED_(READ|WRITE)_ROUTE/, '허용되지 않은 주소라 요청하지 않았어요.'],
  [/NO_SAVE/, '이 플랫폼은 아직 저장을 지원하지 않아요.'],
  [/NO_DELETE/, '이 플랫폼은 아직 작품 삭제를 지원하지 않아요.'],
  [/NO_CREATE/, '이 플랫폼은 아직 새 작품 만들기를 지원하지 않아요.'],
  [/NO_IMAGES/, '이 플랫폼은 아직 이미지 올리기를 지원하지 않아요.'],
  [/NO_COVER/, '이 플랫폼은 아직 표지 올리기를 지원하지 않아요.'],
  [/NO_EDITION_SAVE/, '이 플랫폼은 언어 판본 저장을 지원하지 않아요.'],
  [/BAD_IMAGE_LABEL/, '이미지 코드(감정 이름)가 비었거나 이미 쓰이고 있어요. 다른 이름을 주세요.'],
  [
    /BAD_IMAGE/,
    '이미지 파일을 읽지 못했어요. 확장자·크기 한도(images_list의 rules, 표지는 webp·gif)와 경로를 확인해 주세요.'
  ],
  [/IMAGE_TOO_LARGE/, '플랫폼이 파일이 너무 크다고 거절했어요.'],
  [/IMAGE_(UPLOAD|DELETE|ORDER)_FAILED/, '플랫폼이 이미지 요청을 받아 주지 않았어요.'],
  [/COVER_FAILED/, '표지 올리기가 중간에 실패했어요. 표지는 바뀌지 않았을 가능성이 높아요.'],
  [
    /COVER_AMBIGUOUS/,
    '같은 자리에 맞는 표지 파일이 둘 이상이에요. files로 자리와 파일을 직접 짝지어 주세요.'
  ],
  [/COVER_REQUIRED/, '이 플랫폼은 대표 이미지가 있어야 만들 수 있어요. cover_file을 주세요.'],
  [
    /EDITION_MISSING/,
    '그 언어 판본이 아직 없어요. edition_plan → edition_save로 판본을 먼저 만들어 주세요.'
  ],
  [
    /EDITION_FIXED/,
    '판본에서는 글만 바꿀 수 있어요. 시작 상황·캐릭터 추가/삭제와 공개 상태는 원문에서 바꿔 주세요.'
  ],
  [/BAD_DRAFT/, '새 작품 내용이 플랫폼 규격에 맞지 않아요.'],
  [
    /CREATED_ID_UNKNOWN/,
    '작품은 만들어졌을 수 있는데 번호를 찾지 못했어요. works_list로 확인해 주세요.'
  ],
  [
    /BAD_VISIBILITY/,
    '그 플랫폼이 받지 않는 공개 상태예요. sites_list의 visibilities를 확인해 주세요.'
  ],
  [
    /TITLE_MISMATCH/,
    '제목이 맞지 않아서 지우지 않았어요. work_delete_plan이 돌려준 제목을 그대로 넣어 주세요. 제목이 빈 작품은 작품 번호(work_delete_plan의 confirm_title)를 넣어요.'
  ],
  [/DELETE_FAILED/, '플랫폼이 삭제를 받아 주지 않았어요. 작품은 그대로 있을 가능성이 높아요.'],
  [/CREATE_FAILED/, '플랫폼이 새 작품을 받아 주지 않았어요.'],
  [
    /KEEP_MAIN_IMAGE/,
    '대표 이미지는 그냥 지울 수 없어요. 새 대표 이미지를 같이 올리거나(에덴: add의 default, 베이비챗: main_file) 전부 지울 때만 돼요.'
  ],
  [/KEEP_DEFAULT/, '기본 시작 상황과 주연 캐릭터는 지울 수 없어요. 하나는 꼭 남아야 해요.'],
  [/START_LIMIT/, '이 플랫폼은 추가 시작 설정을 2개까지만 받아요.'],
  [/NO_CHARACTERS/, '이 플랫폼은 작품 하나에 캐릭터가 하나라 캐릭터를 더하거나 지울 수 없어요.'],
  [
    /NO_CHANGES/,
    '바꿀 내용이 없어요. fields·lorebook·start_scenarios·characters 중 하나는 주세요.'
  ],
  [/BAD_CHANGES/, '바꿀 내용의 모양이 맞지 않아요. work_plan 설명의 모양대로 주세요.'],
  [/EMPTY_FIELD/, '제목·메인 프롬프트·캐릭터 이름은 비울 수 없어요.'],
  [
    /BAD_LOREBOOK/,
    '로어북에 내용이 빈 항목이나 키워드 없는 키워드 항목이 있어요. 플랫폼이 그런 항목을 버려서 막았어요.'
  ],
  [
    /BAD_FILE/,
    '파일을 읽지 못했어요. 글 칸은 .md / .txt, 로어북·시작 상황·캐릭터는 .json(배열)이고 1MB 이하여야 해요.'
  ],
  [
    /PLAN_NOT_FOUND/,
    '그 계획을 찾지 못했어요(30분이 지났거나 이미 썼어요). 계획 도구(…_plan)부터 다시 해 주세요.'
  ],
  [
    /PLAN_STALE/,
    '계획을 세운 뒤 플랫폼 내용이나 로컬 파일이 바뀌어서 진행하지 않았어요. 계획 도구(…_plan)부터 다시 해 주세요.'
  ],
  [/SAVE_FAILED/, '플랫폼이 저장을 받아 주지 않았어요. 내용은 바뀌지 않았을 가능성이 높아요.'],
  [
    /PROMPT_SHAPE/,
    '이 작품의 메인 프롬프트는 모델별로 나뉜 옛 형식이라 여기서 고치지 않아요. 사이트 편집기에서 한 번 저장한 뒤 다시 해 주세요.'
  ],
  [
    /LOREBOOK_EMPTY/,
    '이 플랫폼은 로어북을 전부 비우는 저장을 편집기도 보내지 않아요. 항목을 하나 이상 남겨 주세요.'
  ],
  [
    /BAD_JSX/,
    'JSX 컴포넌트를 컴파일하지 못했어요. 파일 이름(한글·영문·숫자·_·- 30자), 문법, 컴포넌트 이름(대문자로 시작하는 함수), 다른 파일과 겹치는 컴포넌트 이름을 확인해 주세요.'
  ],
  [
    /JSX_UNSUPPORTED/,
    '이 작품의 JSX 컴포넌트는 편집기가 저장할 때 브라우저에서 다시 컴파일해야 해서 여기서 저장하지 않아요.'
  ],
  [
    /PUBLISH_REQUIREMENTS/,
    '공개 상태를 바꾸려면 발행해야 하는데, 발행에 필요한 칸이 비어 있어요(괄호 안 칸).'
  ],
  [
    /START_STRUCTURE_UNSUPPORTED|CHARACTER_STRUCTURE_UNSUPPORTED/,
    '이 플랫폼은 시작 상황·캐릭터를 더하거나 빼면 캐릭터 이미지도 같이 맞춰야 해서 여기서는 고치기만 돼요.'
  ],
  [/IN_REVIEW/, '수정본이 심사 중이라 저장하지 않았어요. 심사가 끝난 뒤 다시 해 주세요.'],
  [/COVER_NOT_CHANGED/, '표지를 올렸지만 작품에 반영되지 않았어요.'],
  [/NOT_SUPPORTED/, '이 플랫폼에서는 아직 여기서 할 수 없는 일이에요. 사이트에서 직접 해 주세요.'],
  [/BAD_IMAGE_RATIO/, '이미지 비율이 맞지 않아요. 크랙 대표 이미지는 2:3이어야 해요.'],
  [
    /RPLAY_ACCOUNT_REQUIRED|TEAPOT_UID_REQUIRED/,
    '로그인 계정 번호를 찾지 못했어요. NAIS3 연결 관리에서 그 플랫폼을 다시 로그인해 주세요.'
  ],
  [/NOT_PUBLISHED/, '아직 공개한 적이 없는 작품이라 이 공개 전환은 여기서 하지 않아요.'],
  [/ORIGINAL_STORY_LOCK/, '원작 잠금이 걸린 작품이라 바꿀 수 없어요.'],
  [/TEAPOT_NO_CHECKPOINT/, '이 작품에는 저장 파일(체크포인트)이 없어 읽을 수 없어요.'],
  [
    /TEAPOT_VISIBILITY_NEEDS_SUBMIT/,
    '티팟의 공개 상태는 등록(심사)할 때만 반영돼요. 사이트에서 등록해 주세요.'
  ],
  [/CHECKPOINT_LIMIT/, '저장 파일 수가 한도에 찼어요. 사이트에서 오래된 저장 파일을 지워 주세요.'],
  [/NOT_OWNER/, '내 계정의 작품이 아니에요.'],
  [
    /NO_CANVAS/,
    '이 플랫폼은 캔버스 JSON 내보내기·가져오기를 지원하지 않아요. sites_list의 can_canvas가 true인 곳(알플레이)에서만 돼요.'
  ],
  [
    /BAD_CANVAS_FILE/,
    '캔버스 JSON 파일을 쓸 수 없어요. .json(UTF-8, 20MB 이하)이고 canvas_export 파일과 같은 모양이어야 해요.'
  ],
  [
    /IMPORT_LANGUAGE_MISMATCH/,
    '파일의 캔버스 언어가 지금 캔버스와 달라요. 지금 캔버스 언어로 넣으려면 use_current_language를 true로 주고 다시 계획해 주세요.'
  ],
  [
    /IMPORT_SETTINGS_CHOICE_REQUIRED/,
    '고급 설정이 지금 캔버스와 파일에서 달라요. settings_choice에 current(지금 설정 유지) 또는 imported(파일 설정)를 주고 다시 계획해 주세요.'
  ],
  [
    /IMPORT_FILE_CHANGED/,
    '올린 파일이 가져오기 전에 바뀌었다고 플랫폼이 거절했어요. 캔버스는 그대로예요. 계획부터 다시 해 주세요.'
  ],
  [
    /CANVAS_BUSY/,
    '캔버스가 지금 가져오기·컴파일 중이거나 다른 변경을 받는 중이에요. 끝난 뒤 다시 해 주세요.'
  ],
  [
    /IMPORT_TIMEOUT|IMPORT_UNCONFIRMED/,
    '가져오기가 끝났는지 확인하지 못했어요. 잠시 뒤 canvas_export로 지금 캔버스를 확인해 주세요.'
  ],
  [/CANVAS_UPLOAD_FAILED|IMPORT_FAILED/, '플랫폼이 캔버스 가져오기를 받아 주지 않았어요.']
]
export function toolMessage(error: unknown): string {
  const code = error instanceof Error ? error.message : String(error)
  for (const [re, message] of MESSAGES)
    if (re.test(code))
      // 플랫폼이 거절한 경우는 받은 상태 코드도 같이 알려 준다
      return /_FAILED |BAD_DRAFT |COVER_AMBIGUOUS |PUBLISH_REQUIREMENTS |BAD_CANVAS_FILE |IMPORT_LANGUAGE_MISMATCH |IMPORT_SETTINGS_CHOICE_REQUIRED /.test(
        code
      )
        ? message + ' (' + code.slice(0, 90) + ')'
        : message
  return '요청을 처리하지 못했어요. (' + code.slice(0, 80) + ')'
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
function indexes(v: unknown, length: number): number[] | null {
  if (v == null) return null
  if (!Array.isArray(v)) throw new Error('BAD_INDEX')
  const out = v.map((n) => Number(n))
  if (out.some((n) => !Number.isInteger(n) || n < 0 || n >= length)) throw new Error('BAD_INDEX')
  return out
}
function pick<T>(items: T[], which: unknown): (T & { index: number })[] {
  const wanted = indexes(which, items.length)
  return (wanted ?? items.map((_, i) => i)).map((i) => ({ index: i, ...items[i] }))
}

// ───────────── 긴 본문 나눠 주기 ─────────────
// 도구 결과가 너무 크면 부르는 AI 쪽에서 잘리거나 버려진다. 한 번에 주는 본문을 max_chars로 묶는다.

export const READ_MAX_DEFAULT = 20_000
const READ_MAX_MIN = 1_000
const READ_MAX_MAX = 100_000

/** max_chars 입력 → 실제 한도 (기본 20,000, 1,000~100,000 안으로 맞춘다) */
export function maxChars(v: unknown): number {
  if (v === undefined || v === null) return READ_MAX_DEFAULT
  const n = Number(v)
  if (!Number.isFinite(n)) throw new Error('BAD_RANGE max_chars')
  return Math.min(READ_MAX_MAX, Math.max(READ_MAX_MIN, Math.floor(n)))
}

/** offset부터 max자까지. 이모지처럼 두 칸인 글자를 반으로 자르지 않는다 */
function cut(text: string, offset: number, max: number): string {
  let end = Math.min(text.length, offset + max)
  if (end < text.length && end > offset + 1 && /[\uD800-\uDBFF]/.test(text[end - 1])) end--
  return text.slice(offset, end)
}

interface FieldPart {
  total: number
  offset: number
  next_offset: number | null
}

/**
 * fields로 고른 칸의 본문. 칸 하나가 max_chars를 넘으면 그만큼만 주고 content_parts에 그 칸의
 * total·offset·next_offset을 적는다(넘지 않는 칸은 예전 모양 그대로). offset은 칸을 하나만 골랐을 때만 받는다.
 * sumLimit이면 칸들의 본문 합도 max_chars 안으로 묶어, 넘친 뒤 칸은 본문 없이 길이만 준다.
 */
function readFields(
  body: WorkBody,
  wanted: unknown,
  args: Record<string, unknown>,
  sumLimit = false
): Record<string, unknown> {
  const max = maxChars(args.max_chars)
  const offsetGiven = args.offset !== undefined && args.offset !== null
  if (wanted == null) {
    if (offsetGiven) throw new Error('BAD_RANGE offset')
    return { content: {} }
  }
  if (!Array.isArray(wanted)) throw new Error('BAD_FIELD')
  for (const name of wanted)
    if (typeof name !== 'string' || !(name in body.fields)) throw new Error('BAD_FIELD')
  const names = wanted as string[]
  let start = 0
  if (offsetGiven) {
    const n = Number(args.offset)
    if (names.length !== 1 || !Number.isInteger(n) || n < 0) throw new Error('BAD_RANGE offset')
    const total = body.fields[names[0]].length
    if (n > 0 && n >= total) throw new Error('BAD_RANGE offset')
    start = n
  }
  const content: Record<string, string> = {}
  const parts: Record<string, FieldPart> = {}
  const omitted: { field: string; length: number }[] = []
  let used = 0
  for (const name of names) {
    const text = body.fields[name]
    const piece = cut(text, start, max)
    if (sumLimit && (omitted.length || (used > 0 && used + piece.length > max))) {
      omitted.push({ field: name, length: textLength(text) })
      continue
    }
    used += piece.length
    content[name] = piece
    const end = start + piece.length
    if (start > 0 || end < text.length)
      parts[name] = {
        total: textLength(text),
        offset: start,
        next_offset: end < text.length ? end : null
      }
  }
  return {
    content,
    ...(Object.keys(parts).length
      ? {
          content_parts: parts,
          content_note:
            'content_parts에 나온 칸은 일부만 줬어요. 이어 읽으려면 fields에 그 칸 하나와 offset(next_offset)을 주세요.'
        }
      : {}),
    ...(omitted.length
      ? {
          truncated: true,
          omitted_fields: omitted,
          note:
            '본문 합이 max_chars(' +
            max +
            '자)를 넘어 omitted_fields의 칸은 본문 없이 길이만 줬어요. fields에 칸을 나눠 다시 읽어 주세요.'
        }
      : {})
  }
}

/**
 * 로어북·시작 상황·캐릭터 목록 읽기. 본문 합이 max_chars를 넘으면 그 뒤 항목은 본문 없이 길이만 준다
 * (첫 항목은 늘 본문째 준다).
 */
function budgeted<T>(
  items: (T & { index: number })[],
  bodyLength: (item: T) => number,
  head: (item: T & { index: number }) => Record<string, unknown>,
  max: number
): { list: unknown[]; extra: Record<string, unknown> } {
  let used = 0
  const omitted: number[] = []
  const list = items.map((item, i) => {
    const length = bodyLength(item)
    if (!omitted.length && (i === 0 || used + length <= max)) {
      used += length
      return item
    }
    omitted.push(item.index)
    return { ...head(item), length, omitted: true }
  })
  return {
    list,
    extra: omitted.length
      ? {
          truncated: true,
          omitted_indexes: omitted,
          note:
            '본문 합이 max_chars(' +
            max +
            '자)를 넘어 index ' +
            omitted[0] +
            '부터는 본문 없이 길이만 줬어요. indexes로 나눠 읽어 주세요.'
        }
      : {}
  }
}
const lengths = (body: WorkBody): Record<string, number> =>
  Object.fromEntries(Object.entries(body.fields).map(([k, v]) => [k, textLength(v)]))

const site = { type: 'string', description: '플랫폼 이름 (sites_list의 site. 예: eden, 에덴)' }
const workId = { type: 'string', description: '작품 번호 (works_list의 id)' }
const indexList = {
  type: 'array',
  items: { type: 'integer' },
  description: '읽을 번호들 (work_read의 index). 비우면 전부'
}
const LIST_BUDGET_NOTE =
  ' 본문 합이 max_chars(기본 20000)를 넘으면 뒤 항목은 본문 없이 길이만 주고 truncated: true를 붙인다(indexes로 나눠 읽는다).'
const maxCharsInput = {
  type: 'integer',
  description: '한 번에 받을 본문 글자 수 한도 (기본 20000, 1000~100000)'
}
const offsetInput = {
  type: 'integer',
  description:
    'fields에 칸을 하나만 줬을 때 그 칸을 이 글자 위치부터 읽는다 (content_parts의 next_offset)'
}

export function createWorkTools(deps: WorkToolDeps): ToolDef[] {
  // 같은 작품의 로어북·시작 상황·캐릭터를 이어서 읽을 때 사이트를 다시 부르지 않는다.
  const cache = new Map<string, WorkBody>()

  async function load(
    siteName: unknown,
    id: unknown,
    fresh: boolean
  ): Promise<{
    body: WorkBody
    snapshot: string | null
  }> {
    const adapter = workAdapter(str(siteName))
    const key = adapter.id + ':' + workKey(adapter, str(id))
    const held = cache.get(key)
    if (!fresh && held) return { body: held, snapshot: null }
    const raw = await adapter.readRaw(deps.reader(adapter.id), str(id))
    const body = adapter.normalize(raw)
    const snapshot = await deps.snapshot(adapter.id, workKey(adapter, str(id)), raw)
    cache.set(key, body)
    return { body, snapshot }
  }

  return [
    ...readTools(),
    createStatusTool(deps.worksStatus ? () => deps.worksStatus!() : undefined),
    // 저장하면 들고 있던 본문이 낡으므로 버린다
    ...createSaveTools(deps, (key) => cache.delete(key)),
    ...createEditionTools(deps),
    ...createMediaTools(deps, (key) => cache.delete(key)),
    ...createCanvasTools(deps, (key) => cache.delete(key))
  ]

  function readTools(): ToolDef[] {
    return [
      {
        name: 'sites_list',
        description:
          '작품 본문을 읽을 수 있는 플랫폼과 각 플랫폼이 지원하는 기능을 돌려준다. guide에 플랫폼별 안내가 있다: ' +
          'save = 저장하면 생기는 일, manual = 이 도구로 못 해서 사이트에서 직접 할 일, unverified = 실제 계정에서 ' +
          '아직 확인하지 않은 동작. 처음 쓰는 플랫폼은 저장 전에 guide를 읽는다.',
        inputSchema: { type: 'object', properties: {} },
        async run() {
          return {
            sites: Object.values(WORK_ADAPTERS).map((a) => ({
              site: a.id,
              label: a.label,
              capabilities: a.capabilities,
              visibilities: a.visibilities ?? [],
              can_delete: !!a.remove,
              can_create: !!a.create,
              can_images: !!a.applyImages,
              can_cover: !!a.uploadCover,
              can_edition_save: !!a.saveEdition,
              can_canvas: canCanvas(a),
              guide: a.guide
                ? {
                    save: a.guide.save,
                    manual: a.guide.manual,
                    unverified: a.guide.unverified ?? []
                  }
                : null
            })),
            manual_everywhere: MANUAL_EVERYWHERE
          }
        }
      },
      {
        name: 'works_list',
        description:
          '그 플랫폼에 올린 내 작품 목록. query를 주면 제목에 그 글자가 들어간 작품만 돌려준다.',
        inputSchema: {
          type: 'object',
          properties: { site, query: { type: 'string', description: '제목 검색어 (선택)' } },
          required: ['site']
        },
        async run(args) {
          const adapter = workAdapter(str(args.site))
          const q = str(args.query).trim().toLowerCase()
          const works = (await adapter.list(deps.reader(adapter.id))).filter(
            (w) => !q || w.title.toLowerCase().includes(q)
          )
          return { site: adapter.id, count: works.length, works }
        }
      },
      {
        name: 'work_read',
        description:
          '작품 하나를 플랫폼에서 새로 읽는다. 기본은 개요(칸별 글자 수, 로어북·시작 상황·캐릭터 제목 목록, ' +
          '스냅샷 파일 경로)만 돌려준다. fields에 title / subtitle / description / main / creator_comment를 ' +
          '넣으면 그 칸의 본문을 같이 준다. 칸 하나가 max_chars(기본 20000)를 넘으면 그만큼만 주고 ' +
          'content_parts에 total·offset·next_offset을 적는다. 이어 읽기는 fields에 그 칸 하나와 offset. ' +
          '읽을 때마다 플랫폼 원본 전체가 snapshot 경로의 JSON 파일로 남는다.',
        inputSchema: {
          type: 'object',
          properties: {
            site,
            work_id: workId,
            fields: {
              type: 'array',
              items: { type: 'string' },
              description: '본문을 받을 칸 (선택)'
            },
            max_chars: maxCharsInput,
            offset: offsetInput
          },
          required: ['site', 'work_id']
        },
        async run(args) {
          const { body, snapshot } = await load(args.site, args.work_id, true)
          return {
            id: body.id,
            title: body.title,
            visibility: body.visibility,
            status: body.status,
            updated_at: body.updatedAt,
            field_lengths: lengths(body),
            ...readFields(body, args.fields, args),
            lorebook: body.lorebook.map((e, index) => ({
              index,
              title: e.title,
              keys: e.keys,
              mode: e.mode,
              length: textLength(e.content)
            })),
            start_scenarios: body.startScenarios.map((s, index) => ({
              index,
              title: s.title,
              is_default: s.isDefault,
              length: textLength(s.content)
            })),
            characters: body.characters.map((c, index) => ({
              index,
              name: c.name,
              is_main: c.isMain,
              length: textLength(c.details),
              images: c.imageCount
            })),
            snapshot
          }
        }
      },
      {
        name: 'lorebook_read',
        description:
          '로어북 항목의 본문. indexes를 비우면 전부, 주면 그 번호만 돌려준다.' + LIST_BUDGET_NOTE,
        inputSchema: {
          type: 'object',
          properties: { site, work_id: workId, indexes: indexList, max_chars: maxCharsInput },
          required: ['site', 'work_id']
        },
        async run(args) {
          const { body } = await load(args.site, args.work_id, false)
          const { list, extra } = budgeted(
            pick(body.lorebook, args.indexes),
            (e) => textLength(e.content),
            (e) => ({ index: e.index, title: e.title, keys: e.keys, mode: e.mode }),
            maxChars(args.max_chars)
          )
          return { entries: list, ...extra }
        }
      },
      {
        name: 'start_scenarios_read',
        description: '시작 상황의 본문. indexes를 비우면 전부 돌려준다.' + LIST_BUDGET_NOTE,
        inputSchema: {
          type: 'object',
          properties: { site, work_id: workId, indexes: indexList, max_chars: maxCharsInput },
          required: ['site', 'work_id']
        },
        async run(args) {
          const { body } = await load(args.site, args.work_id, false)
          const { list, extra } = budgeted(
            pick(body.startScenarios, args.indexes),
            (s) =>
              textLength(s.content) +
              textLength(s.subPrompt) +
              textLength(s.dialogue) +
              textLength(s.situation) +
              textLength(s.description),
            (s) => ({ index: s.index, id: s.id, title: s.title, isDefault: s.isDefault }),
            maxChars(args.max_chars)
          )
          return { scenarios: list, ...extra }
        }
      },
      {
        name: 'characters_read',
        description: '캐릭터 설정 본문. indexes를 비우면 전부 돌려준다.' + LIST_BUDGET_NOTE,
        inputSchema: {
          type: 'object',
          properties: { site, work_id: workId, indexes: indexList, max_chars: maxCharsInput },
          required: ['site', 'work_id']
        },
        async run(args) {
          const { body } = await load(args.site, args.work_id, false)
          const { list, extra } = budgeted(
            pick(body.characters, args.indexes),
            (c) => textLength(c.details) + textLength(c.info),
            (c) => ({ index: c.index, id: c.id, name: c.name, isMain: c.isMain }),
            maxChars(args.max_chars)
          )
          return { characters: list, ...extra }
        }
      },
      {
        name: 'editions_list',
        description:
          '언어 판본 목록 (판본이 있는 플랫폼만). 판본별 존재 여부·상태·원문 대비 낡음 여부를 돌려준다.',
        inputSchema: {
          type: 'object',
          properties: { site, work_id: workId },
          required: ['site', 'work_id']
        },
        async run(args) {
          const adapter = workAdapter(str(args.site))
          if (!adapter.editions) throw new Error('NO_EDITIONS')
          return { editions: await adapter.editions(deps.reader(adapter.id), str(args.work_id)) }
        }
      },
      {
        name: 'edition_read',
        description:
          '언어 판본 하나를 읽는다. 기본은 개요, fields를 주면 그 칸의 본문을 같이 준다. ' +
          'language는 editions_list의 language (예: en, ja, zh-TW, zh-CN). 긴 칸은 work_read처럼 ' +
          'max_chars·offset으로 나눠 읽고, 칸들의 본문 합이 max_chars를 넘으면 뒤 칸은 길이만 준다(truncated).',
        inputSchema: {
          type: 'object',
          properties: {
            site,
            work_id: workId,
            language: { type: 'string', description: '언어 코드' },
            fields: {
              type: 'array',
              items: { type: 'string' },
              description: '본문을 받을 칸 (선택)'
            },
            max_chars: maxCharsInput,
            offset: offsetInput
          },
          required: ['site', 'work_id', 'language']
        },
        async run(args) {
          const adapter = workAdapter(str(args.site))
          if (!adapter.readEditionRaw || !adapter.normalizeEdition) throw new Error('NO_EDITIONS')
          const id = str(args.work_id)
          const raw = await adapter.readEditionRaw(deps.reader(adapter.id), id, str(args.language))
          const body = adapter.normalizeEdition(raw)
          const snapshot = await deps.snapshot(
            adapter.id,
            id.toLowerCase() + '__' + str(args.language),
            raw
          )
          return {
            language: body.language,
            exists: body.exists,
            status: body.status,
            stale: body.stale,
            field_lengths: lengths(body),
            ...readFields(body, args.fields, args, true),
            lorebook_count: body.lorebook.length,
            start_scenario_count: body.startScenarios.length,
            character_count: body.characters.length,
            snapshot
          }
        }
      }
    ]
  }
}
