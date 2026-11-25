import { readFileSync } from 'fs'
import { basename } from 'path'
import sharp from 'sharp'
import type { ExtraCharRef } from '../../shared/types'
import type { CharacterReferenceOptions, VibeOptions } from '../nai/payload'
import { ENDPOINTS } from '../nai/endpoints'
import { refBucket, refImageMode } from '../../shared/char-refs'
import { enabledCharRefRows, enabledVibeRows, saveVibeEncoding } from './repo'

let vibesInFlight: Promise<{ vibes: VibeOptions[]; newlyEncoded: number[] }> | null = null

/** 생성 직전 바이브 준비 — 미인코딩/ie 변경분만 encode-vibe (2 Anlas) 후 캐시.
 *  newlyEncoded: 이번에 새로 인코딩된 바이브 id (카드 표시 갱신 통지용) */
export function prepareVibes(
  token: string,
  maySpend: () => boolean = () => true
): Promise<{ vibes: VibeOptions[]; newlyEncoded: number[] }> {
  if (!vibesInFlight) {
    vibesInFlight = prepareVibesOnce(token, maySpend).finally(() => {
      vibesInFlight = null
    })
  }
  return vibesInFlight
}

async function prepareVibesOnce(
  token: string,
  maySpend: () => boolean
): Promise<{ vibes: VibeOptions[]; newlyEncoded: number[] }> {
  const rows = enabledVibeRows()
  const vibes: VibeOptions[] = []
  const newlyEncoded: number[] = []
  for (const row of rows) {
    let encoded = row.encoded
    if (!encoded || row.encodedIe !== row.infoExtracted) {
      if (!maySpend())
        throw new Error('Anlas 소모 OFF: 새 바이브 인코딩은 유료이므로 중단했습니다.')
      const image = readRefFile(row.filePath, '바이브', row.name).toString('base64')
      const res = await fetch(ENDPOINTS.encodeVibe, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token.trim()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image,
          information_extracted: row.infoExtracted,
          model: 'nai-diffusion-4-5-full'
        })
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`바이브 인코딩 실패 ${res.status}: ${text.slice(0, 200)}`)
      }
      encoded = Buffer.from(await res.arrayBuffer()).toString('base64')
      saveVibeEncoding(row.id, encoded, row.infoExtracted)
      newlyEncoded.push(row.id)
    }
    vibes.push({ strength: row.strength, encodedVibeBase64: encoded })
  }
  return { vibes, newlyEncoded }
}

/**
 * 캐릭레퍼 이미지 전처리 — 보낼 모델에 맞춘 모양으로 (shared/char-refs.ts `refImageMode`).
 * - canvas (V4.5): OpenAPI 명세의 1024×1536 / 1536×1024 / 1472×1472 캔버스에 검정 패딩.
 * - bucket (V5): 가장 가까운 약 1MP 버킷을 덮게 키우고 가운데를 자른다 (NAI 웹과 같음).
 */
/**
 * 레퍼 그림 파일을 읽는다. 파일이 지워졌거나 옮겨졌으면 어느 레퍼인지 알려 준다
 * (그대로 두면 켜 둔 동안 모든 장이 ENOENT 원문으로 실패한다).
 */
function readRefFile(filePath: string, kind: string, name: string): Buffer {
  try {
    return readFileSync(filePath)
  } catch {
    throw new Error(
      `${kind} 그림 파일을 찾지 못했어요: 「${name}」. 목록에서 끄거나 지운 뒤 다시 해 주세요.`
    )
  }
}

async function processCharRefImage(
  filePath: string,
  name: string,
  mode: 'canvas' | 'bucket'
): Promise<string> {
  const buf = readRefFile(filePath, '레퍼런스', name)
  const meta = await sharp(buf)
    .metadata()
    .catch(() => {
      throw new Error(`레퍼런스 그림을 읽지 못했어요: 「${name}」. 그림 파일이 깨졌을 수 있어요.`)
    })
  // 휴대폰 JPEG는 EXIF 회전값으로 세워 보인다 — 그 방향대로 세운 크기로 모양을 고르고 그림도 세워 보낸다
  const turned = (meta.orientation ?? 1) >= 5
  const w = (turned ? meta.height : meta.width) ?? 1
  const h = (turned ? meta.width : meta.height) ?? 1

  if (mode === 'bucket') {
    const bucket = refBucket(w, h)
    const png = bucket.unchanged
      ? await sharp(buf).rotate().png().toBuffer()
      : await sharp(buf)
          .rotate()
          .resize(bucket.resizeWidth, bucket.resizeHeight, { fit: 'fill' })
          .extract({
            left: bucket.left,
            top: bucket.top,
            width: bucket.width,
            height: bucket.height
          })
          .png()
          .toBuffer()
    return png.toString('base64')
  }

  const ratio = w / h
  const canvas =
    ratio > 1.2
      ? { w: 1536, h: 1024 }
      : ratio < 1 / 1.2
        ? { w: 1024, h: 1536 }
        : { w: 1472, h: 1472 }

  const png = await sharp(buf)
    .rotate()
    .resize(canvas.w, canvas.h, { fit: 'contain', background: { r: 0, g: 0, b: 0 } })
    .png()
    .toBuffer()
  return png.toString('base64')
}

/** 같은 모양을 준비하는 동시 요청은 한 번만 처리한다 (계정 여럿이 동시에 생성할 때) */
const charRefsInFlight = new Map<'canvas' | 'bucket', Promise<CharacterReferenceOptions[]>>()

export function prepareCharRefs(model: string): Promise<CharacterReferenceOptions[]> {
  const mode = refImageMode(model)
  let pending = charRefsInFlight.get(mode)
  if (!pending) {
    pending = prepareCharRefsOnce(mode).finally(() => {
      charRefsInFlight.delete(mode)
    })
    charRefsInFlight.set(mode, pending)
  }
  return pending
}

async function prepareCharRefsOnce(
  mode: 'canvas' | 'bucket'
): Promise<CharacterReferenceOptions[]> {
  const rows = enabledCharRefRows()
  const result: CharacterReferenceOptions[] = []
  for (const row of rows) {
    result.push({
      referenceType: row.refType as CharacterReferenceOptions['referenceType'],
      strength: row.strength,
      fidelity: row.fidelity,
      imageBase64: await processCharRefImage(row.filePath, row.name, mode)
    })
  }
  return result
}

/** 1회성 캐릭터 레퍼런스 — 라이브러리 DB에 저장하지 않고 동일한 이미지 전처리만 적용 */
export async function prepareExtraCharRefs(
  refs: ExtraCharRef[],
  model: string
): Promise<CharacterReferenceOptions[]> {
  const mode = refImageMode(model)
  const result: CharacterReferenceOptions[] = []
  for (const ref of refs) {
    result.push({
      referenceType: ref.refType as CharacterReferenceOptions['referenceType'],
      strength: ref.strength,
      fidelity: ref.fidelity,
      imageBase64: await processCharRefImage(ref.filePath, basename(ref.filePath), mode)
    })
  }
  return result
}
