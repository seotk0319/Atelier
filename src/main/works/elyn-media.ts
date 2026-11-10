// 엘린 이미지(대표 이미지 + 갤러리). 엘린은 이미지를 따로 올리는 주소가 없고, 판 저장 요청에
// 파일을 같이 실어 보낸다 (2026-11-10 편집기 코드: buildCharacterFormData가 대표 이미지 파일을 먼저,
// 그다음 새 갤러리 이미지 파일을 "files"로 붙이고 data JSON의 assetData.images에 번호 없는(id:null) 항목을 둔다).
// 그래서 이미지 바꾸기도 판 저장 → 제출(elynCommit) 한 번으로 끝난다. 공개 작품은 검수 요청이 된다.
// 편집기는 새 파일이 10개·20MiB를 넘으면 나눠 저장하는데, 여기서는 한 묶음만 받는다(IMAGE_BATCH_LIMIT).
import { randomInt } from 'node:crypto'
import {
  C_PATH,
  ELYN_BATCH_BYTES,
  ELYN_BATCH_FILES,
  UUID,
  at,
  bytes,
  checkImageFile,
  elynCommit,
  elynPlain,
  elynRaw,
  elynReadRaw,
  elynWorkId,
  list,
  strOrNull,
  text,
  type ElynRaw,
  type Obj
} from './elyn-core'
import type { ImageChanges, ImageGroup, ImagePlanLine, LocalImage, SendRule, WorkIo } from './types'

const SEND_PATHS = [
  new RegExp(C_PATH + UUID + '/draft$', 'i'),
  /^\/api\/v1\/characters\/create\/simple$/
]
// 갤러리 이미지 공개 범위 (편집기: public / partial / private, 기본 partial)
const IMAGE_VISIBILITIES = ['public', 'partial', 'private']
// IMAGE_SLUG_REGEX, IMAGE_MAX_COUNT
const SLUG_RE = /^[A-Za-z0-9]{0,12}$/
const MAX_IMAGES = 100

/** 파일 묶음으로 가는 두 주소(판 저장, 새 작품)만 허용한다. 엘린 로그인 헤더를 붙인다 */
export function elynSendRule(method: string, url: string): SendRule | null {
  if (method === 'POST' && elynPlain(url, SEND_PATHS)) return { auth: 'session', body: 'form' }
  return null
}

const images = (raw: unknown): { r: ElynRaw; subs: Obj[] } => {
  const r = elynRaw(raw)
  return { r, subs: list(r.form.subImages) }
}

/** 0번은 대표 이미지, 1번부터 갤러리 이미지다 */
export function elynImageGroups(raw: unknown): ImageGroup[] {
  const { r, subs } = images(raw)
  return [
    {
      character: null,
      name: text(r.form.name),
      images: [
        {
          id: null,
          url: text(r.form.imageUrl),
          label: '대표',
          description: '',
          visibility: null,
          isDefault: true
        },
        ...subs.map((e) => ({
          id: strOrNull(e.id),
          url: text(e.image_url),
          label: text(e.slug),
          description: text(e.description),
          visibility: strOrNull(e.visibility),
          isDefault: false
        }))
      ]
    }
  ]
}

// 편집기 generateRandomSlug(6)
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
const randomSlug = (): string =>
  Array.from({ length: 6 }, () => ALNUM[randomInt(ALNUM.length)]).join('')
/** 편집기처럼 파일 이름(확장자 뺌)을 설명으로 쓰되, 설명 한도(30자 또는 80바이트)에 맞춘다 */
function describe(name: string): string {
  let out = name.replace(/\.[^/.]+$/, '')
  while (out.length > 30 && bytes(out) > 80) out = out.slice(0, -1)
  return out
}

