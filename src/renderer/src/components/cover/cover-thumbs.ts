import { useEffect, useState } from 'react'
import { getBlob } from './engine/state'

/**
 * 표지 재료 썸네일. 원본 비트맵은 캐시하지 않고, 긴 변 size*2 픽셀의 PNG object URL만
 * 모듈 단위로 재사용한다. 같은 blobKey·size 조합은 한 번만 디코드한다.
 */

const cache = new Map<string, Promise<string>>()

async function drawToBlob(bitmap: ImageBitmap): Promise<Blob> {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('썸네일 캔버스를 만들지 못했어요')
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(bitmap, 0, 0)
    return canvas.convertToBlob({ type: 'image/png' })
  }
  const canvas = document.createElement('canvas')
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('썸네일 캔버스를 만들지 못했어요')
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(bitmap, 0, 0)
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('썸네일을 만들지 못했어요'))),
      'image/png'
    )
  })
}

async function makeThumb(blobKey: string, size: number): Promise<string> {
  const blob = await getBlob(blobKey)
  if (!blob) throw new Error('이미지를 찾지 못했어요')
  const target = Math.max(16, Math.round(size * 2))
  let bitmap = await createImageBitmap(blob)
  try {
    const long = Math.max(bitmap.width, bitmap.height)
    if (long > target) {
      const scale = target / long
      const w = Math.max(1, Math.round(bitmap.width * scale))
      const h = Math.max(1, Math.round(bitmap.height * scale))
      bitmap.close()
      bitmap = await createImageBitmap(blob, {
        resizeWidth: w,
        resizeHeight: h,
        resizeQuality: 'high'
      })
    }
    return URL.createObjectURL(await drawToBlob(bitmap))
  } finally {
    bitmap.close()
  }
}

/** blobKey의 썸네일 object URL. 아직 읽는 중이거나 실패하면 null */
export function useBlobThumb(blobKey: string | null | undefined, size = 96): string | null {
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    if (!blobKey) {
      setUrl(null)
      return
    }
    const key = blobKey + ':' + size
    const cached = cache.get(key)
    const pending =
      cached ??
      (() => {
        const created = makeThumb(blobKey, size)
        cache.set(key, created)
        created.catch(() => {
          if (cache.get(key) === created) cache.delete(key)
        })
        return created
      })()
    let alive = true
    setUrl(null)
    void pending.then(
      (value) => {
        if (alive) setUrl(value)
      },
      () => {
        if (alive) setUrl(null)
      }
    )
    return () => {
      alive = false
    }
  }, [blobKey, size])

  return url
}
