// 젠잇 저장 본문(multipart) 조립. 2026-11-10 젠잇 공개 스크립트(편집기 페이지
// /_next/static/chunks 9682-…·5718-…)에서 읽은 편집기의 저장 순서를 그대로 옮겼다.
//   읽기  GET   /api/characters/{id}/?lang=ko        편집기가 여는 작품 원본 (getCharacterDetail)
//   저장  PATCH /api/characters/{id}/                FormData (updateCharacter). 헤더 X-CSRFToken ← 쿠키 wavechat_csrftoken
//   만들기 POST /api/characters/                     FormData (편집기의 새 작품 저장)
//   삭제  DELETE /api/characters/{id}/               (deleteCharacter)
// 편집기는 저장할 때마다 기본 정보(이름·설명·공개 범위 …)와 image_source_urls(지금 남길 에셋 주소)를 보내고,
// 본문(시작 상황·로어북·캐릭터·프롬프트·상태 변수·템플릿)이 달라졌을 때만 본문 묶음을 통째로 같이 보낸다.
// 태그·장르·설명 이미지·대표 이미지 썸네일은 우리가 바꾸지 않으므로 보내지 않는다(PATCH에 없는 칸).
import type { FormField, LocalImage } from './types'

export const GENIT_API = 'https://api.genit.ai'
export const GENIT_SITE = 'https://genit.ai'
export const UUID_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
export const UUID_RE = new RegExp('^' + UUID_SOURCE + '$', 'i')

// 공개 범위: 편집기 선택지 1 공개 / 2 링크 공개 / 3 비공개. 4는 편집기가 publish_type을 보내지 않는 값(작업 사본)이다.
export const PUBLISH_TYPES: Record<number, string> = { 1: 'public', 2: 'link', 3: 'private' }
// 로어북 분류 (편집기 목록. 미설정이면 편집기가 저장을 막는다)
export const LORE_CATEGORIES = ['지역', '세력', '물건', '설정', '사건', '지침', '인물', '모드']
export const LORE_UNSET = '미설정'

export type Obj = Record<string, unknown>
export const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
export const list = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter(isObj) : [])
export const text = (v: unknown): string => (typeof v === 'string' ? v : '')
export const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []
const lf = (v: unknown): string => text(v).replace(/\r\n?/g, '\n')

/** 작품 원본(GET /api/characters/{id}/ 응답)인지 본다 */
export function character(raw: unknown): Obj {
  if (!isObj(raw) || typeof raw.id !== 'string' || !UUID_RE.test(raw.id))
    throw new Error('WORK_SHAPE')
  return raw
}
export const version = (c: Obj): Obj => (isObj(c.latest_version) ? c.latest_version : {})

/** 편집기의 iA: character_prompt가 모델별 JSON이면 기본 프롬프트만 꺼낸다 */
export function basePrompt(value: unknown): { base: string; byModel: boolean } {
  const t = lf(value)
  if (!t.trim()) return { base: '', byModel: false }
  try {
    const parsed: unknown = JSON.parse(t)
    if (isObj(parsed)) {
      const base = parsed.default ?? parsed.basic
      return { base: typeof base === 'string' ? lf(base) : '', byModel: true }
    }
  } catch {
    /* 평범한 글 */
  }
  return { base: t, byModel: false }
}

/** 원본에 있는 글 값 그대로. 비어 있으면 기본값을 지어내지 않고 멈춘다 */
const present = (v: unknown, what: string): string => {
  if (typeof v !== 'string' || !v.trim()) throw new Error('WORK_SHAPE ' + what)
  return v
}

const truthy = (v: unknown): boolean | undefined => {
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return v === 1 ? true : v === 0 ? false : undefined
  if (typeof v !== 'string') return undefined
  const t = v.trim().toLowerCase()
  return t === 'true' || t === '1' ? true : t === 'false' || t === '0' ? false : undefined
}

