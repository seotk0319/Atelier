// 에덴 캐릭터 이미지와 표지 올리기. 주소와 본문은 2026-11-10 편집기 코드에서 읽었다 (실제 호출 전).
//   POST   /api/works/{id}/characters/{cid}/images            파일 묶음: images, [defaultIndex], tags,
//                                                              descriptions, visibilities, preview_codes, media_types
//                                                              → {images:[{id,url,…}]}  (너무 크면 413)
//   DELETE /api/works/{id}/characters/{cid}/images?imageId=   이미지 하나 지우기
//   PUT    /api/works/{id}/characters/{cid}/images/reorder    {imageIds} → {success}
//   POST   /api/works/{id}/upload-cover/signed-url            {fileName, contentType, size} → {path, token}
//   PUT    {저장소}/storage/v1/object/upload/sign/work-covers/{path}?token=   파일 묶음: cacheControl, 파일
//   POST   /api/works/{id}/upload-cover                       {storagePath, contentType} → {url}
//   POST   /api/works/{id}/translations/{lang}/cover          같은 본문, 언어 판본 표지 → {url}
import { randomInt } from 'node:crypto'
import type {
  FileRules,
  FormField,
  ImageAdd,
  ImageChanges,
  ImageGroup,
  ImagePlanLine,
  LocalImage,
  SendRule,
  WorkIo,
  WorkSend
} from './types'

const ORIGIN = 'https://www.eden-chat.com'
// 에덴의 파일 저장소 (편집기 코드에 적힌 Supabase 주소)
const STORAGE = 'https://jhbfalszdxacwjnrrvms.supabase.co'
const COVER_PREFIX = '/storage/v1/object/upload/sign/work-covers/'
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const UUID_RE = new RegExp('^' + UUID + '$', 'i')
const IMAGES_PATH = new RegExp('^/api/works/' + UUID + '/characters/' + UUID + '/images$', 'i')

// 편집기는 올리기 전에 4,493,168바이트 이하로 줄인다. 그보다 크면 플랫폼이 413으로 거절한다.
export const EDEN_IMAGE_RULES: FileRules = {
  extensions: ['webp', 'jpg', 'jpeg', 'png', 'gif'],
  maxBytes: 4_493_168
}
// 편집기는 표지를 webp(또는 gif 그대로)로만 올린다. 크기 한도는 코드에 없어 넉넉히 막아 둔다.
export const EDEN_COVER_RULES: FileRules = { extensions: ['webp', 'gif'], maxBytes: 10_000_000 }
const VISIBILITIES = ['public', 'private']

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
const list = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter(isObj) : [])
const text = (v: unknown): string => (typeof v === 'string' ? v : '')

function at(index: unknown, length: number): number {
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= length)
    throw new Error('BAD_INDEX')
  return index
}

/** JSON이 아닌 요청(파일 묶음·삭제 쿼리·저장소)의 허용 규칙 */
export function edenSendRule(method: string, url: string): SendRule | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  if (u.username || u.password || u.hash) return null
  const params = [...u.searchParams.keys()]
  if (u.origin === ORIGIN && IMAGES_PATH.test(u.pathname)) {
    if (method === 'POST' && !u.search) return { auth: 'session', body: 'form' }
    const imageId = u.searchParams.get('imageId') ?? ''
    if (method === 'DELETE' && params.length === 1 && UUID_RE.test(imageId))
      return { auth: 'session', body: 'none' }
    return null
  }
  if (u.origin === STORAGE && method === 'PUT' && u.pathname.startsWith(COVER_PREFIX)) {
    const segments = u.pathname.slice(COVER_PREFIX.length).split('/')
    const safe = segments.every(
      (s) => /^[A-Za-z0-9._~%-]+$/.test(s) && s !== '.' && s !== '..' && !/%(2f|5c|2e)/i.test(s)
    )
    const token = u.searchParams.get('token') ?? ''
    if (safe && params.length === 1 && /^[A-Za-z0-9._-]{16,4096}$/.test(token))
      // 저장소에는 그 주소에 따로 저장된 헤더만 붙이고, 에덴 쿠키는 보내지 않는다
      return { auth: 'origin', body: 'form', headers: ['x-upsert'] }
  }
  return null
}

