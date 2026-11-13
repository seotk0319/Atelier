// 크랙 이미지 (대표 = 프로필 이미지, 나머지 = 상황 이미지 읽기만). 2026-11-10 편집기 코드에서 읽었다 (실제 호출 전).
//   POST  /crack-api/stories/profile-image   JSON {image: base64(데이터 주소의 ;base64, 뒤)} → {data:{url}}
//   PATCH /crack-api/stories/{id}/v2         수정 등록 본문의 portraitImageUrl에 받은 주소를 넣는다
// 편집기는 고른 파일을 2:3으로 잘라(크롭 창 aspect 2/3) 그 데이터 주소를 올린다. 여기서는 자르지 않으므로
// 2:3이 아닌 파일은 받지 않는다(머리 부분에서 크기를 읽을 수 있을 때만 확인).
// 상황 이미지(미디어 단계)는 서명 주소 묶음 올리기·검수 흐름이라 만들지 않았다 (읽기만, 저장 때 그대로 보낸다).
import {
  CRACK_API,
  CRACK_IMAGE_RULES,
  OID,
  at,
  crackError,
  crackForm,
  crackPatchBody,
  crackPlain,
  crackRaw,
  crackReadRaw,
  crackShapeCheck,
  crackWorkId,
  isObj,
  text,
  type Obj
} from './crack-core'
import type {
  ImageChanges,
  ImageGroup,
  ImagePlanLine,
  LocalImage,
  SendRule,
  WorkIo,
  WorkWrite
} from './types'

/** JSON PATCH 하나(수정 등록)만 send 통로로 나간다. 로그인 헤더를 붙인다 */
export function crackSendRule(method: string, url: string): SendRule | null {
  if (method === 'PATCH' && crackPlain(url, [new RegExp('^/crack-api/stories/' + OID + '/v2$')]))
    return { auth: 'session', body: 'json' }
  return null
}

/** png·jpeg·webp·gif 머리에서 가로·세로를 읽는다. 모르면 null */
export function imageSize(data: Uint8Array): { width: number; height: number } | null {
  const b = data
  const u16 = (i: number): number => (b[i] << 8) | b[i + 1]
  const u32 = (i: number): number =>
    ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0
  const le16 = (i: number): number => b[i] | (b[i + 1] << 8)
  const le24 = (i: number): number => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16)
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47)
    return { width: u32(16), height: u32(20) }
  if (b.length >= 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46)
    return { width: le16(6), height: le16(8) }
  if (
    b.length >= 30 &&
    String.fromCharCode(...b.slice(0, 4)) === 'RIFF' &&
    String.fromCharCode(...b.slice(8, 12)) === 'WEBP'
  ) {
    const kind = String.fromCharCode(...b.slice(12, 16))
    if (kind === 'VP8X') return { width: le24(24) + 1, height: le24(27) + 1 }
    if (kind === 'VP8 ') return { width: le16(26) & 0x3fff, height: le16(28) & 0x3fff }
    if (kind === 'VP8L') {
      const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
    }
    return null
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null
      const marker = b[i + 1]
      const len = u16(i + 2)
      // SOF0~SOF15 (DHT·JPG·DAC 제외)
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
        return { width: u16(i + 7), height: u16(i + 5) }
      i += 2 + len
    }
  }
  return null
}

function checkFile(file: LocalImage): void {
  const ext = (file.name.split('.').pop() || '').toLowerCase()
  if (!CRACK_IMAGE_RULES.extensions.includes(ext)) throw new Error('BAD_IMAGE')
  if (file.data.byteLength > CRACK_IMAGE_RULES.maxBytes) throw new Error('IMAGE_TOO_LARGE')
  const size = imageSize(file.data)
  // 편집기는 2:3으로 잘라 올린다 (1080×1620 권장)
  if (size && Math.abs(size.width / size.height - 2 / 3) > 0.01)
    throw new Error('BAD_IMAGE_RATIO 2:3 (' + size.width + 'x' + size.height + ')')
}

/** 프로필 이미지 하나를 올리고 주소를 돌려준다. 작품에는 아직 반영되지 않는다 */
async function uploadProfile(write: WorkWrite, file: LocalImage): Promise<string> {
  checkFile(file)
  const res = await write('POST', CRACK_API + '/stories/profile-image', {
    image: Buffer.from(file.data).toString('base64')
  })
  if (res.status === 401 || res.status === 403) throw new Error('LOGIN_REQUIRED')
  if (res.status === 413) throw new Error('IMAGE_TOO_LARGE')
  const reply: unknown = await res.json().catch(() => null)
  if (!res.ok) throw new Error('IMAGE_UPLOAD_FAILED ' + res.status + ' ' + crackError(reply))
  const data = isObj(reply) && isObj(reply.data) ? reply.data : null
  const url = data ? text(data.url) : ''
  try {
    // 사이트 안 주소로 줄 때도 있어 크랙 기준으로 풀어 본다. 돌려주는 값은 받은 그대로다
    if (url && new URL(url, 'https://crack.wrtn.ai').protocol === 'https:') return url
  } catch {
    /* 아래에서 던진다 */
  }
  throw new Error(
    'IMAGE_UPLOAD_FAILED response ' +
      res.status +
      ' ' +
      (data
        ? Object.keys(data).slice(0, 8).join(',')
        : isObj(reply)
          ? Object.keys(reply).join(',')
          : typeof reply)
  )
}