/** 편집기의 iM + iT: 모델별 프롬프트 목록을 저장 모양 [{tier_key, is_active, prompt}]으로 */
export function tierPrompts(
  v: unknown
): { tier_key: string; is_active: boolean; prompt: string }[] {
  const prompts = new Map<string, { prompt: string; active: boolean }>()
  const put = (key: unknown, value: unknown, active: unknown): void => {
    const k = String(key ?? '').trim()
    if (!k || k === 'default') return
    const prompt = lf(value == null ? '' : String(value))
    prompts.set(k, { prompt, active: truthy(active) ?? prompt.trim().length > 0 })
  }
  if (Array.isArray(v))
    for (const e of list(v))
      put(e.tier_key ?? e.tier ?? e.key, 'prompt' in e ? e.prompt : e.value, e.is_active)
  else if (isObj(v))
    for (const [k, e] of Object.entries(v))
      if (isObj(e)) put(k, 'prompt' in e ? e.prompt : e.value, e.is_active)
      else put(k, e, undefined)
  return [...prompts.keys()].sort().flatMap((k) => {
    const { prompt, active } = prompts.get(k)!
    return active || prompt.trim() ? [{ tier_key: k, is_active: active, prompt }] : []
  })
}

/**
 * 이미 저장 모양([{tier_key, is_active, prompt}])인 목록은 줄바꿈·순서·빈 항목을 손대지 않고 그대로 쓴다.
 * 다른 모양(옛 형식)이거나 목록이 아니면 null → tierPrompts가 저장 모양으로 바꾼다.
 */
function savedTierPrompts(
  v: unknown
): { tier_key: string; is_active: boolean; prompt: string }[] | null {
  if (!Array.isArray(v)) return null
  const rows: { tier_key: string; is_active: boolean; prompt: string }[] = []
  for (const e of v) {
    if (
      !isObj(e) ||
      typeof e.tier_key !== 'string' ||
      typeof e.is_active !== 'boolean' ||
      typeof e.prompt !== 'string'
    )
      return null
    rows.push({ tier_key: e.tier_key, is_active: e.is_active, prompt: e.prompt })
  }
  return rows
}

/** 편집기의 iC: 배열·JSON 글·한 값 → 글 배열 */
function stringList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((e) => String(e)).filter(Boolean)
  if (v == null || v === '') return []
  if (typeof v === 'string') {
    try {
      const parsed: unknown = JSON.parse(v)
      if (Array.isArray(parsed)) return parsed.map((e) => String(e)).filter(Boolean)
    } catch {
      /* 한 값 */
    }
    return [v]
  }
  return [String(v)]
}

// ───────────── 에셋(내부 이미지) ─────────────

export interface GenitAsset {
  /** 작품 원본에 적힌 그대로 (/media/characters/…/assets/폴더/이름.webp) */
  path: string
  /** 쿼리 없는 절대 주소 */
  url: string
  /** 편집기가 저장 때 image_source_urls에 넣는 값 (캐시 번호 v 포함, 파일 이름 부분은 풀어 쓴 글자) */
  source: string
  folder: string
  /** 풀어 쓴 파일 이름 (확장자 포함) */
  name: string
}

const decode = (s: string): string => {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}
const noQuery = (s: string): string => s.split('?')[0]
/** 편집기의 ih: 주소에 캐시 번호 v를 붙인다 */
function withVersion(url: string, cache: unknown): string {
  if (cache == null) return url
  const [head, query = ''] = url.split('?')
  const params = new URLSearchParams(query)
  params.set('v', String(cache))
  const q = params.toString()
  return q ? head + '?' + q : head + '?v=' + String(cache)
}
/** 편집기의 d2: 마지막 경로 조각만 풀어 쓴다 */
function decodedLast(url: string): string {
  const [head, query] = url.split('?')
  const parts = head.split('/')
  const out = parts.map((p, i) => (i === parts.length - 1 ? decode(p) : p)).join('/')
  return query !== undefined && query !== '' ? out + '?' + query : out
}

