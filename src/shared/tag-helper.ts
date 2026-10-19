// AI 태그 도우미 공용 정의. 한글 설명이나 그림을 NAI(단부루) 태그 한 줄로 바꾼다.

/**
 * 그림에서 뽑을 것 (여러 개 고를 수 있다). 순서는 ZK-514 31단계를 따른다.
 * look: 외형 — 성별·얼굴·머리·체형 (1, 9~13번)
 * outfit: 의상 — 옷과 장신구 (14~30번)
 * pose: 자세·표정 — 시선·자세·행동·표정 (3, 6~8번)
 * scene: 구도·배경 — 상황·카메라·배경·조명
 * 한글로 쓸 때는 고르지 않는다. 적은 내용만 태그로 바꾼다.
 */
export type TagHelperPart = 'look' | 'outfit' | 'pose' | 'scene'
export const TAG_HELPER_PARTS: { id: TagHelperPart; label: string }[] = [
  { id: 'look', label: '외형' },
  { id: 'outfit', label: '의상' },
  { id: 'pose', label: '자세·표정' },
  { id: 'scene', label: '구도·배경' }
]

export interface TagHelperTextRequest {
  text: string
  /** 추가 지시 (선택) 예: "마스크는 빼고" */
  note?: string
}
export interface TagHelperImageRequest {
  /** data: 접두사 없는 base64 */
  imageBase64: string
  /** image/png, image/jpeg, image/webp */
  mime: string
  /** 뽑을 것. 하나 이상 */
  parts: TagHelperPart[]
  note?: string
}

export interface TagHelperItem {
  tag: string
  /** 로컬 단부루 태그 DB(resources/tags.json)나 NAI V5 태그에 있는지 */
  known: boolean
}

export interface TagHelperResult {
  ok: boolean
  /** 쉼표로 이은 무헤더 한 줄 */
  tags: string
  items: TagHelperItem[]
  message: string
}

/** 텍스트 최대 길이, 그림 최대 크기(base64 길이) */
export const TAG_HELPER_TEXT_MAX = 4000
export const TAG_HELPER_IMAGE_MAX = 12_000_000