/** 0번은 프로필 이미지(대표), 1번부터 상황 이미지(읽기만) */
export function crackImageGroups(raw: unknown): ImageGroup[] {
  const form = crackForm(crackRaw(raw).story)
  return [
    {
      character: null,
      name: form.name,
      images: [
        {
          id: null,
          url: form.portraitImageUrl,
          label: '대표',
          description: '',
          visibility: null,
          isDefault: true
        },
        ...form._situationImages.map((e: Obj) => ({
          id: text(e._id) || null,
          url: text(e.imageUrl),
          // 편집기 YI(): 분류::상황, 없으면 키워드
          label:
            text(e.category).trim() && text(e.situation).trim()
              ? text(e.category).trim() + '::' + text(e.situation).trim()
              : text(e.keyword).trim(),
          description: text(e.hint),
          visibility: null,
          isDefault: false
        }))
      ]
    }
  ]
}

export function crackPlanImages(raw: unknown, changes: ImageChanges): ImagePlanLine[] {
  const total = crackImageGroups(raw)[0].images.length
  if (changes.character !== undefined) throw new Error('BAD_CHANGES')
  for (const i of changes.remove ?? []) at(i, total)
  if (changes.remove?.includes(0)) throw new Error('KEEP_MAIN_IMAGE')
  // 상황 이미지 올리기·지우기·순서는 서명 주소 묶음·검수 흐름이라 막아 둔다
  if (changes.add?.length || changes.remove?.length || changes.order)
    throw new Error('NOT_SUPPORTED situation_images')
  if (!changes.main) throw new Error('NO_CHANGES')
  checkFile(changes.main)
  crackShapeCheck(crackRaw(raw).story)
  return [{ action: 'main', detail: '대표 이미지(프로필) ← ' + changes.main.name }]
}

/** 프로필 이미지를 올린 뒤 수정 등록한다. 새 주소를 돌려준다 */
async function replaceProfile(
  io: WorkIo,
  id: string,
  raw: unknown,
  file: LocalImage
): Promise<string> {
  const wid = crackWorkId(id)
  // 이미지를 올리기 전에 수정 등록 본문을 지을 수 있는 원본인지 본다 (올린 이미지만 남지 않게)
  crackShapeCheck(crackRaw(raw).story)
  const url = await uploadProfile(io.write, file)
  const next = structuredClone(crackRaw(raw))
  next.story.portraitImage = { origin: url }
  next.story.isMovingPortraitImage = /\.gif$/i.test(file.name)
  const res = await io.send({
    method: 'PATCH',
    url: CRACK_API + '/stories/' + wid + '/v2',
    json: crackPatchBody(next.story)
  })
  if (res.status === 401 || res.status === 403) throw new Error('LOGIN_REQUIRED')
  const reply: unknown = await res.json().catch(() => null)
  if (res.status === 422 && isObj(reply) && reply.code === 'STALE_BASE_SNAPSHOT')
    throw new Error('PLAN_STALE')
  if (!res.ok) throw new Error('SAVE_FAILED ' + res.status + ' ' + crackError(reply))
  return url
}

export async function crackApplyImages(
  io: WorkIo,
  id: string,
  raw: unknown,
  changes: ImageChanges
): Promise<void> {
  crackPlanImages(raw, changes)
  await replaceProfile(io, id, raw, changes.main as LocalImage)
}

/** 새 작품 대표 이미지: 올리기만 하고 주소를 돌려준다 (create가 portraitImageUrl로 쓴다) */
export async function crackUploadImage(io: WorkIo, file: LocalImage): Promise<string> {
  return uploadProfile(io.write, file)
}

/** 표지 = 프로필 이미지. 올린 뒤 수정 등록하고 그 주소를 돌려준다. 크랙은 언어 판본이 없다 */
export async function crackUploadCover(
  io: WorkIo,
  id: string,
  file: LocalImage,
  language?: string
): Promise<string> {
  if (language) throw new Error('NO_EDITIONS')
  const raw = await crackReadRaw(io.read, id)
  checkFile(file)
  return replaceProfile(io, id, raw, file)
}
