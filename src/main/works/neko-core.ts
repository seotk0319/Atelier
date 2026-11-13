// 네코챗 연결부가 같이 쓰는 주소·모양·저장 함수 (neko.ts와 neko-media.ts가 함께 쓴다).
// 근거: 2026-11-10 네코챗 캐릭터 편집기 공개 스크립트(/characters/create 화면, 59998 묶음):
//   loadCharacterForEdit → GET /api/users/me/characters/{id} → {character}
//   편집 폼 = character를 옮긴 값 (displayName, systemPrompt, greeting[], lorebook[] …)
//   저장 → PUT /api/characters  JSON {…폼, characterId, notifyFollowers, avatar:{url, alt}, uploadedImageUrls?}
// 네코챗은 사이트 쿠키로 로그인을 확인한다 (알림 통로도 쿠키만 쓴다).
import type { FileRules, WorkWrite } from './types'

export const NEKO_ORIGIN = 'https://www.nekochat.xyz'
export const NEKO_CHARACTERS = NEKO_ORIGIN + '/api/characters'
export const NEKO_MINE = NEKO_ORIGIN + '/api/users/me/characters'
// 작품 번호: char_{시각}_{base36 7자} (편집기의 임시 번호 생성식과 같은 모양)
export const CHAR = 'char_[0-9]+_[a-z0-9]+'
export const CHAR_RE = new RegExp('^' + CHAR + '$', 'i')

// 편집기 업로드 규칙: png·jpeg·jpg·webp, 정지 이미지 4,718,592바이트 (UPLOAD_LIMITS.DEFAULT, 이미지 슬롯 MAX_FILE_SIZE)
export const NEKO_IMAGE_RULES: FileRules = {
  extensions: ['webp', 'png', 'jpg', 'jpeg'],
  maxBytes: 4_718_592
}

export type Obj = Record<string, unknown>
export const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
export const list = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter(isObj) : [])
export const text = (v: unknown): string => (typeof v === 'string' ? v : '')
export const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)
export const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []

export async function nekoJson(res: Response): Promise<unknown> {
  if (res.status === 401 || res.status === 403) throw new Error('LOGIN_REQUIRED')
  if (res.status === 404) throw new Error('WORK_NOT_FOUND')
  if (!res.ok) throw new Error('WORK_READ_FAILED ' + res.status)
  return res.json()
}
export function nekoWorkId(id: string): string {
  if (!CHAR_RE.test(id)) throw new Error('BAD_WORK_ID')
  return id
}
export function at(index: unknown, length: number): number {
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= length)
    throw new Error('BAD_INDEX')
  return index
}
/** 네코챗 주소이고 경로가 맞는지. query를 주면 쿼리도 그 검사로 본다 (주지 않으면 쿼리가 없어야 한다) */
export function nekoPlain(
  url: string,
  paths: RegExp[],
  query?: (q: URLSearchParams) => boolean
): boolean {
  try {
    const u = new URL(url)
    return (
      u.origin === NEKO_ORIGIN &&
      !u.username &&
      !u.password &&
      !u.hash &&
      (query ? query(u.searchParams) : !u.search) &&
      paths.some((re) => re.test(u.pathname))
    )
  } catch {
    return false
  }
}

const GREETING_TITLE_MAX = 100
/** 첫상황 기본 제목 (편집기: "첫상황 N") */
export const greetingTitle = (i: number): string => '첫상황 ' + (i + 1)
/** 첫상황 설정을 첫상황 수에 맞춘다 (편집기 normalizeGreetingSettings) */
export function greetingSettings(v: unknown, count: number): Obj[] {
  const out = list(v)
    .slice(0, count)
    .map((e, i) => ({
      title:
        typeof e.title === 'string' && e.title.trim()
          ? e.title.trim().slice(0, GREETING_TITLE_MAX)
          : greetingTitle(i),
      includeLorebook: !!e.includeLorebook,
      isEditable: e.isEditable === undefined || !!e.isEditable
    }))
  while (out.length < count)
    out.push({ title: greetingTitle(out.length), includeLorebook: false, isEditable: true })
  return out
}

export interface NekoRaw {
  id: string
  character: Obj
}
export function nekoRaw(raw: unknown): NekoRaw {
  if (!isObj(raw) || !strOrNull(raw.id) || !isObj(raw.character)) throw new Error('WORK_SHAPE')
  return raw as unknown as NekoRaw
}

