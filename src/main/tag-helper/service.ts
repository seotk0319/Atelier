// AI 태그 도우미 본체. 한글 설명이나 그림을 NAI(단부루) 태그 한 줄로 바꾼다.
import type {
  TagHelperImageRequest,
  TagHelperResult,
  TagHelperTextRequest
} from '../../shared/tag-helper'
import { getOpenRouterKey } from '../db/settings'
import { isKnownTag } from '../tags'
import { runTagHelper, type TagHelperDeps } from './run'

const deps: TagHelperDeps = {
  getKey: () => getOpenRouterKey(),
  isKnown: isKnownTag
}

/** 한글 설명 -> 태그 한 줄 */
export async function tagFromText(req: TagHelperTextRequest): Promise<TagHelperResult> {
  return runTagHelper(req, deps)
}

/** 그림 -> 태그 한 줄 */
export async function tagFromImage(req: TagHelperImageRequest): Promise<TagHelperResult> {
  return runTagHelper(req, deps)
}
