// AI 태그 도우미 공용 정의. 한글 설명이나 그림을 NAI(단부루) 태그 한 줄로 바꾼다.

/**
 * character: 캐릭터 고정 31단계(외형+의상, ZK-514 순서)
 * outfit: 의상만 (14~29번 슬롯)
 * scene: 자세·행동·표정·구도·배경 (씬 프롬프트용)
 */
export type TagHelperMode = 'character' | 'outfit' | 'scene'

export interface TagHelperTextRequest {
  text: string
  mode: TagHelperMode
  /** 추가 지시 (선택) 예: "마스크는 빼고" */
  note?: string
}
export interface TagHelperImageRequest {
  /** data: 접두사 없는 base64 */
  imageBase64: string
  /** image/png, image/jpeg, image/webp */
  mime: string
  mode: TagHelperMode
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
