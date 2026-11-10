// 우마이 이미지 (표지 = thumbnail, 나머지 = 작품 이미지 images[]). 2026-11-10 사이트 코드에서 읽었다 (실제 호출 전).
//   1) POST /v1/image/upload-url  JSON {data:[{tempId, originalImagename, originalSizeBytes, sha256Base64}]}
//        → {data:[{imageId, uploadUrl, uploadFields}]}          (35550 getUploadUrl, 81235 업로드 훅: 20장씩)
//   2) POST {uploadUrl}  파일 묶음: uploadFields 칸들 + file      (51570 r4 — 로그인 정보 없이 브라우저 fetch)
//   3) 받은 imageId를 스냅샷의 thumbnail {imageId} / images[{imageId, isPublic, keyword, slug}]에 넣고 저장
// 받는 파일: image/jpeg·png·webp·gif, 10MB(0xa00000) 이하 (81235 MAX_FILE_SIZE, ACCEPTED_TYPES)
// 이미지 참조키(slug)는 영문 소문자·숫자 5자 (55962 /^[a-z0-9]{5}$/, 77592 무작위 5자)
// 저장은 늘 임시저장(초안)이다. 이미 발행한 작품이면 사이트에서 '작품 등록'을 눌러야 독자에게 보인다.
import { createHash, randomInt, randomUUID } from 'node:crypto'
import {
  UUMAI_API,
  UUID_RE,
  at,
  isObj,
  list,
  text,
  uumaiRaw,
  uumaiReadRaw,
  uumaiSave,
  uumaiSaveBody,
  uumaiWorkId,
  type Obj
} from './uumai-core'
import type {
  FileRules,
  ImageChanges,
  ImageGroup,
  ImagePlanLine,
  LocalImage,
  SendRule,
  WorkIo,
  WorkWrite
} from './types'

export const UUMAI_IMAGE_RULES: FileRules = {
  extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif'],
  maxBytes: 0xa00000
}
const TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif'
}
const MAX_IMAGES = 1000
const SLUG_RE = /^[a-z0-9]{5}$/
const IMAGE_VISIBILITIES = ['public', 'hidden']

// 업로드 주소는 우마이 API가 그때그때 내준다(저장소 주소를 미리 알 수 없다). 그래서 이 연결부가
// 로그인한 API 응답으로 받은 주소만 30분 동안 허용하고, 거기에는 로그인 정보를 붙이지 않는다.
const issued = new Map<string, number>()
function sweep(): void {
  const now = Date.now()
  for (const [url, expires] of issued) if (expires < now) issued.delete(url)
}

export function uumaiSendRule(method: string, url: string): SendRule | null {
  if (method !== 'POST') return null
  sweep()
  if (issued.has(url)) return { auth: 'none', body: 'form' }
  return null
}

function checkFile(file: LocalImage): string {
  const ext = (file.name.split('.').pop() || '').toLowerCase()
  const type = TYPES[ext]
  if (!type) throw new Error('BAD_IMAGE')
  if (file.data.byteLength > UUMAI_IMAGE_RULES.maxBytes) throw new Error('IMAGE_TOO_LARGE')
  return type
}

/** 파일 하나를 올리고 imageId를 돌려준다 (작품에는 아직 들어가지 않는다) */
async function upload(io: WorkIo, file: LocalImage): Promise<string> {
  const type = checkFile(file)
  const res = await io.write('POST', UUMAI_API + '/image/upload-url', {
    data: [
      {
        tempId: randomUUID(),
        originalImagename: file.name,
        originalSizeBytes: file.data.byteLength,
        sha256Base64: createHash('sha256').update(file.data).digest('base64')
      }
    ]
  })
  if (res.status === 401 || res.status === 403) throw new Error('LOGIN_REQUIRED')
  const reply: unknown = await res.json().catch(() => null)
  if (!res.ok) throw new Error('IMAGE_UPLOAD_FAILED ' + res.status)
  const slot = isObj(reply) ? list(reply.data)[0] : undefined
  const imageId = slot ? text(slot.imageId) : ''
  const uploadUrl = slot ? text(slot.uploadUrl) : ''
  const fields = slot && isObj(slot.uploadFields) ? slot.uploadFields : {}
  let target: URL | null = null
  try {
    target = new URL(uploadUrl)
  } catch {
    target = null
  }
  if (!UUID_RE.test(imageId) || !target || target.protocol !== 'https:')
    throw new Error(
      'IMAGE_UPLOAD_FAILED response ' +
        (slot ? Object.keys(slot).slice(0, 8).join(',') : typeof reply)
    )
  issued.set(target.href, Date.now() + 30 * 60_000)
  // 51570 r4: uploadFields 칸을 먼저, 파일은 마지막에 'file'로 (문자열 값만)
  const form = [
    ...Object.entries(fields)
      .filter((e): e is [string, string] => typeof e[1] === 'string')
      .map(([name, value]) => ({ name, value })),
    { name: 'file', file: { ...file, type } }
  ]
  const sent = await io.send({ method: 'POST', url: target.href, form })
  if (!sent.ok) throw new Error('IMAGE_UPLOAD_FAILED storage ' + sent.status)
  return imageId
}

const thumbOf = (w: Obj): Obj | null => (isObj(w.thumbnail) ? w.thumbnail : null)
/** 표지 주소. 스냅샷에 주소가 없으면 이미지 번호로 대신한다 (같은 표지인지 견줄 때만 쓴다) */
export function uumaiCoverUrl(raw: unknown): string | null {
  const t = thumbOf(uumaiRaw(raw).work)
  if (!t) return null
  return text(t.url) || (text(t.imageId) ? 'imageId:' + text(t.imageId) : null)
}

