// 베이비챗 이미지 올리기. 사이트는 Vercel Blob "클라이언트 업로드"를 쓴다 (2026-11-10 사이트 코드:
// upload(fileName, file, {access:'public', handleUploadUrl:'/api/upload'}), gif는 먼저 /api/convert-gif).
// 올리는 순서는 공개된 @vercel/blob 클라이언트(2.9.0)와 같다. 사이트가 실제로 묶어 둔 버전은 확인하지 못했다.
//   1) POST https://babechat.ai/api/upload   {type:'blob.generate-client-token', payload:{pathname, …}}
//        → {clientToken}   (사이트 쿠키로 로그인 확인)
//   2) PUT  https://vercel.com/api/blob/?pathname=…   파일 바이트, authorization: Bearer {clientToken}
//        → {url, …}
// 받은 url을 편집 데이터 images[]에 넣고 저장해야 작품에 반영된다 (images[0]이 대표 이미지).
import { randomUUID } from 'node:crypto'
import type {
  FileRules,
  ImageChanges,
  ImageGroup,
  ImagePlanLine,
  LocalImage,
  SendRule,
  WorkSend
} from './types'

const SITE = 'https://babechat.ai'
const UPLOAD = SITE + '/api/upload'
const CONVERT_GIF = SITE + '/api/convert-gif'
const BLOB_API = 'https://vercel.com/api/blob/'
// 공개 클라이언트가 보내는 API 버전 (@vercel/blob 2.9.0의 BLOB_API_VERSION)
const BLOB_API_VERSION = '13'
const BLOB_HEADERS = [
  'authorization',
  'x-api-version',
  'x-vercel-blob-access',
  'x-vercel-blob-store-id',
  'x-api-blob-request-id',
  'x-api-blob-request-attempt'
]
const PATHNAME_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(webp|png|jpe?g|gif)$/
// 사이트의 로그인 토큰 쿠키. 사이트 코드도 새 토큰을 받을 때마다 이 쿠키에 적는다.
const SESSION_COOKIE = { name: 'bc__session', domain: 'babechat.ai' }

// 사이트가 받는 종류와 크기 (5,000,000바이트)
export const BABE_IMAGE_RULES: FileRules = {
  extensions: ['webp', 'png', 'jpg', 'jpeg', 'gif'],
  maxBytes: 5_000_000
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
const list = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter(isObj) : [])
const text = (v: unknown): string => (typeof v === 'string' ? v : '')

function at(index: unknown, length: number): number {
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= length)
    throw new Error('BAD_INDEX')
  return index
}

/** 이미지 올리기에 쓰는 세 주소의 허용 규칙. 베이비챗 API(api.babechatapi.com)는 JSON 통로를 쓴다 */
export function babeSendRule(method: string, url: string): SendRule | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  if (u.username || u.password || u.hash) return null
  if (method === 'POST' && !u.search && u.href === UPLOAD)
    return { auth: 'cookie', body: 'json', cookieFromBearer: SESSION_COOKIE }
  if (method === 'POST' && !u.search && u.href === CONVERT_GIF)
    return { auth: 'cookie', body: 'form', cookieFromBearer: SESSION_COOKIE }
  if (method === 'PUT' && u.origin + u.pathname === BLOB_API) {
    const params = [...u.searchParams.keys()]
    // 저장소는 다른 회사 주소다. 베이비챗 로그인 정보는 붙이지 않고 받은 업로드 토큰만 보낸다.
    if (params.length === 1 && PATHNAME_RE.test(u.searchParams.get('pathname') ?? ''))
      return { auth: 'none', body: 'bytes', headers: BLOB_HEADERS }
  }
  return null
}

function imageUrl(v: unknown): string {
  const url = text(v)
  try {
    const u = new URL(url)
    // 올린 파일은 베이비챗의 Blob 저장소 주소로만 돌아온다
    if (
      u.protocol === 'https:' &&
      (u.hostname.endsWith('.public.blob.vercel-storage.com') || u.hostname === 'blob.babechat.ai')
    )
      return url
  } catch {
    /* 아래에서 던진다 */
  }
  throw new Error('IMAGE_UPLOAD_FAILED response')
}

