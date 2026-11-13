// 이미지·표지 도구. 저장 도구와 같은 순서를 지킨다: "계획(…_plan) → 사용자 확인 → 적용(…_apply)".
//  - 계획 단계는 로컬 파일만 확인하고(확장자·크기·실제 이미지인지) 플랫폼에는 아무것도 쓰지 않는다.
//  - 적용 단계는 계획 뒤 플랫폼 내용이 바뀌었으면 멈추고, 직전 원본을 스냅샷으로 남긴 뒤 다시 읽어 견준다.
// 로컬 파일은 이미지 확장자와 크기 한도 안에서만 읽는다 (글 파일의 readText와 같은 제한).
import { randomBytes } from 'node:crypto'
import { platformNote, workAdapter, workKey } from './adapters'
import type { ToolDef, WorkToolDeps } from './tools'
import type {
  FileRules,
  ImageAdd,
  ImageChanges,
  ImageGroup,
  LocalImage,
  WorkAdapter,
  WorkImage,
  WorkIo
} from './types'
import { isObj, str } from './shared'

const PLAN_TTL = 30 * 60_000

type Obj = Record<string, unknown>

const MIME: Record<string, string> = {
  webp: 'image/webp',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif'
}
const ascii = (data: Uint8Array, from: number, to: number): string =>
  String.fromCharCode(...data.subarray(from, to))
/** 파일 앞머리로 본 실제 종류. 확장자만 바꾼 다른 파일을 올리지 않게 한다 */
function sniff(data: Uint8Array): string | null {
  if (ascii(data, 0, 4) === 'RIFF' && ascii(data, 8, 12) === 'WEBP') return 'image/webp'
  if (data[0] === 0x89 && ascii(data, 1, 4) === 'PNG') return 'image/png'
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
  if (ascii(data, 0, 4) === 'GIF8') return 'image/gif'
  return null
}

const fileName = (path: string): string => path.split(/[\\/]/).pop() ?? ''
const extension = (name: string): string =>
  (/\.([A-Za-z0-9]+)$/.exec(name)?.[1] ?? '').toLowerCase()

/** 로컬 이미지 하나를 읽는다. 허용 확장자·크기 한도·실제 종류가 맞지 않으면 BAD_IMAGE */
export async function loadImage(
  path: unknown,
  deps: WorkToolDeps,
  rules: FileRules
): Promise<LocalImage> {
  const name = fileName(str(path))
  const type = MIME[extension(name)]
  if (!name || !type || !rules.extensions.includes(extension(name))) throw new Error('BAD_IMAGE')
  let data: Uint8Array
  try {
    data = await deps.readBinary(str(path), rules.maxBytes)
  } catch {
    throw new Error('BAD_IMAGE')
  }
  if (!data.byteLength || data.byteLength > rules.maxBytes || sniff(data) !== type)
    throw new Error('BAD_IMAGE')
  return { name, type, data }
}

const io = (deps: WorkToolDeps, platform: string): WorkIo => ({
  read: deps.reader(platform),
  write: deps.writer(platform),
  send: deps.sender(platform)
})

// ───────────── 표지 파일 ↔ 언어 짝짓기 ─────────────

// 원문 표지로 보는 파일 이름 (확장자 빼고). 아빠 작품 폴더의 eden.webp 관례를 포함한다.
const SOURCE_NAMES = ['cover', 'eden', '표지', 'source', '원본']
const LANGUAGE_ALIASES: Record<string, string> = { kr: 'ko', jp: 'ja', tw: 'zh-tw', cn: 'zh-cn' }

/**
 * 파일 이름이 가리키는 표지 자리: 'source'(원문) 또는 언어 코드, 모르면 null.
 * 규칙: 이름이 언어 코드로 끝나면(구분 글자 공백 _ - . 뒤) 그 판본, 예: cover_en.webp, 표지-ja.webp,
 * zh-TW.webp. 이름이 cover / eden / 표지 / source / 원본이거나 원문 언어 코드면 원문 표지.
 */
