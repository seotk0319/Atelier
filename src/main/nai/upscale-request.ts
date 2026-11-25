// upstream NAIS3 4924d8f·0e9d1b5 — NAI가 2026-08에 업스케일을 V5 업스케일러로 바꿨다.
// 옛 주소(api.novelai.net, JSON, 2배·4배)는 404로 거절된다 (2026-11-25 실측).
export const UPSCALE_MODEL = 'nai-diffusion-5-curated'
export { UPSCALE_SCALE } from '../../shared/anlas'

/** image 호스트의 /ai/upscale에 보내는 multipart 요청 */
export function upscaleRequest(token: string, imageBase64: string): RequestInit {
  const body = new FormData()
  body.append('image', new Blob([Buffer.from(imageBase64, 'base64')], { type: 'image/png' }))
  body.append(
    'request',
    new Blob([JSON.stringify({ image: 'image', model: UPSCALE_MODEL, declared_blur_sigma: 0 })], {
      type: 'application/json'
    })
  )
  return {
    method: 'POST',
    // Content-Type은 넣지 않는다 — fetch가 multipart 경계를 붙여 준다
    headers: {
      Authorization: `Bearer ${token.trim()}`,
      'x-correlation-id': Math.random().toString(36).slice(2, 8),
      'x-initiated-at': new Date().toISOString()
    },
    body
  }
}
