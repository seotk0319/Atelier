// 네코챗 작품 본문 읽기·저장. 주소와 필드는 2026-11-10 네코챗 편집기 공개 스크립트에서 읽었다 (실제 호출 전).
//   GET    /api/users/me/characters                    내 작품 목록 {characters}
//   GET    /api/users/me/characters/{id}               편집 데이터 {character}
//   PUT    /api/characters                             저장 (neko-core.ts nekoPut, 본문에 characterId)
//   POST   /api/characters                             새 작품 (본문에 편집기가 만든 임시 번호 characterId)
//   DELETE /api/characters?characterId={id}            작품 삭제
// 캐릭터는 작품 하나에 하나라 characters는 비어 있다. 첫상황(greeting[])이 시작 상황이다.
// 글 칸: title=displayName, subtitle=shortDescription(짧은 설명), description=description(캐릭터 설명),
//        main=systemPrompt(캐릭터 페르소나), persistent_context=persistentContext(상시 컨텍스트).
import { randomInt } from 'node:crypto'
import {
  CHAR,
  CHAR_RE,
  NEKO_CHARACTERS,
  NEKO_IMAGE_RULES,
  NEKO_MINE,
  at,
  avatarUrl,
  greetingSettings,
  greetingTitle,
  isObj,
  list,
  nekoForm,
  nekoJson,
  nekoPlain,
  nekoPut,
  nekoRaw,
  nekoReadRaw,
  nekoVisibility,
  nekoWorkId,
  strOrNull,
  strings,
  text,
  type NekoRaw,
  type Obj
} from './neko-core'
import {
  nekoApplyImages,
  nekoImageGroups,
  nekoPlanImages,
  nekoSendRule,
  nekoUploadAvatar,
  nekoUploadCover
} from './neko-media'
import type {
  LoreEntry,
  WorkAdapter,
  WorkBody,
  WorkDraft,
  WorkFetch,
  WorkListItem,
  WorkWrite
} from './types'

const READ_PATHS = [
  /^\/api\/users\/me\/characters$/,
  new RegExp('^/api/users/me/characters/' + CHAR + '$', 'i')
]
const CHARACTERS_PATH = [/^\/api\/characters$/]
const VISIBILITIES = ['public', 'link', 'private']

// 편집기 입력 규칙 (CHARACTER_LIMITS, LOREBOOK_LIMITS)
const LIMITS = {
  displayName: 80,
  description: 200_000,
  shortDescription: 1000,
  systemPrompt: 300_000,
  persistentContext: 50_000,
  greeting: 20_000,
  greetings: 10,
  loreName: 200,
  loreContent: 10_000,
  loreKeysText: 500,
  loreKeys: 25,
  loreNegativeKeys: 5,
  loreEntries: 500,
  tag: 20,
  tags: 10
}
const FIELDS: Record<string, string> = {
  title: 'displayName',
  subtitle: 'shortDescription',
  description: 'description',
  main: 'systemPrompt',
  persistent_context: 'persistentContext'
}
// 비어 있으면 안 되는 칸
const REQUIRED = new Set(['displayName', 'shortDescription', 'description', 'systemPrompt'])