/** 이미지 하나를 올리고 주소를 돌려준다. 작품에는 아직 아무것도 바뀌지 않는다 */
export async function babeUploadImage(send: WorkSend, file: LocalImage): Promise<string> {
  const extension = (file.name.split('.').pop() || 'png').toLowerCase()
  const pathname = randomUUID() + '.' + extension
  if (!PATHNAME_RE.test(pathname)) throw new Error('BAD_IMAGE')

  if (extension === 'gif') {
    // 편집기와 같은 순서: gif는 먼저 webp 변환을 맡기고, 안 되면 그대로 올린다
    const converted = await send({
      method: 'POST',
      url: CONVERT_GIF,
      form: [
        { name: 'file', file },
        { name: 'fileName', value: pathname }
      ]
    }).catch(() => null)
    const reply: unknown = converted?.ok ? await converted.json().catch(() => null) : null
    if (isObj(reply) && reply.converted && text(reply.url)) return imageUrl(reply.url)
  }

  const ticket = await send({
    method: 'POST',
    url: UPLOAD,
    json: {
      type: 'blob.generate-client-token',
      // callbackUrl은 옛 클라이언트가 보내던 칸이다. 새 서버는 무시하고 옛 서버는 필요로 해서 같이 보낸다.
      payload: { pathname, callbackUrl: UPLOAD, clientPayload: null, multipart: false }
    }
  })
  if (ticket.status === 401 || ticket.status === 403) throw new Error('LOGIN_REQUIRED')
  const issued: unknown = ticket.ok ? await ticket.json().catch(() => null) : null
  const token = isObj(issued) ? text(issued.clientToken) : ''
  if (!token) throw new Error('IMAGE_UPLOAD_FAILED token ' + ticket.status)

  // 토큰 모양: vercel_blob_client_{저장소 번호}_{…}
  const storeId = token.split('_')[3] ?? ''
  const target = new URL(BLOB_API)
  target.searchParams.set('pathname', pathname)
  const stored = await send({
    method: 'PUT',
    url: target.href,
    bytes: { data: file.data, contentType: file.type },
    headers: {
      authorization: 'Bearer ' + token,
      'x-api-version': BLOB_API_VERSION,
      'x-vercel-blob-access': 'public',
      'x-vercel-blob-store-id': storeId,
      'x-api-blob-request-id': storeId + ':' + Date.now() + ':' + randomUUID().slice(0, 8),
      'x-api-blob-request-attempt': '0'
    }
  })
  if (!stored.ok) throw new Error('IMAGE_UPLOAD_FAILED store ' + stored.status)
  const reply: unknown = await stored.json().catch(() => null)
  return imageUrl(isObj(reply) ? reply.url : null)
}

const images = (raw: unknown): Obj[] => {
  if (!isObj(raw) || !isObj(raw.edit)) throw new Error('WORK_SHAPE')
  return list(raw.edit.images)
}

export function babeImageGroups(raw: unknown): ImageGroup[] {
  return [
    {
      character: null,
      name: text(((raw as Obj).edit as Obj).name),
      images: images(raw).map((image, i) => ({
        id: null,
        url: text(image.url),
        label: text(image.emotion),
        description: '',
        visibility: image.hidden === true ? 'hidden' : 'public',
        isDefault: i === 0
      }))
    }
  ]
}

// 편집기가 파일 이름에서 감정 이름을 만드는 규칙: 첫 점 앞, NFC, 20자
const emotionOf = (name: string): string => (name.split('.')[0] || '').normalize('NFC').slice(0, 20)

export function babePlanImages(raw: unknown, changes: ImageChanges): ImagePlanLine[] {
  const current = images(raw)
  // 베이비챗은 캐릭터가 하나고, 감정 이미지 순서 바꾸기는 아직 만들지 않았다
  if (changes.character !== undefined || changes.order) throw new Error('BAD_CHANGES')
  const lines: ImagePlanLine[] = []
  if (changes.main)
    lines.push({
      action: 'main',
      detail: '대표 이미지 ← ' + changes.main.name + ' (지금 대표는 빠짐)'
    })

  const gone = new Set((changes.remove ?? []).map((i) => at(i, current.length)))
  if (gone.size !== (changes.remove ?? []).length) throw new Error('BAD_INDEX')
  // 0번은 대표 이미지다. 대표는 바꿀 수만 있다.
  if (gone.has(0)) throw new Error('KEEP_MAIN_IMAGE')
  for (const i of gone)
    lines.push({
      action: 'remove',
      detail: '[' + i + '] ' + (text(current[i].emotion) || '(이름 없음)') + ' 삭제'
    })

  const names = new Set(
    current.flatMap((image, i) =>
      i > 0 && !gone.has(i) && text(image.emotion) ? [image.emotion] : []
    )
  )
  for (const add of changes.add ?? []) {
    if (add.isDefault || add.description !== undefined) throw new Error('BAD_CHANGES')
    if (add.visibility !== undefined && add.visibility !== 'public' && add.visibility !== 'hidden')
      throw new Error('BAD_VISIBILITY')
    const emotion = add.label ?? emotionOf(add.file.name)
    // 감정 이미지는 이름이 있어야 저장된다. 같은 이름이 둘이면 어느 쪽이 쓰일지 알 수 없다.
    if (!emotion.trim() || emotion.length > 20 || names.has(emotion))
      throw new Error('BAD_IMAGE_LABEL')
    names.add(emotion)
    lines.push({ action: 'add', detail: '감정 이미지 ← ' + add.file.name + ' (' + emotion + ')' })
  }
  if (!lines.length) throw new Error('NO_CHANGES')
  return lines
}

/** 파일을 올리고 그 주소를 얹은 새 원본을 돌려준다 (저장은 부르는 쪽이 한다) */
export async function babeImagesNext(
  send: WorkSend,
  raw: unknown,
  changes: ImageChanges
): Promise<unknown> {
  babePlanImages(raw, changes)
  const next = structuredClone(raw) as Obj
  const edit = next.edit as Obj
  let all = list(edit.images)

  // 올리기를 먼저 끝낸다. 하나라도 실패하면 작품은 건드리지 않는다.
  const mainUrl = changes.main ? await babeUploadImage(send, changes.main) : null
  const added: Obj[] = []
  for (const add of changes.add ?? [])
    added.push({
      url: await babeUploadImage(send, add.file),
      emotion: add.label ?? emotionOf(add.file.name),
      hidden: add.visibility === 'hidden'
    })

  if (mainUrl) all[0] = { ...(all[0] ?? {}), url: mainUrl }
  const gone = new Set(changes.remove ?? [])
  all = [...all.filter((_, i) => !gone.has(i)), ...added]
  edit.images = all
  return next
}