/** 지금 버전의 에셋 목록. 편집기처럼 이름 순(한국어·숫자 순)으로 늘어놓는다 */
export function genitAssets(c: Obj): GenitAsset[] {
  const images = strings(version(c).images)
  const out = images.map((path, i): GenitAsset & { sortKey: string } => {
    const full = path.startsWith('http') ? path : GENIT_API + path
    const fileName = noQuery(path.split('/').pop() || 'image_' + (i + 1))
    const name = fileName.includes('%') ? decode(fileName) : fileName
    const match = /\/assets\/(.+)$/.exec(path)
    let folder = ''
    if (match) {
      const segs = noQuery(match[1]).split('/')
      if (segs.length > 1) folder = segs.slice(0, -1).map(decode).join('/')
    }
    return {
      path,
      url: noQuery(full),
      source: decodedLast(withVersion(full, c.asset_cache_version)),
      folder,
      name,
      sortKey: name.split('.')[0] || '이미지 ' + (i + 1)
    }
  })
  out.sort((a, b) =>
    a.sortKey.localeCompare(b.sortKey, 'ko', { numeric: true, sensitivity: 'base' })
  )
  return out.map((a) => ({
    path: a.path,
    url: a.url,
    source: a.source,
    folder: a.folder,
    name: a.name
  }))
}

/** 대표(프로필) 이미지 목록 */
export function genitProfiles(c: Obj): { id: string | null; url: string; fileName: string }[] {
  return list(c.profile_images).map((p, i) => {
    const url = text(p.url)
    return {
      id: p.id != null && String(p.id).trim() ? String(p.id).trim() : null,
      url: url.startsWith('http') ? url : GENIT_API + url,
      // 편집기는 기존 이미지를 filename(없으면 profile_N) 이름의 파일로 다시 만든다
      fileName: noQuery(text(p.filename) || 'profile_' + (i + 1))
    }
  })
}

// ───────────── 본문 묶음 ─────────────

function greetingsJson(c: Obj): string {
  return JSON.stringify(
    // 편집기는 제목·본문이 빈 시작 상황을 빼고 보내지만, 손대지 않은 옛 항목을 몰래 지우지 않도록 여기서는 거르지 않는다.
    // 바꾸는 칸이나 더하는 항목이 비었는지는 applyChanges가 막는다(안 바꾼 칸은 검사하지 않는다).
    list(version(c).greetings)
      .map((g, i) => {
        const title = text(g.title)
        const content = text(g.content)
        const background = text(g.background)
        const volatility = text(g.volatility_background)
        const questions = strings(g.sample_questions)
        const description = text(g.description)
        // updateCharacter의 시작 상황 모양 (언어별 칸은 편집기와 같게 같은 글로 채운다)
        return {
          title,
          content,
          is_active: g.is_active,
          display_order: i,
          title_ko: title,
          content_ko: content,
          title_en: title,
          content_en: content,
          background,
          background_ko: background,
          background_en: '',
          volatility_background: volatility,
          volatility_background_ko: volatility,
          volatility_background_en: '',
          sample_questions: questions,
          sample_questions_ko: questions,
          sample_questions_en: questions,
          description,
          description_ko: description,
          description_en: description,
          cover_image: text(g.cover_image)
        }
      })
  )
}

/**
 * 로어북 저장 모양. 비면 null (편집기는 빈 로어북을 보내지 않는다).
 * (2026-11-13) 원본에 칸이 없는 옛 항목은 지금까지 실제 저장에 쓰인 기본값으로 채운다: 칸을 빼고 보내는 것은 확인된 적이 없다.
 * 원본에 있는 칸은 값 그대로 보내고(고정 true·'미설정' 같은 기본값으로 바꾸지 않는다), 없는 칸은 싣지 않는다.
 * 새 항목은 loreFresh가 칸을 모두 채워 둔다.
 */