function checkFields(c: Obj): void {
  for (const [name, key] of Object.entries(FIELDS)) {
    const value = text(c[key])
    const max = LIMITS[key as keyof typeof LIMITS]
    if ((REQUIRED.has(key) && !value.trim()) || value.length > max)
      throw new Error('BAD_FIELD ' + name + (REQUIRED.has(key) ? ' 1~' : ' ~') + max + '자')
  }
}
function checkStarts(c: Obj): void {
  const greeting = strings(c.greeting)
  if (greeting.length < 1 || greeting.length > LIMITS.greetings) throw new Error('START_LIMIT')
  for (const [i, g] of greeting.entries())
    if (!g || g.length > LIMITS.greeting)
      throw new Error('BAD_START start_scenarios[' + i + '].content 1~' + LIMITS.greeting + '자')
  for (const [i, s] of list(c.greetingSettings).entries())
    if (text(s.title).length > 100)
      throw new Error('BAD_START start_scenarios[' + i + '].title 100자')
}
function checkLorebook(c: Obj): void {
  const lores = list(c.lorebook)
  if (lores.length > LIMITS.loreEntries) throw new Error('LOREBOOK_LIMIT')
  for (const [i, e] of lores.entries()) {
    const where = 'lorebook[' + i + ']'
    const name = text(e.name)
    const content = text(e.content)
    const keys = strings(e.keys)
    if (!name || name.length > LIMITS.loreName)
      throw new Error('BAD_LOREBOOK ' + where + '.title 1~' + LIMITS.loreName + '자')
    if (!content || content.length > LIMITS.loreContent)
      throw new Error('BAD_LOREBOOK ' + where + '.content 1~' + LIMITS.loreContent + '자')
    if (
      !keys.length ||
      keys.length > LIMITS.loreKeys ||
      keys.join(', ').length > LIMITS.loreKeysText
    )
      throw new Error('BAD_LOREBOOK ' + where + '.keys 1~25개, 합쳐 500자')
    if (strings(e.negativeKeys).length > LIMITS.loreNegativeKeys)
      throw new Error('BAD_LOREBOOK ' + where + '.off_keys 5개 이하')
  }
}

const keyList = (keys: string): string[] =>
  keys
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean)
// 편집기의 로어 추가 버튼과 같은 번호 모양
const base36 = (n: number): string =>
  Array.from({ length: n }, () => '0123456789abcdefghijklmnopqrstuvwxyz'[randomInt(36)]).join('')
const loreId = (): string => 'lore_' + Date.now() + '_' + base36(7)
/** 공통 로어북 항목 → 네코챗 lore. offKeys = negativeKeys. 발동 방식·턴 값은 네코챗에 없다 */
function loreFrom(entry: Partial<LoreEntry>, base: Obj | undefined, order: number): Obj {
  if (
    (entry.mode !== undefined && entry.mode !== null) ||
    (entry.turnRange !== undefined && entry.turnRange !== null) ||
    (entry.offTurnRange !== undefined && entry.offTurnRange !== null)
  )
    throw new Error('BAD_CHANGES')
  const out: Obj = base
    ? { ...base }
    : {
        id: loreId(),
        name: '',
        content: '',
        keys: [],
        negativeKeys: [],
        isEnabled: true,
        isExported: false,
        isExportedPublic: false,
        order
      }
  if (entry.title !== undefined) out.name = entry.title
  if (entry.content !== undefined) out.content = entry.content
  if (entry.keys !== undefined) out.keys = keyList(entry.keys)
  if (entry.offKeys !== undefined)
    out.negativeKeys = entry.offKeys.map((k) => k.trim()).filter(Boolean)
  return out
}
type StartExtras = {
  subPrompt?: string
  dialogue?: string
  situation?: string
  description?: string
}
/** 네코챗 첫상황은 제목과 글뿐이다 */
function noStartExtras(s: StartExtras): void {
  for (const key of ['subPrompt', 'dialogue', 'situation', 'description'] as const)
    if (s[key] !== undefined && s[key] !== '') throw new Error('BAD_CHANGES')
}
/** 첫상황을 지운 뒤 첫상황에 묶인 보조 프롬프트 번호를 편집기처럼 맞춘다 (지운 첫상황에 묶인 것은 뺀다) */
function shiftAuxiliary(prompts: Obj[], removed: number): Obj[] {
  return prompts.flatMap((p) => {
    const bound = Array.isArray(p.greetingIndexes) ? p.greetingIndexes[0] : undefined
    if (typeof bound !== 'number' || !Number.isInteger(bound) || bound < 0) return [p]
    if (bound === removed) return []
    return bound > removed ? [{ ...p, greetingIndexes: [bound - 1] }] : [p]
  })
}

