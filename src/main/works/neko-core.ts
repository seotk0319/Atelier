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

/** 편집 데이터(character) → 편집기 폼 (loadCharacterForEdit가 폼을 채우는 방식 그대로) */
export function nekoForm(n: Obj): Obj {
  const greeting = Array.isArray(n.greeting) ? strings(n.greeting) : [text(n.greeting)]
  return {
    displayName: text(n.displayName),
    description: text(n.description),
    shortDescription: text(n.shortDescription),
    narrationMode: text(n.narrationMode) || 'narrator',
    systemPrompt: text(n.systemPrompt),
    persistentContext: text(n.persistentContext),
    auxiliaryPrompts: list(n.auxiliaryPrompts),
    greeting,
    greetingSettings: greetingSettings(n.greetingSettings, greeting.length),
    categoryIds: strings(n.categoryIds),
    tags: strings(n.tags),
    characterAudience: text(n.characterAudience),
    isIncentiveEnabled:
      n.isIncentiveEnabled === undefined || n.isIncentiveEnabled === null || !!n.isIncentiveEnabled,
    isPublic: !!n.isPublic,
    showCreatorHandle: n.showCreatorHandle !== false,
    isMarketingConsent: !!n.isMarketingConsent,
    isLinkShareOnly: !!n.isLinkShareOnly,
    isNsfw: n.isNsfw,
    isShared: !!n.isShared,
    language: n.language,
    lorebook: list(n.lorebook),
    loreBudget: typeof n.loreBudget === 'number' ? n.loreBudget : 100_000,
    lorebookImportCharacterIds: strings(n.lorebookImportCharacterIds),
    imageSlots: list(n.imageSlots).map((e) => ({
      ...e,
      isVisible: e.isVisible === undefined || e.isVisible === null || !!e.isVisible,
      isAlwaysVisible: !!e.isAlwaysVisible
    })),
    imageSlotFolders: list(n.imageSlotFolders),
    personaTemplates: n.personaTemplates || undefined,
    slashCommands: n.slashCommands || undefined,
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