export function coverTarget(
  name: string,
  languages: string[],
  sourceLanguage: string | null
): string | null {
  const base = name
    .replace(/\.[^.]+$/, '')
    .normalize('NFC')
    .toLowerCase()
  const ends = (code: string): boolean =>
    base === code || (base.endsWith(code) && /[ _.-]/.test(base[base.length - code.length - 1]))
  const found =
    // 긴 코드부터 본다 (zh-tw를 tw보다 먼저)
    [...languages].sort((a, b) => b.length - a.length).find((l) => ends(l.toLowerCase())) ??
    languages.find((l) =>
      Object.entries(LANGUAGE_ALIASES).some(
        ([alias, code]) => code === l.toLowerCase() && ends(alias)
      )
    )
  if (found) return found === sourceLanguage ? 'source' : found
  return SOURCE_NAMES.includes(base) ? 'source' : null
}

// ───────────── 도구 ─────────────

interface ImagePlan {
  site: string
  workId: string
  args: Obj
  /** 계획 때의 이미지 목록. 적용할 때 그대로인지 견준다 */
  base: string
  sizes: number[]
  expires: number
}
interface CoverPlan {
  site: string
  workId: string
  targets: { target: string; path: string; size: number }[]
  expires: number
}

const site = { type: 'string', description: '플랫폼 이름 (sites_list의 site)' }
const workId = { type: 'string', description: '작품 번호 (works_list의 id)' }
const text = { type: 'string' }

// ───────────── 이미지 목록 나눠 주기 ─────────────
// 에셋이 수천 장인 작품은 목록 전체가 수십만 자라 부르는 AI 쪽에서 받지 못한다.
// index는 언제나 묶음 전체 기준 번호다(잘라 줘도 바뀌지 않는다. images_plan의 remove·order가 이 번호를 쓴다).

const IMAGE_PAGE_DEFAULT = 50
const IMAGE_PAGE_MAX = 500
/** 계획·적용 결과에서 묶음이 이 수 이하면 전부 싣는다 (예전과 같은 모양) */
const IMAGE_SHOW_ALL = 50
/** 그보다 큰 묶음은 앞쪽 이만큼 + 대표 + 이번에 건드린 이미지 주변만 싣는다 */
const IMAGE_HEAD = 10
const IMAGE_SHOWN_MAX = 200

const shownImage = (image: WorkImage, index: number): Obj => ({
  index,
  label: image.label,
  is_default: image.isDefault,
  visibility: image.visibility,
  description: image.description,
  url: image.url
})

function whole(v: unknown, fallback: number, min: number, max: number, what: string): number {
  if (v === undefined || v === null) return fallback
  const n = Number(v)
  if (!Number.isInteger(n) || n < min || n > max) throw new Error('BAD_RANGE ' + what)
  return n
}

/** images_list: 묶음마다 offset부터 limit장. group을 주면 그 묶음만 */
export function pagedGroups(groups: ImageGroup[], args: Obj): Obj {
  const group =
    args.group === undefined || args.group === null
      ? null
      : whole(args.group, 0, 0, Math.max(0, groups.length - 1), 'group')
  if (group !== null && !groups.length) throw new Error('BAD_RANGE group')
  const offset = whole(args.offset, 0, 0, Number.MAX_SAFE_INTEGER, 'offset')
  const limit = whole(args.limit, IMAGE_PAGE_DEFAULT, 1, IMAGE_PAGE_MAX, 'limit')
  let partial = false
  const out = groups.flatMap((g, gi) => {
    if (group !== null && gi !== group) return []
    const count = g.images.length
    const images = g.images.slice(offset, offset + limit)
    const end = Math.min(count, offset + images.length)
    if (offset > 0 || end < count) partial = true
    return [
      {
        group: gi,
        character_index: g.character,
        name: g.name,
        count,
        offset,
        returned: images.length,
        next_offset: end < count ? end : null,
        images: images.map((image, i) => shownImage(image, offset + i))
      }
    ]
  })
  return {
    groups: out,
    ...(partial
      ? {
          note: '묶음마다 일부만 줬어요(count가 전체 수). 이어 보려면 group과 offset(next_offset)을 주세요. index는 전체 기준 번호예요.'
        }
      : {})
  }
}

/**
 * images_plan·images_apply 결과용 목록. 작은 묶음은 전부, 큰 묶음은 앞쪽 일부·대표 이미지·이번에 건드린
 * 이미지 주변만 싣고 partial: true를 붙인다 (검증은 이 목록이 아니라 전체로 한다).
 */