function lorebooksJson(c: Obj): string | null {
  const rows = list(c.lorebooks)
  if (!rows.length) return null
  return JSON.stringify(
    rows.map((l) => ({
      title: l.title,
      description: l.description,
      display_description: l.display_description ?? '',
      keywords: Array.isArray(l.keywords) ? l.keywords : [],
      is_active: l.is_active,
      is_hidden: l.is_hidden ?? true,
      is_pinned: l.is_pinned ?? true,
      category: l.category ?? LORE_UNSET,
      recall_cue: l.recall_cue ?? '',
      status: l.status ?? ''
    }))
  )
}

// 글 칸은 원본 그대로 보낸다(앞뒤 공백 정리·500자 자르기·이름 빈 캐릭터 빼기를 하지 않는다).
// 이름을 바꾸거나 캐릭터를 더할 때 이름이 비었는지는 applyChanges가 막는다(이름이 빈 옛 캐릭터는 이름을 안 바꾸는 한 그대로 간다).
function castJson(c: Obj): string {
  return JSON.stringify(
    list(version(c).cast_members).map((m, i) => {
      const url = text(m.profile_url).trim()
      const file = text(m.profile_filename).trim()
      const draft = text(m.draft_asset_id).trim()
      return {
        id: m.id,
        name: text(m.name),
        codename: text(m.codename),
        history: text(m.history) || text(m.description),
        introduction: text(m.introduction),
        initial_journal: text(m.initial_journal),
        background: text(m.background),
        aliases: Array.isArray(m.aliases) ? m.aliases : [],
        keywords: Array.isArray(m.keywords) ? m.keywords : [],
        // 편집기: 초안 에셋 > 주소 > 파일 이름 순으로 하나만 남긴다
        profile_filename: draft || url ? undefined : file || undefined,
        profile_url: draft ? undefined : url || undefined,
        draft_asset_id: draft || undefined,
        is_active: m.is_active,
        display_order: i
      }
    })
  )
}

// 편집기가 늘 앞에 두는 기본 상태 변수 (iJ: 시간 T, 위치 L)
const PROTECTED_INFO: Obj[] = [
  { name: '시간', name_ko: '시간', name_en: 'Time', codename: 'T' },
  { name: '위치', name_ko: '위치', name_en: 'Location', codename: 'L' }
].map((e) => ({
  ...e,
  description: '',
  description_en: '',
  description_ko: '',
  is_character_variable: false,
  initial_value: '',
  initial_value_map: null
}))

/**
 * 편집기의 상태 변수 정리(불러올 때 기본 변수 T·L을 앞에 맞춰 넣고, 저장 때 dw로 다듬는 것)와 같은 모양.
 * 이름·코드가 빈 항목은 편집기의 정리 결과(sanitized)에도 들어가지 않는다.
 */
function infoValuesJson(c: Obj): string {
  const given = list(version(c).info_values)
  const rest = [...given]
  const ordered: Obj[] = PROTECTED_INFO.map((base) => {
    const at = rest.findIndex(
      (e) => String(e.codename ?? '').toUpperCase() === String(base.codename).toUpperCase()
    )
    if (at < 0) return { ...base }
    const found = rest.splice(at, 1)[0]
    // 편집기: 이름이 비었으면 기본 이름을 쓴다 (name: a.name || e.name)
    return { ...base, ...found, name: text(found.name) || base.name }
  })
  const rows = [...ordered, ...rest].flatMap((e) => {
    const name = String(e.name ?? e.name_ko ?? e.name_en ?? '').trim()
    const codename = String(e.codename ?? '').trim()
    if (!name || !codename) return []
    const description = String(e.description ?? e.description_ko ?? e.description_en ?? '').trim()
    const variable = !!e.is_character_variable
    const initial = typeof e.initial_value === 'string' ? e.initial_value.trim().slice(0, 80) : ''
    let map: Record<string, string> | null = null
    if (variable) {
      map = {}
      if (isObj(e.initial_value_map))
        for (const [k, v] of Object.entries(e.initial_value_map)) {
          const key = k.trim().toUpperCase()
          if (key && v != null) map[key] = String(v).trim().slice(0, 80)
        }
    }
    return [
      {
        ...(e.name_en ? { name_en: String(e.name_en) } : {}),
        ...(e.description_en ? { description_en: String(e.description_en) } : {}),
        name,
        codename,
        description: description || null,
        is_character_variable: variable,
        initial_value: variable ? '' : initial,
        initial_value_map: map,
        name_ko: name,
        description_ko: description || null
      }
    ]
  })
  return JSON.stringify(rows)
}