export function edenImageGroups(raw: unknown): ImageGroup[] {
  if (!isObj(raw)) throw new Error('WORK_SHAPE')
  const images = isObj(raw.images) ? raw.images : {}
  return list(raw.characters).map((c, character) => ({
    character,
    name: text(c.character_name),
    images: list(images[text(c.id)]).map((image) => ({
      id: text(image.id) || null,
      url: text(image.url),
      label: text(image.image_code),
      description: text(image.description),
      visibility: text(image.visibility) || null,
      isDefault: image.is_default === true
    }))
  }))
}

// 편집기가 새 이미지에 붙이는 코드와 같은 규칙: 헷갈리는 글자를 뺀 5글자
function imageCode(): string {
  const letters = 'abcdefghjkmnpqrstuvwxyz23456789'
  return Array.from({ length: 5 }, () => letters[randomInt(letters.length)]).join('')
}
const baseName = (name: string): string => name.replace(/\.[^.]+$/, '')

export function edenPlanImages(raw: unknown, changes: ImageChanges): ImagePlanLine[] {
  const groups = edenImageGroups(raw)
  const group = groups[at(changes.character ?? 0, groups.length)]
  // 에덴은 대표 이미지를 올릴 때 정한다 (add의 default)
  if (changes.main) throw new Error('BAD_CHANGES')
  const lines: ImagePlanLine[] = []

  const codes = new Set(groups.flatMap((g) => g.images.map((i) => i.label)).filter(Boolean))
  const adds = changes.add ?? []
  if (adds.filter((a) => a.isDefault).length > 1) throw new Error('BAD_CHANGES')
  for (const add of adds) {
    if (add.visibility !== undefined && !VISIBILITIES.includes(add.visibility))
      throw new Error('BAD_VISIBILITY')
    if (add.label !== undefined) {
      // 이미지 코드는 본문에서 이미지를 부르는 이름이라 겹치면 안 된다
      if (!add.label.trim() || /\s/.test(add.label) || codes.has(add.label))
        throw new Error('BAD_IMAGE_LABEL')
      codes.add(add.label)
    }
    lines.push({
      action: 'add',
      detail:
        group.name +
        ' ← ' +
        add.file.name +
        (add.label ? ' (코드 ' + add.label + ')' : ' (코드 자동)') +
        (add.isDefault ? ' · 대표 이미지로' : '')
    })
  }

  const gone = new Set((changes.remove ?? []).map((i) => at(i, group.images.length)))
  if (gone.size !== (changes.remove ?? []).length) throw new Error('BAD_INDEX')
  for (const i of gone) {
    const image = group.images[i]
    if (!image.id) throw new Error('BAD_INDEX')
    // 대표 이미지를 지운 뒤 플랫폼이 무엇을 대표로 삼는지 모른다. 새 대표를 같이 올리거나 전부 지울 때만 받는다.
    if (image.isDefault && gone.size < group.images.length && !adds.some((a) => a.isDefault))
      throw new Error('KEEP_MAIN_IMAGE')
    lines.push({
      action: 'remove',
      detail: group.name + ' → [' + i + '] ' + (image.label || image.id) + ' 삭제 (되돌릴 수 없음)'
    })
  }

  if (changes.order) {
    // 새로 올린 이미지는 번호가 아직 없어 순서에 넣을 수 없다
    if (adds.length) throw new Error('BAD_CHANGES')
    const left = group.images.map((_, i) => i).filter((i) => !gone.has(i))
    const wanted = changes.order.map((i) => at(i, group.images.length))
    if (wanted.length !== left.length || new Set(wanted).size !== left.length)
      throw new Error('BAD_INDEX')
    if (wanted.some((i) => gone.has(i) || !group.images[i].id)) throw new Error('BAD_INDEX')
    lines.push({ action: 'order', detail: group.name + ' 순서 → ' + wanted.join(', ') })
  }
  if (!lines.length) throw new Error('NO_CHANGES')
  return lines
}

async function failed(res: Response, code: string): Promise<never> {
  if (res.status === 401 || res.status === 403) throw new Error('LOGIN_REQUIRED')
  if (res.status === 413) throw new Error('IMAGE_TOO_LARGE')
  throw new Error(code + ' ' + res.status)
}