/** 원본에 값이 있으면(null 아님) 그대로, 없음·null이면 예전부터 보내던 기본값 */
const orElse = (v: unknown, fallback: unknown): unknown =>
  v === undefined || v === null ? fallback : v

/** 편집 데이터(character) → 저장 본문의 뼈대. 설정값은 원본 값을 그대로 싣고, 원본에 없음·null일 때만 예전부터 보내던 기본값을 채운다 */
export function nekoForm(n: Obj): Obj {
  const greeting = Array.isArray(n.greeting) ? strings(n.greeting) : [text(n.greeting)]
  return {
    displayName: text(n.displayName),
    description: text(n.description),
    shortDescription: text(n.shortDescription),
    narrationMode: orElse(n.narrationMode, 'narrator'),
    systemPrompt: text(n.systemPrompt),
    persistentContext: text(n.persistentContext),
    auxiliaryPrompts: list(n.auxiliaryPrompts),
    greeting,
    greetingSettings: greetingSettings(n.greetingSettings, greeting.length),
    categoryIds: strings(n.categoryIds),
    tags: strings(n.tags),
    characterAudience: orElse(n.characterAudience, ''),
    isIncentiveEnabled: orElse(n.isIncentiveEnabled, true),
    isPublic: n.isPublic,
    showCreatorHandle: n.showCreatorHandle !== false,
    isMarketingConsent: orElse(n.isMarketingConsent, false),
    isLinkShareOnly: orElse(n.isLinkShareOnly, false),
    isNsfw: n.isNsfw,
    isShared: orElse(n.isShared, false),
    language: n.language,
    lorebook: list(n.lorebook),
    loreBudget: typeof n.loreBudget === 'number' ? n.loreBudget : 100_000,
    lorebookImportCharacterIds: strings(n.lorebookImportCharacterIds),
    imageSlots: list(n.imageSlots).map((s) => ({
      ...s,
      isVisible: orElse(s.isVisible, true),
      isAlwaysVisible: orElse(s.isAlwaysVisible, false)
    })),
    imageSlotFolders: list(n.imageSlotFolders),
    personaTemplates: n.personaTemplates || undefined,
    slashCommands: n.slashCommands || undefined,
    // 편집기 폼 채우기가 항상 false로 둔다 (loadCharacterForEdit의 isDraftMode:!1)
    isDraftMode: false
  }
}
/** 공개 상태: public(공개) / link(링크 공개) / private(비공개) — 편집기의 세 칸 선택지 */
export function nekoVisibility(n: Obj): string {
  return n.isPublic ? (n.isLinkShareOnly ? 'link' : 'public') : 'private'
}
export const avatarUrl = (n: Obj): string => (isObj(n.avatar) ? text(n.avatar.url) : '')

/**
 * 편집 데이터를 저장한다 (편집기 handleSubmit의 수정 경로).
 * PUT /api/characters {…폼(avatar 뺌), characterId, notifyFollowers:false, avatar:{url, alt}, uploadedImageUrls?}
 */
export async function nekoPut(
  write: WorkWrite,
  id: string,
  character: Obj,
  uploaded: string[] = []
): Promise<Obj> {
  // 공개 여부를 모르는 채로는 보내지 않는다 (없는 값을 임의로 채우면 공개 범위가 바뀔 수 있다)
  if (typeof character.isPublic !== 'boolean') throw new Error('UNKNOWN_VISIBILITY')
  const form = nekoForm(character)
  delete form.avatar
  const url = avatarUrl(character)
  const res = await write('PUT', NEKO_CHARACTERS, {
    ...form,
    characterId: id,
    // 팔로워 알림은 항상 끈다
    notifyFollowers: false,
    ...(url.trim() ? { avatar: { url, alt: text(form.displayName) + ' 프로필 이미지' } } : {}),
    ...(uploaded.length ? { uploadedImageUrls: uploaded } : {})
  })
  if (res.status === 401 || res.status === 403) throw new Error('LOGIN_REQUIRED')
  if (res.status === 404) throw new Error('WORK_NOT_FOUND')
  const reply: unknown = await res.json().catch(() => null)
  if (!res.ok)
    throw new Error(
      'SAVE_FAILED ' + res.status + ' ' + text(isObj(reply) ? reply.error : '').slice(0, 80)
    )
  return isObj(reply) ? reply : {}
}

