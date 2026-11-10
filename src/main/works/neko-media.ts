// 네코챗 이미지 (대표 이미지 = 아바타, 나머지 = 이미지 슬롯). 2026-11-10 편집기 코드에서 읽었다 (실제 호출 전).
//   POST /api/upload/character-avatar       파일 묶음: file, characterId              → {url}
//   POST /api/upload/character-image-slot   파일 묶음: file, characterId, imageSlug   → {url}
// 편집기는 저장 버튼을 누르면 파일을 먼저 올리고(3개씩), 받은 주소를 편집 데이터에 넣어
// PUT /api/characters 한 번으로 저장한다 (올린 주소는 uploadedImageUrls로 같이 보낸다).
// 움직이는 webp 2MB 초과는 편집기가 /api/upload/character-avatar-optimized로 보내는데, 여기서는 쓰지 않는다.
import { randomInt } from 'node:crypto'
import {
  NEKO_IMAGE_RULES,
  NEKO_ORIGIN,
  at,
  avatarUrl,
  isObj,
  list,
  nekoPlain,
  nekoPut,
  nekoRaw,
  nekoReadRaw,
  nekoWorkId,
  strOrNull,
  text,
  type Obj
} from './neko-core'
import type {
  ImageChanges,
  ImageGroup,
  ImagePlanLine,
  LocalImage,
  SendRule,
  WorkIo,
  WorkSend
} from './types'

const AVATAR = NEKO_ORIGIN + '/api/upload/character-avatar'
const SLOT = NEKO_ORIGIN + '/api/upload/character-image-slot'
// IMAGE_SLOT_LIMITS: 슬롯 300개, 설명 100자, 슬러그 영문·숫자 1~20자
const MAX_SLOTS = 300
const SLUG_RE = /^[a-zA-Z0-9]{1,20}$/
const IMAGE_VISIBILITIES = ['public', 'hidden']

/** 파일 묶음 두 주소만 허용한다. 사이트 쿠키로 로그인을 확인한다 */
export function nekoSendRule(method: string, url: string): SendRule | null {
  if (
    method === 'POST' &&
    nekoPlain(url, [/^\/api\/upload\/character-avatar$/, /^\/api\/upload\/character-image-slot$/])
  )
    return { auth: 'session', body: 'form' }
  return null
}

function checkFile(file: LocalImage): void {
  const ext = (file.name.split('.').pop() || '').toLowerCase()
  if (!NEKO_IMAGE_RULES.extensions.includes(ext)) throw new Error('BAD_IMAGE')
  if (file.data.byteLength > NEKO_IMAGE_RULES.maxBytes) throw new Error('IMAGE_TOO_LARGE')
}

async function uploaded(res: Response): Promise<string> {
  if (res.status === 401 || res.status === 403) throw new Error('LOGIN_REQUIRED')
  if (res.status === 413) throw new Error('IMAGE_TOO_LARGE')
  const reply: unknown = await res.json().catch(() => null)
  if (!res.ok)
    throw new Error(
      'IMAGE_UPLOAD_FAILED ' + res.status + ' ' + text(isObj(reply) ? reply.error : '').slice(0, 60)
    )
  const url = isObj(reply) ? text(reply.url) : ''
  try {
    // 사이트 안 주소(/로 시작)로 줄 때도 있어 사이트 기준으로 풀어 본다. 돌려주는 값은 받은 그대로다
    if (url && new URL(url, 'https://www.nekochat.xyz').protocol === 'https:') return url
  } catch {
    /* 아래에서 던진다 */
  }
  // 응답 모양만 남긴다 (칸 이름과 주소 앞부분)
  throw new Error(
    'IMAGE_UPLOAD_FAILED response ' +
      res.status +
      ' ' +
      (isObj(reply) ? Object.keys(reply).slice(0, 8).join(',') : typeof reply) +
      ' ' +
      url.slice(0, 40)
  )
}
/** 아바타(대표 이미지) 파일 하나를 올리고 주소를 돌려준다. 작품에는 아직 반영되지 않는다 */
export async function nekoUploadAvatar(
  send: WorkSend,
  characterId: string,
  file: LocalImage
): Promise<string> {
  checkFile(file)
  return uploaded(
    await send({
      method: 'POST',
      url: AVATAR,
      form: [
        { name: 'file', file },
        { name: 'characterId', value: characterId }
      ]
    })
  )
}
async function uploadSlot(
  send: WorkSend,
  characterId: string,
  slug: string,
  file: LocalImage
): Promise<string> {
  checkFile(file)
  return uploaded(
    await send({
      method: 'POST',
      url: SLOT,
      form: [
        { name: 'file', file },
        { name: 'characterId', value: characterId },
        { name: 'imageSlug', value: slug }
      ]
    })
  )
}

/** 0번은 아바타(대표), 1번부터 이미지 슬롯 */
export function nekoImageGroups(raw: unknown): ImageGroup[] {
  const c = nekoRaw(raw).character
  return [
    {
      character: null,
      name: text(c.displayName),
      images: [
        {
          id: null,
          url: avatarUrl(c),
          label: '대표',
          description: '',
          visibility: null,
          isDefault: true
        },
        ...list(c.imageSlots).map((e) => ({
          id: null,
          url: text(e.url),
          label: text(e.slug),
          description: text(e.description),
          visibility: e.isVisible === false ? 'hidden' : 'public',
          isDefault: false
        }))
      ]
    }
  ]
}

