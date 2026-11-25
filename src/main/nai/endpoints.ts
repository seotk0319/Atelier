/**
 * NAI 엔드포인트.
 *
 * 2026-06 이전: user 계열이 api.novelai.net에서 image.novelai.net으로 이동했다.
 * 전 호출을 image 호스트 단일로 사용한다. /ai/upscale도 V5 업스케일러로 바뀌면서
 * image 호스트로 옮겨 왔다 (옛 api.novelai.net 주소는 404, 2026-11-25 실측).
 */
export const NAI_HOST = 'https://image.novelai.net'

export const ENDPOINTS = {
  generateImage: `${NAI_HOST}/ai/generate-image`,
  generateImageStream: `${NAI_HOST}/ai/generate-image-stream`,
  suggestTags: `${NAI_HOST}/ai/generate-image/suggest-tags`,
  encodeVibe: `${NAI_HOST}/ai/encode-vibe`,
  augmentImage: `${NAI_HOST}/ai/augment-image`,
  login: `${NAI_HOST}/user/login`,
  userData: `${NAI_HOST}/user/data`,
  userInfo: `${NAI_HOST}/user/information`,
  subscription: `${NAI_HOST}/user/subscription`,
  upscale: `${NAI_HOST}/ai/upscale`
} as const