export async function edenUploadImage(
  send: WorkSend,
  workId: string,
  characterId: string,
  add: ImageAdd
): Promise<string> {
  // 칸 순서와 값은 편집기가 보내는 것과 같다
  const form: FormField[] = [
    { name: 'images', file: add.file },
    ...(add.isDefault ? [{ name: 'defaultIndex', value: '0' }] : []),
    { name: 'tags', value: '' },
    { name: 'descriptions', value: add.description ?? baseName(add.file.name) },
    { name: 'visibilities', value: add.visibility ?? 'public' },
    { name: 'preview_codes', value: add.label ?? imageCode() },
    { name: 'media_types', value: 'image' }
  ]
  const res = await send({
    method: 'POST',
    url: ORIGIN + '/api/works/' + workId + '/characters/' + characterId + '/images',
    form
  })
  if (!res.ok) await failed(res, 'IMAGE_UPLOAD_FAILED')
  const reply: unknown = await res.json().catch(() => null)
  const made = isObj(reply) && Array.isArray(reply.images) ? list(reply.images) : []
  const id = made.length === 1 ? text(made[0].id) : ''
  if (!id) throw new Error('IMAGE_UPLOAD_FAILED response')
  return id
}

export async function edenApplyImages(
  io: WorkIo,
  workId: string,
  raw: unknown,
  changes: ImageChanges
): Promise<void> {
  edenPlanImages(raw, changes)
  const character = changes.character ?? 0
  const group = edenImageGroups(raw)[character]
  const characterId = text(list((raw as Obj).characters)[character]?.id).toLowerCase()
  if (!UUID_RE.test(characterId)) throw new Error('WORK_SHAPE')
  const base = ORIGIN + '/api/works/' + workId + '/characters/' + characterId + '/images'

  // 올리기를 먼저 한다. 올리다 실패하면 아무것도 지워지지 않은 채로 멈춘다.
  for (const add of changes.add ?? []) await edenUploadImage(io.send, workId, characterId, add)
  for (const i of changes.remove ?? []) {
    const res = await io.send({
      method: 'DELETE',
      url: base + '?imageId=' + encodeURIComponent(String(group.images[i].id))
    })
    if (!res.ok) await failed(res, 'IMAGE_DELETE_FAILED')
  }
  if (changes.order) {
    const res = await io.write('PUT', base + '/reorder', {
      imageIds: changes.order.map((i) => group.images[i].id)
    })
    const reply: unknown = await res.json().catch(() => null)
    if (!res.ok || !isObj(reply) || reply.success !== true) await failed(res, 'IMAGE_ORDER_FAILED')
  }
}

/** 표지 파일을 저장소에 올리고 작품(또는 언어 판본) 표지로 등록한 뒤 그 주소를 돌려준다 */
export async function edenUploadCover(
  io: WorkIo,
  workId: string,
  file: LocalImage,
  language?: string
): Promise<string> {
  const base = ORIGIN + '/api/works/' + workId
  const ticket = await io.write('POST', base + '/upload-cover/signed-url', {
    fileName: file.name,
    contentType: file.type,
    size: file.data.byteLength
  })
  if (!ticket.ok) await failed(ticket, 'COVER_FAILED prepare')
  const signed: unknown = await ticket.json().catch(() => null)
  const path = isObj(signed) ? text(signed.path) : ''
  const token = isObj(signed) ? text(signed.token) : ''
  if (!path || !token) throw new Error('COVER_FAILED prepare response')

  // 저장소 클라이언트(supabase-js uploadToSignedUrl)와 같은 요청: 앞뒤·겹친 빗금을 정리한 경로에
  // token을 붙여 PUT, 본문은 cacheControl과 이름 없는 파일 칸.
  const clean = path.replace(/^\/|\/$/g, '').replace(/\/+/g, '/')
  const target = new URL(STORAGE + COVER_PREFIX + clean)
  target.searchParams.set('token', token)
  const stored = await io.send({
    method: 'PUT',
    url: target.href,
    form: [
      { name: 'cacheControl', value: '3600' },
      { name: '', file }
    ],
    headers: { 'x-upsert': 'false' }
  })
  if (!stored.ok) throw new Error('COVER_FAILED upload ' + stored.status)

  const done = await io.write(
    'POST',
    language ? base + '/translations/' + language + '/cover' : base + '/upload-cover',
    { storagePath: path, contentType: file.type }
  )
  if (!done.ok) await failed(done, 'COVER_FAILED finalize')
  const reply: unknown = await done.json().catch(() => null)
  const url = isObj(reply) ? text(reply.url) : ''
  if (!/^https:\/\//i.test(url)) throw new Error('COVER_FAILED finalize response')
  return url
}