function templateValuesJson(v: Obj): string {
  return JSON.stringify(
    list(v.template_values_data ?? v.template_values)
      .map((e) => ({
        key: String(e.key ?? '').trim(),
        default: e.default == null ? '' : String(e.default),
        ...(e.label ? { label: String(e.label) } : {}),
        ...(e.description ? { description: String(e.description) } : {})
      }))
      .filter((e) => e.key !== '' || e.default !== '')
  )
}

export interface AssetUpload {
  file: LocalImage
  folder: string
  name: string
}
export interface GenitFormParts {
  /** 본문 묶음까지 보낸다 (본문·에셋이 달라졌을 때) */
  content: boolean
  /** 남길 에셋 (기본: 지금 있는 것 전부) */
  keepAssets?: GenitAsset[]
  /** 새로 올릴 에셋 */
  newAssets?: AssetUpload[]
  /** 대표 이미지 목록을 바꿀 때: 남길 기존 이미지 + 끝에 더할 새 파일 */
  profiles?: { keep: { id: string; fileName: string }[]; add: LocalImage[] }
}

/** 저장 본문(PATCH /api/characters/{id}/)의 칸들. 편집기 updateCharacter와 같은 이름·모양이다 */
export function genitForm(raw: unknown, parts: GenitFormParts): FormField[] {
  const c = character(raw)
  const v = version(c)
  const out: FormField[] = []
  const add = (name: string, value: string): void => {
    out.push({ name, value })
  }
  const name = text(c.name)
  // 손대지 않은 글의 줄바꿈(CRLF)을 바꾸지 않는다. 읽을 때만 LF로 본다(basePrompt)
  const description = text(c.description)
  add('name', name)
  add('name_ko', name)
  add('description', description)
  add('description_ko', description)
  add('short_intro', text(c.short_intro))
  // 원본 값 그대로 (모르면 false). 켜 둔 작품이 다른 저장에 딸려 꺼지지 않게 한다
  const submodel = String(truthy(v.use_submodel) ?? false)

  if (parts.content) {
    const prompt = basePrompt(c.character_prompt)
    // 모델별 JSON 프롬프트는 편집기가 저장 때 모양을 바꾸는 옛 형식이라 건드리지 않는다
    if (prompt.byModel) throw new Error('PROMPT_SHAPE')
    // 시작 상황·캐릭터 목록을 원본에서 못 읽었으면(칸이 없음) 빈 목록을 보내 지우지 않고 멈춘다. null은 "없음"으로 읽는다
    for (const key of ['greetings', 'cast_members'])
      if (!(Array.isArray(v[key]) || v[key] === null)) throw new Error('WORK_SHAPE ' + key)
    const tiers = savedTierPrompts(v.tier_prompts) ?? tierPrompts(v.tier_prompts)
    const useTiers = truthy(v.use_tier_prompts) ?? tiers.length > 0
    // 평범한 글이면 원본 그대로 (basePrompt는 읽기용으로 줄바꿈을 LF로 바꾼다)
    add('character_prompt', text(c.character_prompt))
    add('tier_prompts', JSON.stringify(tiers))
    add('use_tier_prompts', String(useTiers))
    add('use_submodel', submodel)
    add('usage_guide', text(v.usage_guide))
    add('html_templates', JSON.stringify(Array.isArray(v.html_templates) ? v.html_templates : []))
    add('template_values', templateValuesJson(v))
  } else add('use_submodel', submodel)

  // 원본에 없는 값을 기본값으로 지어 보내지 않는다 (유형·성별·성인 여부·공개 범위가 몰래 바뀐다)
  add('type', present(c.type, 'type'))
  add('prompt_type', present(c.prompt_type, 'prompt_type'))
  const tiersDefault = stringList(c.default_model_tiers ?? v.default_model_tiers)
    .map((t) => t.trim())
    .filter(Boolean)
  if (tiersDefault.length) for (const t of tiersDefault) add('default_model_tiers', t)
  else add('default_model_tiers', '[]')
  add('gender', present(c.gender, 'gender'))
  const publish = Number(c.publish_type)
  // 공개 범위를 모르면 공개(1)로 보내지 않고 멈춘다
  if (!(publish in PUBLISH_TYPES) && publish !== 4) throw new Error('WORK_SHAPE publish_type')
  // 4(작업 사본)는 편집기도 보내지 않는다
  if (publish !== 4) add('publish_type', String(publish))
  const adult = truthy(c.is_adult)
  const active = truthy(c.is_active)
  if (adult === undefined) throw new Error('WORK_SHAPE is_adult')
  if (active === undefined) throw new Error('WORK_SHAPE is_active')
  add('is_adult', String(adult))
  add('is_active', String(active))

  if (parts.content) add('greetings', greetingsJson(c))
  for (const file of parts.profiles?.add ?? []) out.push({ name: 'profile_image_files', file })
  for (const upload of parts.newAssets ?? [])
    out.push({ name: 'media_files', file: { ...upload.file, name: upload.name } })
  if (parts.content) {
    const lore = lorebooksJson(c)
    if (lore) add('lorebooks', lore)
    add('cast_members', castJson(c))
    add('info_values', infoValuesJson(c))
  }
  if (parts.profiles) {
    const { keep, add: fresh } = parts.profiles
    add(
      'profile_images_meta',
      JSON.stringify([
        ...keep.map((p, order) => ({
          file_name: p.fileName,
          order,
          existing_media_id: p.id
        })),
        ...fresh.map((file, i) => ({ file_name: file.name, order: keep.length + i }))
      ])
    )
  }
  const keepAssets = parts.keepAssets ?? genitAssets(c)
  add('image_source_urls', JSON.stringify(keepAssets.map((a) => a.source)))
  if (parts.newAssets?.length)
    add(
      'media_files_meta',
      JSON.stringify(parts.newAssets.map((u) => ({ folder: u.folder, filename: u.name })))
    )
  if (keepAssets.length)
    add('image_source_meta', JSON.stringify(keepAssets.map((a) => ({ folder: a.folder }))))
  return out
}