const ALNUM = 'abcdefghijklmnopqrstuvwxyz0123456789'
// 편집기 SLUG_AUTO_LENGTH 6
const randomSlug = (): string =>
  Array.from({ length: 6 }, () => ALNUM[randomInt(ALNUM.length)]).join('')

export function nekoPlanImages(raw: unknown, changes: ImageChanges): ImagePlanLine[] {
  const slots = list(nekoRaw(raw).character.imageSlots)
  const total = slots.length + 1
  if (changes.character !== undefined) throw new Error('BAD_CHANGES')
  const lines: ImagePlanLine[] = []
  if (changes.main) {
    checkFile(changes.main)
    lines.push({ action: 'main', detail: '대표 이미지(아바타) ← ' + changes.main.name })
  }
  const gone = new Set((changes.remove ?? []).map((i) => at(i, total)))
  if (gone.size !== (changes.remove ?? []).length) throw new Error('BAD_INDEX')
  // 0번은 아바타다. 바꿀 수만 있다.
  if (gone.has(0)) throw new Error('KEEP_MAIN_IMAGE')
  for (const i of gone)
    lines.push({ action: 'remove', detail: '[' + i + '] ' + text(slots[i - 1].slug) + ' 삭제' })

  const adds = changes.add ?? []
  const slugs = new Set(slots.flatMap((e, i) => (gone.has(i + 1) ? [] : [text(e.slug)])))
  for (const add of adds) {
    checkFile(add.file)
    if (add.isDefault) throw new Error('BAD_CHANGES')
    if (add.visibility !== undefined && !IMAGE_VISIBILITIES.includes(add.visibility))
      throw new Error('BAD_VISIBILITY')
    if (add.label !== undefined && (!SLUG_RE.test(add.label) || slugs.has(add.label)))
      throw new Error('BAD_IMAGE_LABEL')
    if ((add.description ?? '').length > 100) throw new Error('BAD_IMAGE_LABEL')
    if (add.label) slugs.add(add.label)
    lines.push({
      action: 'add',
      detail: '이미지 슬롯 ← ' + add.file.name + (add.label ? ' (' + add.label + ')' : '')
    })
  }
  if (slots.length - gone.size + adds.length > MAX_SLOTS) throw new Error('IMAGE_LIMIT')

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
    lines.push({ action: 'order', detail: '이미지 슬롯 순서 → ' + wanted.join(', ') })
  }
  if (!lines.length) throw new Error('NO_CHANGES')
  return lines
}

export async function nekoApplyImages(
  io: WorkIo,
  id: string,
  raw: unknown,
  changes: ImageChanges
): Promise<void> {
  await applyAndSave(io, id, raw, changes)
}

/** 파일을 올리고 저장한다. 새 아바타 주소를 돌려준다 (없으면 null) */
async function applyAndSave(
  io: WorkIo,
  id: string,
  raw: unknown,
  changes: ImageChanges
): Promise<string | null> {
  nekoPlanImages(raw, changes)
  const wid = nekoWorkId(id)
  const next = structuredClone(nekoRaw(raw))
  const c = next.character
  let slots = list(c.imageSlots)
  const taken = new Set(slots.map((e) => text(e.slug)))

  // 올리기를 먼저 끝낸다. 하나라도 실패하면 작품은 건드리지 않는다.
  const sent: string[] = []
  let mainUrl: string | null = null
  if (changes.main) {
    mainUrl = await nekoUploadAvatar(io.send, wid, changes.main)
    sent.push(mainUrl)
    c.avatar = { ...(isObj(c.avatar) ? c.avatar : {}), url: mainUrl }
  }
  const added: Obj[] = []
  for (const add of changes.add ?? []) {
    let slug = add.label ?? randomSlug()
    while (!add.label && taken.has(slug)) slug = randomSlug()
    taken.add(slug)
    const url = await uploadSlot(io.send, wid, slug, add.file)
    sent.push(url)
    added.push({
      slug,
      description: add.description ?? '',
      url,
      triggerKeywords: [],
      folderId: null,
      isVisible: add.visibility !== 'hidden',
      isAlwaysVisible: false
    })
  }
  const gone = new Set(changes.remove ?? [])
  if (changes.order) slots = changes.order.slice(1).map((i) => slots[i - 1])
  else slots = slots.filter((_, i) => !gone.has(i + 1))
  c.imageSlots = [...slots, ...added]
  await nekoPut(io.write, wid, c, sent)
  return mainUrl
}

/** 표지 = 아바타. 올린 뒤 저장하고 그 주소를 돌려준다. 네코챗은 언어 판본이 없다 */
export async function nekoUploadCover(
  io: WorkIo,
  id: string,
  file: LocalImage,
  language?: string
): Promise<string> {
  if (language) throw new Error('NO_EDITIONS')
  const raw = await nekoReadRaw(io.read, id)
  const url = await applyAndSave(io, id, raw, { main: file })
  if (!strOrNull(url)) throw new Error('COVER_NOT_CHANGED')
  // 부르는 쪽(cover_apply)이 다시 읽어 이 주소가 작품 표지가 됐는지 견준다
  return url as string
}