export function elynPlanImages(raw: unknown, changes: ImageChanges): ImagePlanLine[] {
  const { subs } = images(raw)
  const total = subs.length + 1
  if (changes.character !== undefined) throw new Error('BAD_CHANGES')
  const lines: ImagePlanLine[] = []
  if (changes.main) {
    checkImageFile(changes.main)
    lines.push({ action: 'main', detail: '대표 이미지 ← ' + changes.main.name })
  }

  const gone = new Set((changes.remove ?? []).map((i) => at(i, total)))
  if (gone.size !== (changes.remove ?? []).length) throw new Error('BAD_INDEX')
  // 0번은 대표 이미지다. 엘린은 대표 이미지가 꼭 있어야 해서 바꿀 수만 있다.
  if (gone.has(0)) throw new Error('KEEP_MAIN_IMAGE')
  for (const i of gone)
    lines.push({
      action: 'remove',
      detail: '[' + i + '] ' + (text(subs[i - 1].slug) || text(subs[i - 1].description)) + ' 삭제'
    })

  const adds = changes.add ?? []
  const slugs = new Set(
    subs.flatMap((e, i) => (!gone.has(i + 1) && text(e.slug) ? [text(e.slug)] : []))
  )
  for (const add of adds) {
    checkImageFile(add.file)
    // 대표 이미지는 main으로만 바꾼다
    if (add.isDefault) throw new Error('BAD_CHANGES')
    if (add.visibility !== undefined && !IMAGE_VISIBILITIES.includes(add.visibility))
      throw new Error('BAD_VISIBILITY')
    const slug = add.label ?? ''
    if (!SLUG_RE.test(slug) || (slug && slugs.has(slug))) throw new Error('BAD_IMAGE_LABEL')
    if (slug) slugs.add(slug)
    const description = add.description ?? describe(add.file.name)
    if (description.length > 30 && bytes(description) > 80) throw new Error('BAD_IMAGE_LABEL')
    lines.push({
      action: 'add',
      detail: '갤러리 ← ' + add.file.name + (slug ? ' (' + slug + ')' : '')
    })
  }
  if (subs.length - gone.size + adds.length > MAX_IMAGES) throw new Error('IMAGE_LIMIT')
  const files = [...(changes.main ? [changes.main] : []), ...adds.map((a) => a.file)]
  if (
    files.length > ELYN_BATCH_FILES ||
    files.reduce((n, f) => n + f.data.byteLength, 0) > ELYN_BATCH_BYTES
  )
    throw new Error('IMAGE_BATCH_LIMIT')

  if (changes.order) {
    // 새 이미지는 번호가 아직 없어 순서에 넣을 수 없다. 대표 이미지(0)는 맨 앞에 둔다.
    if (adds.length) throw new Error('BAD_CHANGES')
    const left = Array.from({ length: total }, (_, i) => i).filter((i) => !gone.has(i))
    const wanted = changes.order.map((i) => at(i, total))
    if (
      wanted.length !== left.length ||
      new Set(wanted).size !== left.length ||
      wanted[0] !== 0 ||
      wanted.some((i) => gone.has(i))
    )
      throw new Error('BAD_INDEX')
    lines.push({ action: 'order', detail: '갤러리 순서 → ' + wanted.join(', ') })
  }
  if (!lines.length) throw new Error('NO_CHANGES')
  return lines
}

/** 이미지 바꾸기를 얹은 새 원본과 함께 보낼 파일 (대표 → 새 갤러리 순) */
export function elynImagesNext(
  raw: unknown,
  changes: ImageChanges
): { next: ElynRaw; files: LocalImage[] } {
  elynPlanImages(raw, changes)
  const next = structuredClone(elynRaw(raw))
  let subs = list(next.form.subImages)
  const gone = new Set(changes.remove ?? [])
  if (changes.order) subs = changes.order.slice(1).map((i) => subs[i - 1])
  else subs = subs.filter((_, i) => !gone.has(i + 1))
  const added = (changes.add ?? []).map((add) => ({
    id: null,
    image_url: '',
    slug: add.label || randomSlug(),
    description: add.description ?? describe(add.file.name),
    visibility: add.visibility ?? 'partial'
  }))
  next.form.subImages = [...subs, ...added]
  return {
    next,
    files: [...(changes.main ? [changes.main] : []), ...(changes.add ?? []).map((a) => a.file)]
  }
}

export async function elynApplyImages(
  io: WorkIo,
  id: string,
  raw: unknown,
  changes: ImageChanges
): Promise<void> {
  const { next, files } = elynImagesNext(raw, changes)
  await elynCommit(io, elynWorkId(id), next, files)
}

/** 표지 = 대표 이미지. 바꾼 뒤 다시 읽어 새 주소를 돌려준다. 엘린은 언어 판본이 없다 */
export async function elynUploadCover(
  io: WorkIo,
  id: string,
  file: LocalImage,
  language?: string
): Promise<string> {
  if (language) throw new Error('NO_EDITIONS')
  const wid = elynWorkId(id)
  const raw = await elynReadRaw(io.read, wid)
  const before = text(raw.form.imageUrl)
  await elynApplyImages(io, wid, raw, { main: file })
  const after = text((await elynReadRaw(io.read, wid)).form.imageUrl)
  if (!after || after === before) throw new Error('COVER_NOT_CHANGED')
  return after
}