export const nekoWorks: WorkAdapter = {
  id: 'neko',
  label: '네코챗',
  guide: {
    save: 'JSON으로 저장한다. 편집기가 저장 직후 따로 보내는 JSX 렌더러·네코 모바일 설정은 보내지 않는다.',
    manual: [],
    unverified: [
      '공개작 저장(서버가 시트 검수 결과로 공개 상태를 낮출 수 있다)',
      '저장 뒤 JSX 렌더러·네코 모바일 설정이 그대로인지'
    ]
  },
  capabilities: ['works_list', 'work_read', 'lorebook', 'start_scenarios', 'save', 'images'],

  readAllowed: (url) => nekoPlain(url, READ_PATHS),
  writeAllowed(method, url) {
    if (method === 'PUT' || method === 'POST') return nekoPlain(url, CHARACTERS_PATH)
    if (method === 'DELETE')
      return nekoPlain(url, CHARACTERS_PATH, (q) => {
        const keys = [...q.keys()]
        return (
          keys.length === 1 && keys[0] === 'characterId' && CHAR_RE.test(q.get('characterId') ?? '')
        )
      })
    return false
  },

  async list(read: WorkFetch): Promise<WorkListItem[]> {
    const body = await nekoJson(await read(NEKO_MINE))
    if (!isObj(body) || !Array.isArray(body.characters)) throw new Error('WORK_LIST_SHAPE')
    return list(body.characters).flatMap((w) => {
      const id = strOrNull(w.id)
      return id
        ? [
            {
              id,
              title: text(w.displayName) || text(w.name),
              visibility: nekoVisibility(w),
              status: null,
              updatedAt: strOrNull(w.updatedAt),
              characters: null
            }
          ]
        : []
    })
  },

  readRaw: (read, id) => nekoReadRaw(read, id),

  normalize(raw): WorkBody {
    const r = nekoRaw(raw)
    const c = r.character
    const form = nekoForm(c)
    const greeting = strings(form.greeting)
    const settings = list(form.greetingSettings)
    return {
      id: r.id,
      title: text(form.displayName),
      visibility: nekoVisibility(c),
      status: null,
      updatedAt: strOrNull(c.updatedAt),
      fields: Object.fromEntries(Object.entries(FIELDS).map(([k, key]) => [k, text(form[key])])),
      lorebook: list(form.lorebook).map((e) => ({
        title: text(e.name),
        keys: strings(e.keys).join(', '),
        content: text(e.content),
        mode: null,
        offKeys: strings(e.negativeKeys),
        turnRange: null,
        offTurnRange: null
      })),
      startScenarios: greeting.map((g, i) => ({
        id: null,
        title: text(settings[i]?.title),
        isDefault: i === 0,
        content: g,
        subPrompt: '',
        dialogue: '',
        situation: '',
        description: ''
      })),
      characters: []
    }
  },

  applyChanges(raw, changes) {
    nekoRaw(raw)
    const next = structuredClone(raw) as NekoRaw
    const c = next.character

    if (changes.visibility !== undefined) {
      if (!VISIBILITIES.includes(changes.visibility)) throw new Error('BAD_VISIBILITY')
      // 편집기의 세 칸 선택: 비공개 / 링크 공개 / 공개
      c.isPublic = changes.visibility !== 'private'
      c.isLinkShareOnly = changes.visibility === 'link'
    }

    let fieldsChanged = false
    for (const [name, value] of Object.entries(changes.fields ?? {})) {
      const key = FIELDS[name]
      if (!key || typeof value !== 'string') throw new Error('BAD_FIELD')
      c[key] = value
      fieldsChanged = true
    }
    if (fieldsChanged) checkFields(c)

    let lores = list(c.lorebook)
    const loreBefore = JSON.stringify(lores)
    if (changes.lorebook) {
      const old = lores
      lores = changes.lorebook.map((e, i) => loreFrom(e, old[i], i))
    }
    for (const patch of changes.lorebookPatch ?? []) {
      const i = at(patch.index, lores.length)
      lores[i] = loreFrom(patch, lores[i], i)
    }
    if (changes.lorebookRemove?.length) {
      const gone = new Set(changes.lorebookRemove.map((i) => at(i, lores.length)))
      lores = lores.filter((_, i) => !gone.has(i))
    }
    for (const entry of changes.lorebookAdd ?? [])
      lores.push(loreFrom(entry, undefined, lores.length))
    if (JSON.stringify(lores) !== loreBefore) {
      // 순서 값은 자리대로 다시 매긴다
      c.lorebook = lores.map((e, order) => ({ ...e, order }))
      checkLorebook(c)
    }

    const form = nekoForm(c)
    let greeting = strings(form.greeting)
    let settings = list(form.greetingSettings)
    let auxiliary = list(c.auxiliaryPrompts)
    const startsBefore = JSON.stringify([greeting, settings])
    for (const patch of changes.startScenarios ?? []) {
      const i = at(patch.index, greeting.length)
      noStartExtras(patch)
      if (patch.content !== undefined) greeting[i] = patch.content
      if (patch.title !== undefined)
        settings[i] = { ...settings[i], title: patch.title.trim() || greetingTitle(i) }
    }
    if (changes.startScenariosRemove?.length) {
      const gone = [...new Set(changes.startScenariosRemove.map((i) => at(i, greeting.length)))]
      if (gone.includes(0)) throw new Error('KEEP_DEFAULT')
      // 뒤에서부터 지워야 번호가 어긋나지 않는다
      for (const i of gone.sort((a, b) => b - a)) {
        greeting = greeting.filter((_, n) => n !== i)
        settings = settings.filter((_, n) => n !== i)
        auxiliary = shiftAuxiliary(auxiliary, i)
      }
    }
    for (const draft of changes.startScenariosAdd ?? []) {
      noStartExtras(draft)
      greeting.push(draft.content ?? '')
      settings.push({
        title: draft.title?.trim() || greetingTitle(greeting.length - 1),
        includeLorebook: false,
        isEditable: true
      })
    }
    if (JSON.stringify([greeting, settings]) !== startsBefore) {
      c.greeting = greeting
      c.greetingSettings = greetingSettings(settings, greeting.length)
      c.auxiliaryPrompts = auxiliary
      checkStarts(c)
    }

    // 네코챗은 작품 하나에 캐릭터 하나다
    if (
      changes.characters?.length ||
      changes.charactersAdd?.length ||
      changes.charactersRemove?.length
    )
      throw new Error('NO_CHARACTERS')
    return next
  },

  async save(write, id, next) {
    const r = nekoRaw(next)
    await nekoPut(write, nekoWorkId(id), r.character)
  },

  visibilities: VISIBILITIES,

  async remove(write, id) {
    const res = await write(
      'DELETE',
      NEKO_CHARACTERS + '?characterId=' + encodeURIComponent(nekoWorkId(id))
    )
    if (res.status === 401 || res.status === 403) throw new Error('LOGIN_REQUIRED')
    if (res.status === 404) throw new Error('WORK_NOT_FOUND')
    if (!res.ok) throw new Error('DELETE_FAILED ' + res.status)
  },

  async create(write: WorkWrite, draft: WorkDraft): Promise<string> {
    const body = nekoCreateBody(draft)
    const res = await write('POST', NEKO_CHARACTERS, body)
    if (res.status === 401 || res.status === 403) throw new Error('LOGIN_REQUIRED')
    const reply: unknown = await res.json().catch(() => null)
    if (!res.ok)
      throw new Error(
        'CREATE_FAILED ' + res.status + ' ' + text(isObj(reply) ? reply.error : '').slice(0, 80)
      )
    const made = isObj(reply) && isObj(reply.character) ? text(reply.character.id) : ''
    if (CHAR_RE.test(made)) return made
    throw new Error('CREATED_ID_UNKNOWN')
  },

  checkDraft(draft) {
    nekoCreateBody({ ...draft, coverUrl: draft.coverUrl ?? PLACEHOLDER_COVER })
  },

  sendRule: nekoSendRule,
  imageRules: NEKO_IMAGE_RULES,
  imageGroups: nekoImageGroups,
  planImages: nekoPlanImages,
  applyImages: nekoApplyImages,
  /**
   * 새 작품 아바타 올리기. 편집기처럼 새 임시 번호(char_{시각}_{7자})로 올리고, 그 번호를 기억해 두었다가
   * create가 같은 번호로 만든다 (편집기: 만들기 본문의 characterId = 아바타를 올린 임시 번호).
   */
  async uploadImage(io, file) {
    const temp = 'char_' + Date.now() + '_' + base36(7)
    const url = await nekoUploadAvatar(io.send, temp, file)
    sweepTemp()
    tempIds.set(url, { id: temp, expires: Date.now() + 30 * 60_000 })
    return url
  },
  coverRules: NEKO_IMAGE_RULES,
  coverUrl: (raw) => strOrNull(avatarUrl(nekoRaw(raw).character)),
  uploadCover: nekoUploadCover
}

