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
  NEKO_UNSUPPORTED,
  nekoExtras,
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
import { matchOld } from './match-old'
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
  startTitle: 100,
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

/** 바뀐 글 칸(names: 공통 칸 이름)만 편집기 입력 규칙으로 본다. 손대지 않은 칸은 옛 값 그대로 둔다 */
function checkFields(c: Obj, names: string[]): void {
  for (const name of names) {
    const key = FIELDS[name]
    const value = text(c[key])
    const max = LIMITS[key as keyof typeof LIMITS]
    if ((REQUIRED.has(key) && !value.trim()) || value.length > max)
      throw new Error('BAD_FIELD ' + name + (REQUIRED.has(key) ? ' 1~' : ' ~') + max + '자')
  }
}
/** 첫상황 제목은 저장 때 100자로 잘려 들어가므로(greetingSettings) 받은 제목을 먼저 본다 */
function checkStartTitle(title: string | undefined, i: number): void {
  if (title !== undefined && title.trim().length > LIMITS.startTitle)
    throw new Error('BAD_START start_scenarios[' + i + '].title ' + LIMITS.startTitle + '자')
}
/** touched[i] = i번째 첫상황이 바뀌었거나 새로 더한 것. 그것만 글 길이를 본다. before = 고치기 전 첫상황 수 */
function checkStarts(c: Obj, touched: boolean[], before: number): void {
  const greeting = strings(c.greeting)
  if (greeting.length < 1 || (greeting.length > LIMITS.greetings && greeting.length > before))
    throw new Error('START_LIMIT')
  for (const [i, g] of greeting.entries())
    if (touched[i] && (!g || g.length > LIMITS.greeting))
      throw new Error('BAD_START start_scenarios[' + i + '].content 1~' + LIMITS.greeting + '자')
}
/** isChanged(e) = 바뀌었거나 새로 더한 항목. 그것만 항목 규칙을 본다. before = 고치기 전 항목 수 */
function checkLorebook(lores: Obj[], isChanged: (e: Obj) => boolean, before: number): void {
  if (lores.length > LIMITS.loreEntries && lores.length > before) throw new Error('LOREBOOK_LIMIT')
  for (const [i, e] of lores.entries()) {
    if (!isChanged(e)) continue
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

const sameList = (a: string[], b: string[]): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i])
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
  // 읽을 때 이은 글을 그대로 돌려받았으면 옛 키 배열을 둔다 (다시 쪼개면 쉼표가 든 키·앞뒤 공백이 깨진다)
  if (entry.keys !== undefined && !(base && strings(base.keys).join(', ') === entry.keys))
    out.keys = keyList(entry.keys)
  // 전체 교체에서 제외키를 적어 주지 않았으면(given에 없음) 짝지은 옛 항목의 제외키를 그대로 둔다
  const keepOffKeys = !!base && !!entry.given && !entry.given.includes('offKeys')
  if (
    entry.offKeys !== undefined &&
    !keepOffKeys &&
    !(base && sameList(strings(base.negativeKeys), entry.offKeys))
  )
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
  // 서버가 제목으로 다시 쓰는 대체 글, 새 로어북 항목에 붙이는 번호 (2026-11-13 실제 저장에서 확인)
  rawIgnore: [/^character\.avatar\.alt$/, /^character\.lorebook\[[^\]]*\]\._id$/],
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
  features: {
    title: { site: 'yes', read: 'yes', write: 'yes', verified: 'yes', note: '80자' },
    description: {
      site: 'yes',
      read: 'yes',
      write: 'yes',
      verified: 'yes',
      note: '캐릭터설명 20만자·짧은설명 1천자'
    },
    main_prompt: {
      site: 'yes',
      read: 'yes',
      write: 'yes',
      verified: 'yes',
      note: '페르소나 30만자'
    },
    first_message: {
      site: 'yes',
      read: 'yes',
      write: 'yes',
      verified: 'yes',
      note: '첫상황 0번, 2만자'
    },
    start_scenarios: {
      site: 'yes',
      read: 'partial',
      write: 'partial',
      verified: 'yes',
      note: '제목·본문만, 최대 10개'
    },
    lorebook: {
      site: 'yes',
      read: 'partial',
      write: 'partial',
      verified: 'yes',
      note: '켬끔·예산은 사이트에서 직접'
    },
    characters: {
      site: 'no',
      read: 'no',
      write: 'no',
      verified: 'yes',
      note: '캐릭터 개념 없음'
    },
    example_dialogue: {
      site: 'no',
      read: 'no',
      write: 'no',
      verified: 'no',
      note: '전용 칸 없음'
    },
    user_persona: {
      site: 'unknown',
      read: 'no',
      write: 'no',
      verified: 'no',
      note: '개수만 extras에, 용도 모름'
    },
    output_rules: {
      site: 'no',
      read: 'no',
      write: 'no',
      verified: 'no',
      note: '상시 컨텍스트로 대용'
    },
    situation_images: {
      site: 'yes',
      read: 'partial',
      write: 'partial',
      verified: 'partial',
      note: '슬롯 추가·삭제·순서만, 300장'
    },
    cover: {
      site: 'yes',
      read: 'yes',
      write: 'yes',
      verified: 'yes',
      note: '아바타(대표 이미지), webp·png·jpg 4.5MB'
    },
    tags: {
      site: 'yes',
      read: 'yes',
      write: 'partial',
      verified: 'no',
      note: '읽기만, 입력은 새 작품 때만'
    },
    visibility: {
      site: 'yes',
      read: 'yes',
      write: 'yes',
      verified: 'partial',
      note: 'public 전환 미확인'
    },
    create_work: {
      site: 'yes',
      read: 'no',
      write: 'yes',
      verified: 'yes',
      note: '비공개로만 생성'
    },
    delete_work: {
      site: 'yes',
      read: 'no',
      write: 'yes',
      verified: 'yes',
      note: '제목 확인 필요'
    },
    versioning_review: {
      site: 'yes',
      read: 'partial',
      write: 'no',
      verified: 'no',
      note: 'version만 읽음, 시트 검수는 안 보임'
    },
    language_editions: {
      site: 'no',
      read: 'no',
      write: 'no',
      verified: 'yes',
      note: '판본 없음'
    },
    bgm_voice: {
      site: 'unknown',
      read: 'no',
      write: 'no',
      verified: 'no',
      note: '원본 칸에 없음, 사이트는 미확인'
    },
    jsx_html: {
      site: 'yes',
      read: 'no',
      write: 'no',
      verified: 'no',
      note: '별도 요청, 사이트에서 직접'
    },
    model_settings: {
      site: 'unknown',
      read: 'no',
      write: 'no',
      verified: 'no',
      note: '원본 칸에 없음, 사이트는 미확인'
    },
    comments_stats: {
      site: 'yes',
      read: 'no',
      write: 'no',
      verified: 'no',
      note: '알림 쪽에만, 사이트에서 직접'
    }
  },

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
      characters: [],
      extras: nekoExtras(c),
      unsupported: [...NEKO_UNSUPPORTED]
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

    const changedFields: string[] = []
    for (const [name, value] of Object.entries(changes.fields ?? {})) {
      const key = FIELDS[name]
      if (!key || typeof value !== 'string') throw new Error('BAD_FIELD')
      c[key] = value
      changedFields.push(name)
    }
    checkFields(c, changedFields)

    let lores = list(c.lorebook)
    const loreCount = lores.length
    const loreBefore = JSON.stringify(lores)
    const loreOld = new Set(lores.map((e) => JSON.stringify(e)))
    if (changes.lorebook) {
      // 제목으로 옛 항목과 짝짓는다. 짝이 없는 새 항목은 새 항목으로 만든다 (옛 항목의 번호·켜짐 상태를 물려받지 않는다)
      const old = lores
      const paired = matchOld(
        changes.lorebook.map((e) => e.title ?? ''),
        old,
        (o) => text(o.name),
        // 내용까지 견준다: 그 자리 항목을 지우고 새로 넣은 것이 지운 항목의 번호·꺼짐·내보내기 상태를 물려받지 않게
        { contents: changes.lorebook.map((e) => e.content), contentOf: (o) => text(o.content) }
      )
      lores = changes.lorebook.map((e, i) => loreFrom(e, paired[i], i))
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
      // 바뀌었거나 새로 더한 항목만 규칙을 본다 (손대지 않은 옛 항목은 사이트가 받아 주던 값 그대로 보낸다)
      checkLorebook(lores, (e) => !loreOld.has(JSON.stringify(e)), loreCount)
      // 순서 값은 자리대로 다시 매긴다
      c.lorebook = lores.map((e, order) => ({ ...e, order }))
    }

    const form = nekoForm(c)
    let greeting = strings(form.greeting)
    let settings = list(form.greetingSettings)
    let auxiliary = list(c.auxiliaryPrompts)
    const startCount = greeting.length
    let touched = greeting.map(() => false)
    const startsBefore = JSON.stringify([greeting, settings])
    for (const patch of changes.startScenarios ?? []) {
      const i = at(patch.index, greeting.length)
      noStartExtras(patch)
      checkStartTitle(patch.title, i)
      if (patch.content !== undefined) {
        greeting[i] = patch.content
        touched[i] = true
      }
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
        touched = touched.filter((_, n) => n !== i)
        auxiliary = shiftAuxiliary(auxiliary, i)
      }
    }
    for (const draft of changes.startScenariosAdd ?? []) {
      noStartExtras(draft)
      checkStartTitle(draft.title, greeting.length)
      greeting.push(draft.content ?? '')
      touched.push(true)
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
      checkStarts(c, touched, startCount)
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
  for (const [i, s] of starts.entries()) {
    noStartExtras(s)
    checkStartTitle(s.title, i)
  }
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
  checkFields(c, Object.keys(FIELDS))
  checkStarts(c, greeting.map(() => true), 0)
  checkLorebook(list(c.lorebook), () => true, 0)
  return {
    ...c,
    characterId,
    avatar: { url: cover, alt: draft.title + ' 프로필 이미지' },
    uploadedImageUrls: [cover]
  }
}
