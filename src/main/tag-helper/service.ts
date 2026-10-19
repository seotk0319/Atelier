// AI 태그 도우미 본체 (워커 D가 채운다). 지금은 IPC 약속만 맞춘 자리표시.
import type {
  TagHelperImageRequest,
  TagHelperResult,
  TagHelperTextRequest
} from '../../shared/tag-helper'

const notReady = (): TagHelperResult => ({
  ok: false,
  tags: '',
  items: [],
  message: '아직 준비 중이에요.'
})

export async function tagFromText(_req: TagHelperTextRequest): Promise<TagHelperResult> {
  return notReady()
}

export async function tagFromImage(_req: TagHelperImageRequest): Promise<TagHelperResult> {
  return notReady()
}