// ── 새 작품 ──

const PLACEHOLDER_COVER = 'https://placeholder.invalid/cover'
const tempIds = new Map<string, { id: string; expires: number }>()
function sweepTemp(): void {
  const now = Date.now()
  for (const [k, v] of tempIds) if (v.expires < now) tempIds.delete(k)
}
/** 아바타 주소 → 그 아바타를 올린 임시 번호 (기억한 값, 없으면 주소 안의 /characters/{번호}/) */
function tempIdOf(url: string): string | null {
  if (url === PLACEHOLDER_COVER) return 'char_0_placeholder'
  sweepTemp()
  const kept = tempIds.get(url)?.id
  if (kept) return kept
  const m = new RegExp('/characters/(' + CHAR + ')/', 'i').exec(url)
  return m ? m[1] : null
}

const AUDIENCES = ['all', 'male', 'female']
const NARRATION = ['character', 'narrator']
/**
 * 새 작품 본문 (항상 비공개). 편집기의 새 폼 기본값에 내용을 얹고, 편집기 입력 규칙을 먼저 확인한다.
 * options: character_audience(all/male/female, 필수), language(기본 ko), narration_mode(character/narrator)
 */
export function nekoCreateBody(draft: WorkDraft): Obj {
  const o = draft.options ?? {}
  const bad = (what: string): never => {
    throw new Error('BAD_DRAFT ' + what)
  }
  if (draft.characters.length) throw new Error('NO_CHARACTERS')
  const cover = draft.coverUrl ?? ''
  const characterId = cover ? tempIdOf(cover) : null
  if (!characterId) throw new Error('COVER_REQUIRED')
  if (!AUDIENCES.includes(o.character_audience as string))
    bad('options.character_audience all/male/female')
  const narration = o.narration_mode ?? 'narrator'
  if (!NARRATION.includes(narration as string)) bad('options.narration_mode character/narrator')
  const language = o.language ?? 'ko'
  if (typeof language !== 'string' || !language) bad('options.language')
  const tags = draft.hashtags ?? []
  const categories = draft.categories ?? []
  if (!tags.length && !categories.length) bad('hashtags 또는 categories 1개 이상')
  if (tags.length > LIMITS.tags || tags.some((t) => !t.trim() || t.length > LIMITS.tag))
    bad('hashtags 10개 이하, 각 20자 이하')
  const starts = draft.startScenarios ?? []
  for (const s of starts) noStartExtras(s)
  const greeting = starts.map((s) => s.content ?? '')

  const c: Obj = {
    // 편집기의 새 폼 기본값
    displayName: draft.title,
    description: draft.description ?? '',
    shortDescription: draft.subtitle ?? '',
    narrationMode: narration,
    systemPrompt: draft.main,
    persistentContext: '',
    auxiliaryPrompts: [],
    greeting,
    greetingSettings: greetingSettings(
      starts.map((s) => ({ title: s.title ?? '' })),
      greeting.length
    ),
    lorebook: (draft.lorebook ?? []).map((e, i) => loreFrom(e, undefined, i)),
    loreBudget: 100_000,
    lorebookImportCharacterIds: [],
    imageSlots: [],
    imageSlotFolders: [],
    categoryIds: categories,
    tags,
    characterAudience: o.character_audience,
    isIncentiveEnabled: true,
    isPublic: false,
    showCreatorHandle: true,
    isMarketingConsent: true,
    isLinkShareOnly: false,
    isNsfw: draft.adult,
    isShared: false,
    language,
    isDraftMode: false
  }
  checkFields(c)
  checkStarts(c)
  checkLorebook(c)
  return {
    ...c,
    characterId,
    avatar: { url: cover, alt: draft.title + ' 프로필 이미지' },
    uploadedImageUrls: [cover]
  }
}
