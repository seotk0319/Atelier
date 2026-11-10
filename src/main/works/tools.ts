// MCP로 내놓는 작품 도구. 여기는 화면·Electron을 모르고, 읽기 통로와 스냅샷 저장만 받아서 쓴다.
// 읽기 도구는 여기, 계획·저장 도구는 save-tools.ts, 언어 판본 저장은 edition-tools.ts,
// 이미지·표지는 media-tools.ts에 있다.
import { WORK_ADAPTERS, workAdapter, workKey } from './adapters'
import { createEditionTools } from './edition-tools'
import { createMediaTools } from './media-tools'
import { createSaveTools } from './save-tools'
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
    '제목이 맞지 않아서 지우지 않았어요. work_delete_plan이 돌려준 제목을 그대로 넣어 주세요.'
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
  [/BAD_FILE/, '파일을 읽지 못했어요. 글 칸은 .md / .txt, 로어북은 .json이고 1MB 이하여야 해요.'],
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
  [/NOT_OWNER/, '내 계정의 작품이 아니에요.']
]
export function toolMessage(error: unknown): string {
  const code = error instanceof Error ? error.message : String(error)
  for (const [re, message] of MESSAGES)
    if (re.test(code))
      // 플랫폼이 거절한 경우는 받은 상태 코드도 같이 알려 준다
      return /_FAILED |BAD_DRAFT |COVER_AMBIGUOUS |PUBLISH_REQUIREMENTS /.test(code)
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
function fieldsOf(body: WorkBody, wanted: unknown): Record<string, string> {
  if (wanted == null) return {}
  if (!Array.isArray(wanted)) throw new Error('BAD_FIELD')
  const out: Record<string, string> = {}
  for (const name of wanted) {
    if (typeof name !== 'string' || !(name in body.fields)) throw new Error('BAD_FIELD')
    out[name] = body.fields[name]
  }
  return out
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
    // 저장하면 들고 있던 본문이 낡으므로 버린다
    ...createSaveTools(deps, (key) => cache.delete(key)),
    ...createEditionTools(deps),
    ...createMediaTools(deps, (key) => cache.delete(key))
  ]

  function readTools(): ToolDef[] {
    return [
      {
        name: 'sites_list',
        description: '작품 본문을 읽을 수 있는 플랫폼과 각 플랫폼이 지원하는 기능을 돌려준다.',
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
              can_edition_save: !!a.saveEdition
            }))
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
          '넣으면 그 칸의 본문을 같이 준다. 읽을 때마다 플랫폼 원본 전체가 snapshot 경로의 JSON 파일로 남는다.',
        inputSchema: {
          type: 'object',
          properties: {
            site,
            work_id: workId,
            fields: {
              type: 'array',
              items: { type: 'string' },
              description: '본문을 받을 칸 (선택)'
            }
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
            content: fieldsOf(body, args.fields),
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
        description: '로어북 항목의 본문. indexes를 비우면 전부, 주면 그 번호만 돌려준다.',
        inputSchema: {
          type: 'object',
          properties: { site, work_id: workId, indexes: indexList },
          required: ['site', 'work_id']
        },
        async run(args) {
          const { body } = await load(args.site, args.work_id, false)
          return { entries: pick(body.lorebook, args.indexes) }
        }
      },
      {
        name: 'start_scenarios_read',
        description: '시작 상황의 본문. indexes를 비우면 전부 돌려준다.',
        inputSchema: {
          type: 'object',
          properties: { site, work_id: workId, indexes: indexList },
          required: ['site', 'work_id']
        },
        async run(args) {
          const { body } = await load(args.site, args.work_id, false)
          return { scenarios: pick(body.startScenarios, args.indexes) }
        }
      },
      {
        name: 'characters_read',
        description: '캐릭터 설정 본문. indexes를 비우면 전부 돌려준다.',
        inputSchema: {
          type: 'object',
          properties: { site, work_id: workId, indexes: indexList },
          required: ['site', 'work_id']
        },
        async run(args) {
          const { body } = await load(args.site, args.work_id, false)
          return { characters: pick(body.characters, args.indexes) }
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
          'language는 editions_list의 language (예: en, ja, zh-TW, zh-CN).',
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
            }
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
            content: fieldsOf(body, args.fields),
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