/** 편집 데이터 읽기 */
export async function nekoReadRaw(
  read: (url: string) => Promise<Response>,
  id: string
): Promise<NekoRaw> {
  const wid = nekoWorkId(id)
  const got = await nekoJson(await read(NEKO_MINE + '/' + wid))
  if (!isObj(got) || !isObj(got.character)) throw new Error('WORK_SHAPE')
  return { id: wid, character: got.character }
}

const EXTRA_TEXT_MAX = 80
const EXTRA_LIST_MAX = 20
/**
 * 공통 칸에 들지 않는 원본 설정 (work_read의 extras, 읽기 전용). 원본에 실제로 있는 칸만 싣고,
 * 짧은 값은 그대로, 목록은 개수로 줄인다. 작품 본문·주소·계정 번호와, 읽을 때마다 달라지는 통계
 * (popularity·likeCount·isLiked)는 싣지 않는다 (계획 뒤 변화 감지가 깨진다).
 */
export function nekoExtras(c: Obj): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const flag = (key: string, v: unknown): void => {
    if (typeof v === 'boolean') out[key] = v
  }
  const word = (key: string, v: unknown): void => {
    if (typeof v === 'string' && v && v.length <= EXTRA_TEXT_MAX) out[key] = v
  }
  const num = (key: string, v: unknown): void => {
    if (typeof v === 'number' && Number.isFinite(v)) out[key] = v
  }
  const count = (key: string, v: unknown, keep?: (e: Obj) => boolean): void => {
    if (Array.isArray(v)) out[key] = keep ? list(v).filter(keep).length : v.length
  }
  // 짧은 글 목록은 그대로, 아니면 개수 (이름_count)
  const words = (key: string, countKey: string, v: unknown): void => {
    if (!Array.isArray(v)) return
    const items = strings(v)
    if (
      items.length === v.length &&
      items.length <= EXTRA_LIST_MAX &&
      items.every((s) => s.length <= EXTRA_TEXT_MAX)
    )
      out[key] = items
    else out[countKey] = v.length
  }

  words('tags', 'tag_count', c.tags)
  words('category_ids', 'category_count', c.categoryIds)
  words('curation_tags', 'curation_tag_count', c.curationTags)
  word('character_audience', c.characterAudience)
  word('narration_mode', c.narrationMode)
  word('language', c.language)
  flag('is_nsfw', c.isNsfw)
  flag('is_shared', c.isShared)
  flag('is_active', c.isActive)
  flag('is_incentive_enabled', c.isIncentiveEnabled)
  flag('is_marketing_consent', c.isMarketingConsent)
  flag('show_creator_handle', c.showCreatorHandle)
  flag('show_creator_profile', c.showCreatorProfile)
  num('version', c.version)
  word('created_at', c.createdAt)
  out.has_cover_image = !!avatarUrl(c).trim()
  num('lore_budget', c.loreBudget)
  count('lore_disabled_count', c.lorebook, (e) => e.isEnabled === false)
  count('lore_exported_count', c.lorebook, (e) => e.isExported === true)
  count('lorebook_import_count', c.lorebookImportCharacterIds)
  count('auxiliary_prompt_count', c.auxiliaryPrompts)
  count('persona_template_count', c.personaTemplates)
  count('slash_command_count', c.slashCommands)
  count('image_slot_count', c.imageSlots)
  count('image_slot_hidden_count', c.imageSlots, (e) => e.isVisible === false)
  count(
    'image_slot_trigger_count',
    c.imageSlots,
    (e) => Array.isArray(e.triggerKeywords) && e.triggerKeywords.length > 0
  )
  count('image_slot_folder_count', c.imageSlotFolders)
  count('start_scenario_lorebook_count', c.greetingSettings, (e) => e.includeLorebook === true)
  count('start_scenario_locked_count', c.greetingSettings, (e) => e.isEditable === false)
  return out
}

/** 사이트에는 있는데 이 연결부가 읽지 못하는 것 (비어 보여도 "없음"이 아니다) */
export const NEKO_UNSUPPORTED = [
  '보조 프롬프트 내용',
  '로어북 항목별 켬끔·순서',
  '이미지 슬롯 트리거·폴더',
  '유저 페르소나 템플릿 내용',
  '슬래시 명령 내용',
  'JSX 렌더러',
  '네코 모바일 설정',
  '댓글·좋아요 통계',
  '시트 검수 결과'
]