/** 0번은 표지(thumbnail), 1번부터 작품 이미지 */
export function uumaiImageGroups(raw: unknown): ImageGroup[] {
  const w = uumaiRaw(raw).work
  const t = thumbOf(w)
  return [
    {
      character: null,
      name: text(w.title),
      images: [
        {
          id: t ? text(t.imageId) || null : null,
          url: t ? text(t.url) : '',
          label: '표지',
          description: '',
          visibility: null,
          isDefault: true
        },
        ...list(w.images).map((e) => ({
          id: text(e.imageId) || null,
          url: text(e.url),
          label: text(e.slug),
          description: text(e.keyword),
          visibility: e.isPublic === false ? 'hidden' : 'public',
          isDefault: false
        }))
      ]
    }
  ]
}

const ALNUM = 'abcdefghijklmnopqrstuvwxyz0123456789'
const randomSlug = (): string =>
  Array.from({ length: 5 }, () => ALNUM[randomInt(ALNUM.length)]).join('')

export function uumaiPlanImages(raw: unknown, changes: ImageChanges): ImagePlanLine[] {
  const images = list(uumaiRaw(raw).work.images)
  const total = images.length + 1
  if (changes.character !== undefined) throw new Error('BAD_CHANGES')
  const lines: ImagePlanLine[] = []
  if (changes.main) {
    checkFile(changes.main)
    lines.push({ action: 'main', detail: '표지 ← ' + changes.main.name })
  }
  const gone = new Set((changes.remove ?? []).map((i) => at(i, total)))
  if (gone.size !== (changes.remove ?? []).length) throw new Error('BAD_INDEX')
  // 0번은 표지다. 바꿀 수만 있다.
  if (gone.has(0)) throw new Error('KEEP_MAIN_IMAGE')
  for (const i of gone)
    lines.push({ action: 'remove', detail: '[' + i + '] ' + text(images[i - 1].slug) + ' 빼기' })

  const adds = changes.add ?? []
  const slugs = new Set(images.flatMap((e, i) => (gone.has(i + 1) ? [] : [text(e.slug)])))
  for (const add of adds) {
    checkFile(add.file)
    if (add.isDefault) throw new Error('BAD_CHANGES')
    if (add.visibility !== undefined && !IMAGE_VISIBILITIES.includes(add.visibility))
      throw new Error('BAD_VISIBILITY')
    if (add.label !== undefined && (!SLUG_RE.test(add.label) || slugs.has(add.label)))
      throw new Error('BAD_IMAGE_LABEL slug 영문 소문자·숫자 5자, 겹치지 않게')
    if ((add.description ?? '').length > 30) throw new Error('BAD_IMAGE_LABEL keyword ~30자')
    if (add.label) slugs.add(add.label)
    lines.push({
      action: 'add',
      detail: '작품 이미지 ← ' + add.file.name + (add.label ? ' (' + add.label + ')' : '')
    })
  }
  if (images.length - gone.size + adds.length > MAX_IMAGES) throw new Error('IMAGE_LIMIT')

  if (changes.order) {
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
    lines.push({ action: 'order', detail: '작품 이미지 순서 → ' + wanted.join(', ') })
  }
  if (!lines.length) throw new Error('NO_CHANGES')
  return lines
}

/** 파일을 모두 올린 뒤 초안으로 한 번 저장한다. 새 표지 imageId를 돌려준다 (없으면 null) */
async function applyAndSave(
  io: WorkIo,
  id: string,
  raw: unknown,
  changes: ImageChanges,
  write: WorkWrite
): Promise<string | null> {
  uumaiPlanImages(raw, changes)
  const wid = uumaiWorkId(id)
  const next = structuredClone(uumaiRaw(raw))
  const w = next.work
  let images = list(w.images)
  const taken = new Set(images.map((e) => text(e.slug)))

  // 올리기를 먼저 끝낸다. 하나라도 실패하면 작품은 건드리지 않는다.
  let mainId: string | null = null
  if (changes.main) {
    mainId = await upload(io, changes.main)
    w.thumbnail = { imageId: mainId }
  }
  const added: Obj[] = []
  for (const add of changes.add ?? []) {
    let slug = add.label ?? randomSlug()
    while (!add.label && taken.has(slug)) slug = randomSlug()
    taken.add(slug)
    const imageId = await upload(io, add.file)
    added.push({
      imageId,
      isPublic: add.visibility !== 'hidden',
      keyword: add.description ?? '',
      slug
    })
  }
  const gone = new Set(changes.remove ?? [])
  if (changes.order) images = changes.order.slice(1).map((i) => images[i - 1])
  else images = images.filter((_, i) => !gone.has(i + 1))
  w.images = [...images, ...added]
  await uumaiSave(write, uumaiSaveBody(w, { isPublish: false, workId: wid }))
  return mainId
}

export async function uumaiApplyImages(
  io: WorkIo,
  id: string,
  raw: unknown,
  changes: ImageChanges
): Promise<void> {
  await applyAndSave(io, id, raw, changes, io.write)
}

/** 표지 = thumbnail. 올리고 초안으로 저장한 뒤 다시 읽어 표지 주소를 돌려준다. 우마이는 언어 판본이 없다 */
export async function uumaiUploadCover(
  io: WorkIo,
  id: string,
  file: LocalImage,
  language?: string
): Promise<string> {
  if (language) throw new Error('NO_EDITIONS')
  const raw = await uumaiReadRaw(io.read, id)
  const imageId = await applyAndSave(io, id, raw, { main: file }, io.write)
  const after = await uumaiReadRaw(io.read, id)
  const t = thumbOf(after.work)
  if (!imageId || !t || text(t.imageId) !== imageId) throw new Error('COVER_NOT_CHANGED')
  return uumaiCoverUrl(after) as string
}