/** 새 작품 본문 (POST /api/characters/). 편집기의 새 작품 저장(hS)과 같은 이름이고, 항상 비공개(3)다 */
export function genitCreateForm(fields: {
  name: string
  description: string
  shortIntro: string
  prompt: string
  greetings: Obj[]
  lorebooks: Obj[]
  cast: Obj[]
  type: string
  gender: string
  adult: boolean
}): FormField[] {
  const out: FormField[] = []
  const add = (name: string, value: string): void => {
    out.push({ name, value })
  }
  add('name', fields.name)
  add('name_ko', fields.name)
  if (fields.description) {
    add('description', fields.description)
    add('description_ko', fields.description)
  }
  add('short_intro', fields.shortIntro)
  if (fields.greetings.length) add('greetings', JSON.stringify(fields.greetings))
  if (fields.lorebooks.length) add('lorebooks', JSON.stringify(fields.lorebooks))
  if (fields.cast.length) add('cast_members', JSON.stringify(fields.cast))
  add('character_prompt', fields.prompt)
  add('tier_prompts', '[]')
  add('use_tier_prompts', 'false')
  add('use_submodel', 'false')
  add('type', fields.type)
  add('prompt_type', 'custom')
  add('default_model_tiers', '[]')
  add('gender', fields.gender)
  add('publish_type', '3')
  add('is_adult', String(fields.adult))
  add('is_active', 'true')
  return out
}