export function trimmedGroups(groups: ImageGroup[], focus: number, touched: number[]): unknown[] {
  return groups.map((g, gi) => {
    const count = g.images.length
    const head = { group: gi, character_index: g.character, name: g.name, count }
    if (count <= IMAGE_SHOW_ALL) return { ...head, images: g.images.map(shownImage) }
    const keep = new Set<number>()
    for (let i = 0; i < IMAGE_HEAD; i++) keep.add(i)
    g.images.forEach((image, i) => {
      if (image.isDefault) keep.add(i)
    })
    if (gi === focus)
      for (const t of touched)
        for (const i of [t - 1, t, t + 1]) if (i >= 0 && i < count) keep.add(i)
    const shown = [...keep].sort((a, b) => a - b).slice(0, IMAGE_SHOWN_MAX)
    return { ...head, partial: true, images: shown.map((i) => shownImage(g.images[i], i)) }
  })
}

export function createMediaTools(deps: WorkToolDeps, forget: (key: string) => void): ToolDef[] {
  const imagePlans = new Map<string, ImagePlan>()
  const coverPlans = new Map<string, CoverPlan>()
  const sweep = (plans: Map<string, { expires: number }>): void => {
    const now = Date.now()
    for (const [key, plan] of plans) if (plan.expires < now) plans.delete(key)
  }
  const taken = <T extends { expires: number }>(plans: Map<string, T>, id: string): T => {
    const plan = plans.get(id)
    if (!plan || plan.expires < Date.now()) {
      plans.delete(id)
      throw new Error('PLAN_NOT_FOUND')
    }
    return plan
  }

  /** 도구 입력 → 이미지 바꾸기. 파일은 여기서 읽고 확인한다 */
  async function imageChanges(
    adapter: WorkAdapter,
    args: Obj
  ): Promise<{ changes: ImageChanges; sizes: number[] }> {
    const rules = adapter.imageRules
    if (!rules) throw new Error('NO_IMAGES')
    const changes: ImageChanges = {}
    const sizes: number[] = []
    const load = async (path: unknown): Promise<LocalImage> => {
      const file = await loadImage(path, deps, rules)
      sizes.push(file.data.byteLength)
      return file
    }
    if (args.character_index !== undefined) {
      if (!Number.isInteger(args.character_index)) throw new Error('BAD_INDEX')
      changes.character = args.character_index as number
    }
    if (args.add !== undefined) {
      if (!Array.isArray(args.add) || !args.add.every(isObj)) throw new Error('BAD_CHANGES')
      const adds: ImageAdd[] = []
      for (const item of args.add as Obj[])
        adds.push({
          file: await load(item.file),
          ...(typeof item.label === 'string' ? { label: item.label } : {}),
          ...(typeof item.description === 'string' ? { description: item.description } : {}),
          ...(typeof item.visibility === 'string' ? { visibility: item.visibility } : {}),
          ...(item.default === true ? { isDefault: true } : {})
        })
      changes.add = adds
    }
    for (const key of ['remove', 'order'] as const) {
      const value = args[key]
      if (value === undefined) continue
      if (!Array.isArray(value) || value.some((i) => !Number.isInteger(i)))
        throw new Error('BAD_INDEX')
      changes[key] = value as number[]
    }
    if (args.main_file !== undefined) changes.main = await load(args.main_file)
    return { changes, sizes }
  }

  return [
    {
      name: 'images_list',
      description:
        '작품의 이미지 목록을 플랫폼에서 새로 읽는다. 에덴은 캐릭터마다 묶음이 하나씩 있고(label = 이미지 코드), ' +
        '베이비챗은 묶음 하나에 0번이 대표 이미지, 1번부터 감정 이미지다(label = 감정 이름). ' +
        '젠잇은 묶음 0이 에셋(내부 이미지, label = 출력에서 {{url}} 뒤에 붙는 폴더/이름), 묶음 1이 대표 이미지다. ' +
        'images_plan의 remove·order는 여기 나온 index를 쓴다. 묶음마다 count(전체 수)와 offset부터 limit장' +
        '(기본 50, 최대 500)만 주고 next_offset(더 없으면 null)을 알려 준다. group(묶음 번호 = character_index)을 ' +
        '주면 그 묶음만 준다. index는 잘라 줘도 묶음 전체 기준 번호다.',
      inputSchema: {
        type: 'object',
        properties: {
          site,
          work_id: workId,
          group: {
            type: 'integer',
            description: '이 묶음만 본다 (character_index와 같은 번호. 묶음이 하나면 생략)'
          },
          offset: { type: 'integer', description: '묶음 안에서 이 index부터 (next_offset)' },
          limit: { type: 'integer', description: '묶음마다 줄 이미지 수 (기본 50, 최대 500)' }
        },
        required: ['site', 'work_id']
      },
      async run(args) {
        const adapter = workAdapter(str(args.site))
        if (!adapter.imageGroups) throw new Error('NO_IMAGES')
        const raw = await adapter.readRaw(
          deps.reader(adapter.id),
          workKey(adapter, str(args.work_id))
        )
        return {
          site: adapter.id,
          rules: adapter.imageRules,
          ...pagedGroups(adapter.imageGroups(raw), args)
        }
      }
    },
    {
      name: 'images_plan',
      description:
        '이미지를 올리거나 지우기 전 확인 단계. 로컬 파일만 확인하고 플랫폼에는 아무것도 쓰지 않는다. ' +
        '순서: images_list → images_plan → (사용자 확인) → images_apply. ' +
        '에덴: character_index로 캐릭터를 고르고 add로 올린다(label = 이미지 코드, 비우면 자동; default로 대표 지정), ' +
        'remove로 지우고(되돌릴 수 없다), order로 순서를 바꾼다(add와 같이 쓸 수 없다). ' +
        '베이비챗: main_file로 대표 이미지를 바꾸고, add로 감정 이미지를 더하고(label = 감정 이름, 비우면 파일 이름), ' +
        'remove로 감정 이미지를 뺀다. 베이비챗은 적용하면 작품 버전이 하나 오른다. ' +
        '젠잇: character_index 0(기본)은 에셋 — add의 label에 "폴더/이름"(webp, 공백 없음)을 주고 remove로 뺀다, ' +
        '1은 대표 이미지 — 끝에 더하기와 첫 장 아닌 것 빼기만 된다. 젠잇은 작품 저장과 같은 요청으로 올라간다. ' +
        '엘린: main_file로 대표 이미지를 바꾸고, add로 갤러리 이미지를 더한다(label = 영문·숫자 12자 이하 slug, ' +
        'visibility public / partial / private). 공개 작품은 적용하면 검수 요청이 된다. ' +
        '네코챗: main_file로 아바타를 바꾸고, add로 이미지 슬롯을 더한다(label = 영문·숫자 1~20자 slug, ' +
        'visibility public / hidden). ' +
        '우마이: main_file로 표지를 바꾸고, add로 작품 이미지를 더한다(label = 영문 소문자·숫자 5자 slug, 비우면 자동, ' +
        'description = 키워드 30자, visibility public / hidden). 우마이는 임시저장(초안)으로 저장돼, 발행한 작품은 ' +
        '사이트에서 작품 등록을 눌러야 독자에게 보인다. 챗플은 이미지 바꾸기를 지원하지 않는다. ' +
        '파일 한도는 images_list의 rules(확장자·바이트)를 따른다. 결과의 current는 50장이 넘는 묶음이면 ' +
        '앞쪽·대표·건드리는 이미지 주변만 싣는다(partial).',
      inputSchema: {
        type: 'object',
        properties: {
          site,
          work_id: workId,
          character_index: {
            type: 'integer',
            description: '에덴: 이미지를 바꿀 캐릭터 번호 (images_list의 character_index, 기본 0)'
          },
          add: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                file: { type: 'string', description: '로컬 이미지 파일 경로' },
                label: { type: 'string', description: '에덴 이미지 코드 / 베이비챗 감정 이름' },
                description: { type: 'string', description: '에덴 이미지 설명 (기본: 파일 이름)' },
                visibility: {
                  type: 'string',
                  description: '에덴 public / private, 베이비챗 public / hidden (기본 public)'
                },
                default: { type: 'boolean', description: '에덴: 올리면서 대표 이미지로 삼는다' }
              },
              required: ['file']
            },
            description: '올릴 이미지들'
          },
          remove: {
            type: 'array',
            items: { type: 'integer' },
            description: '지울 이미지 번호들 (images_list의 index)'
          },
          main_file: { type: 'string', description: '베이비챗: 새 대표 이미지 파일 경로' },
          order: {
            type: 'array',
            items: { type: 'integer' },
            description: '에덴: 지우고 남은 이미지 전부의 새 순서 (images_list의 index)'
          }
        },
        required: ['site', 'work_id']
      },
      async run(args) {
        const adapter = workAdapter(str(args.site))
        if (!adapter.imageGroups || !adapter.planImages || !adapter.applyImages)
          throw new Error('NO_IMAGES')
        const id = workKey(adapter, str(args.work_id))
        const { changes, sizes } = await imageChanges(adapter, args)
        const raw = await adapter.readRaw(deps.reader(adapter.id), id)
        const groups = adapter.imageGroups(raw)
        const lines = adapter.planImages(raw, changes)

        sweep(imagePlans)
        const planId = randomBytes(4).toString('hex')
        const { site: _site, work_id: _id, ...rest } = args
        void _site
        void _id
        imagePlans.set(planId, {
          site: adapter.id,
          workId: id,
          args: rest,
          base: JSON.stringify(groups),
          sizes,
          expires: Date.now() + PLAN_TTL
        })
        const which = changes.character ?? 0
        const count = groups[which]?.images.length ?? 0
        return {
          plan_id: planId,
          changes: lines,
          // 큰 묶음은 지울 이미지·대표·끝(더할 자리)·앞쪽 일부만 싣는다
          current: trimmedGroups(groups, which, [
            ...(changes.remove ?? []),
            ...(changes.add?.length ? [count - 1] : [])
          ]),
          note: '아직 아무것도 올리거나 지우지 않았어요. 사용자가 확인한 뒤 images_apply를 불러 주세요. 지운 이미지는 되돌릴 수 없어요.',
          ...platformNote(adapter)
        }
      }
    },
    {
      name: 'images_apply',
      description:
        'images_plan으로 세운 계획대로 이미지를 올리고 지운다. 사용자가 그 계획을 보고 진행하라고 한 뒤에만 부른다. ' +
        '계획 뒤 플랫폼의 이미지 목록이나 로컬 파일이 바뀌었으면 멈춘다. 직전 원본을 backup 경로에 남기고, ' +
        '끝난 뒤 다시 읽어 견준 결과를 verified로 돌려준다.',
      inputSchema: {
        type: 'object',
        properties: { plan_id: { type: 'string', description: 'images_plan이 돌려준 plan_id' } },
        required: ['plan_id']
      },
      async run(args) {
        const planId = str(args.plan_id)
        const plan = taken(imagePlans, planId)
        const adapter = workAdapter(plan.site)
        if (!adapter.imageGroups || !adapter.applyImages) throw new Error('NO_IMAGES')
        const read = deps.reader(adapter.id)
        const raw = await adapter.readRaw(read, plan.workId)
        const before = adapter.imageGroups(raw)
        const { changes, sizes } = await imageChanges(adapter, plan.args)
        if (JSON.stringify(before) !== plan.base || sizes.join() !== plan.sizes.join()) {
          imagePlans.delete(planId)
          throw new Error('PLAN_STALE')
        }
        const backup = await deps.snapshot(adapter.id, plan.workId, raw)
        imagePlans.delete(planId)
        forget(adapter.id + ':' + plan.workId)
        await adapter.applyImages(io(deps, adapter.id), plan.workId, raw, changes)

        const afterRaw = await adapter.readRaw(read, plan.workId)
        await deps.snapshot(adapter.id, plan.workId, afterRaw)
        const after = adapter.imageGroups(afterRaw)
        const which = changes.character ?? 0
        const was = before[which]?.images ?? []
        const now = after[which]?.images ?? []
        // 번호가 있으면 번호로, 없으면 주소로 같은 이미지인지 본다
        const key = (image: { id: string | null; url: string }): string => image.id ?? image.url
        const removed = (changes.remove ?? []).map((i) => key(was[i]))
        const kept = was.filter((_, i) => !(changes.remove ?? []).includes(i))
        const problems: string[] = []
        if (now.length !== kept.length + (changes.add?.length ?? 0)) problems.push('이미지 수')
        if (removed.some((k) => now.some((image) => key(image) === k))) problems.push('삭제')
        if (changes.main && (!now[0] || now[0].url === was[0]?.url)) problems.push('대표 이미지')
        if (changes.order && changes.order.map((i) => key(was[i])).join() !== now.map(key).join())
          problems.push('순서')
        const added = changes.add?.length ?? 0
        return {
          applied: true,
          verified: problems.length === 0,
          mismatches: problems,
          // 큰 묶음은 새로 붙은 끝 이미지·대표·앞쪽 일부만 싣는다 (verified는 위에서 전체로 봤다)
          groups: trimmedGroups(
            after,
            which,
            Array.from({ length: added }, (_, i) => now.length - added + i)
          ),
          backup
        }
      }
    },
    {
      name: 'cover_plan',
      description:
        '표지를 올리기 전 확인 단계 (에덴). 플랫폼에는 아무것도 쓰지 않는다. 순서: cover_plan → (사용자 확인) → cover_apply. ' +
        'folder에 표지 폴더 경로를 주면 파일 이름으로 원문·언어 판본을 짝짓는다: 이름이 cover / eden / 표지 / source / 원본 ' +
        '(또는 원문 언어 코드)이면 원문 표지, 이름이 언어 코드로 끝나면 그 판본 표지 ' +
        '(예: cover_en.webp, 표지-ja.webp, zh-TW.webp. kr·jp·tw·cn도 알아본다). ' +
        '짝을 직접 정하려면 files에 {"source": 경로, "en": 경로, …}를 준다(folder보다 우선). ' +
        '받는 파일은 webp와 gif뿐이다(편집기가 올리는 형식). 판본이 아직 없는 언어는 건너뛴다.',
      inputSchema: {
        type: 'object',
        properties: {
          site,
          work_id: workId,
          folder: { type: 'string', description: '표지 파일들이 든 로컬 폴더 경로' },
          files: {
            type: 'object',
            description: '자리 → 로컬 파일 경로. 자리는 source 또는 editions_list의 language',
            additionalProperties: text
          }
        },
        required: ['site', 'work_id']
      },
      async run(args) {
        const adapter = workAdapter(str(args.site))
        const rules = adapter.coverRules
        if (!adapter.uploadCover || !adapter.coverUrl || !rules) throw new Error('NO_COVER')
        const id = workKey(adapter, str(args.work_id))
        const read = deps.reader(adapter.id)
        const raw = await adapter.readRaw(read, id)
        const editions = adapter.editions ? await adapter.editions(read, id) : []
        const languages = editions.map((e) => e.language)
        const sourceLanguage = editions.find((e) => e.isSource)?.language ?? null

        const chosen = new Map<string, string>()
        const ignored: string[] = []
        if (args.folder !== undefined) {
          const folder = str(args.folder).replace(/[\\/]+$/, '')
          let names: string[]
          try {
            names = await deps.listFolder(folder)
          } catch {
            throw new Error('BAD_FILE')
          }
          for (const name of [...names].sort()) {
            const target = rules.extensions.includes(extension(name))
              ? coverTarget(name, languages, sourceLanguage)
              : null
            if (!target) ignored.push(name)
            // 같은 자리에 맞는 파일이 둘이면 어느 쪽인지 고르지 않는다
            else if (chosen.has(target)) throw new Error('COVER_AMBIGUOUS ' + target)
            else chosen.set(target, folder + '/' + name)
          }
        }
        if (args.files !== undefined) {
          if (!isObj(args.files)) throw new Error('BAD_CHANGES')
          for (const [name, path] of Object.entries(args.files)) {
            const key = name.toLowerCase()
            const language = languages.find(
              (l) => l.toLowerCase() === (LANGUAGE_ALIASES[key] ?? key)
            )
            const target =
              key === 'source' || (language && language === sourceLanguage) ? 'source' : language
            if (!target) throw new Error('BAD_LANGUAGE')
            chosen.set(target, str(path))
          }
        }

        const targets: CoverPlan['targets'] = []
        const skipped: { target: string; file: string; reason: string }[] = []
        for (const [target, path] of chosen) {
          const edition = editions.find((e) => e.language === target)
          if (target !== 'source' && !edition?.exists) {
            skipped.push({ target, file: fileName(path), reason: '그 언어 판본이 아직 없어요' })
            continue
          }
          const file = await loadImage(path, deps, rules)
          targets.push({ target, path, size: file.data.byteLength })
        }
        if (!targets.length) throw new Error('NO_CHANGES')

        sweep(coverPlans)
        const planId = randomBytes(4).toString('hex')
        coverPlans.set(planId, {
          site: adapter.id,
          workId: id,
          targets,
          expires: Date.now() + PLAN_TTL
        })
        return {
          plan_id: planId,
          uploads: targets.map((t) => ({
            target: t.target,
            file: fileName(t.path),
            bytes: t.size
          })),
          skipped,
          ignored,
          current_cover: adapter.coverUrl(raw),
          note: '아직 올리지 않았어요. 사용자가 확인한 뒤 cover_apply를 불러 주세요. 올리면 지금 표지를 덮어써요.',
          ...platformNote(adapter)
        }
      }
    },
    {
      name: 'cover_apply',
      description:
        'cover_plan으로 정한 표지를 올린다. 사용자가 계획을 보고 진행하라고 한 뒤에만 부른다. ' +
        '원문 표지는 올리면 바로 작품 표지가 되고, 언어 판본 표지는 올린 뒤 그 판본을 한 번 저장한다 ' +
        '(편집기의 번역 저장과 같은 요청. 자동 번역은 하지 않는다). 하나가 실패하면 거기서 멈추고 ' +
        '어디까지 됐는지 results로 돌려준다.',
      inputSchema: {
        type: 'object',
        properties: { plan_id: { type: 'string', description: 'cover_plan이 돌려준 plan_id' } },
        required: ['plan_id']
      },
      async run(args) {
        const planId = str(args.plan_id)
        const plan = taken(coverPlans, planId)
        const adapter = workAdapter(plan.site)
        const rules = adapter.coverRules
        if (!adapter.uploadCover || !adapter.coverUrl || !rules) throw new Error('NO_COVER')
        const read = deps.reader(adapter.id)
        // 올리기 전에 파일을 전부 다시 읽어, 계획 뒤 바뀐 파일이 있으면 하나도 올리지 않는다
        const files: LocalImage[] = []
        for (const t of plan.targets) {
          const file = await loadImage(t.path, deps, rules)
          if (file.data.byteLength !== t.size) {
            coverPlans.delete(planId)
            throw new Error('PLAN_STALE')
          }
          files.push(file)
        }
        const backup = await deps.snapshot(
          adapter.id,
          plan.workId,
          await adapter.readRaw(read, plan.workId)
        )
        coverPlans.delete(planId)
        forget(adapter.id + ':' + plan.workId)

        const results: Obj[] = []
        for (const [i, t] of plan.targets.entries()) {
          const language = t.target === 'source' ? undefined : t.target
          try {
            if (language && adapter.readEditionRaw)
              await deps.snapshot(
                adapter.id,
                plan.workId + '__' + language,
                await adapter.readEditionRaw(read, plan.workId, language)
              )
            const url = await adapter.uploadCover(
              io(deps, adapter.id),
              plan.workId,
              files[i],
              language
            )
            // 다시 읽어 표지 주소가 방금 올린 것으로 바뀌었는지 본다
            let raw = await adapter.readRaw(read, plan.workId)
            if (language && adapter.readEditionRaw && adapter.editionView)
              raw = adapter.editionView(
                raw,
                await adapter.readEditionRaw(read, plan.workId, language)
              )
            results.push({
              target: t.target,
              file: files[i].name,
              url,
              verified: adapter.coverUrl(raw) === url
            })
          } catch (error) {
            results.push({
              target: t.target,
              file: files[i].name,
              error: error instanceof Error ? error.message.slice(0, 120) : 'unknown'
            })
            break
          }
        }
        const done = results.filter((r) => !r.error).length
        return {
          uploaded: done,
          not_done: plan.targets.slice(results.length).map((t) => t.target),
          verified: done === plan.targets.length && results.every((r) => r.verified === true),
          results,
          backup
        }
      }
    }
  ]
}
