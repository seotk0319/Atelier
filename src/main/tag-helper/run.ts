// 태그 도우미 실행부. 키·태그DB를 주입받아 Electron 없이 시험할 수 있게 한다.
import type {
  TagHelperImageRequest,
  TagHelperItem,
  TagHelperPart,
  TagHelperResult,
  TagHelperTextRequest
} from '../../shared/tag-helper'
import { TAG_HELPER_IMAGE_MAX, TAG_HELPER_TEXT_MAX } from '../../shared/tag-helper'
import { DEEPSEEK_MODEL } from '../../shared/llm'
import {
  OPENROUTER_MESSAGES,
  openRouterMessage,
  openrouterChat,
  type ChatOptions
} from '../llm/openrouter'
import { buildTagMessages, normalizeParts } from './prompt'
import { fixAnchors, joinTags, parseTags, toItems } from './parse'

export type TagFetcher = typeof fetch

export interface TagHelperDeps {
  /** OpenRouter API 키. 없으면 null이나 빈 문자열 */
  getKey: () => string | null
  /** 태그DB 검증 (로컬 단부루 DB + NAI V5) */
  isKnown: (tag: string) => boolean
  /** 시험용 대체 호출 */
  chat?: (key: string, options: ChatOptions, fetcher?: TagFetcher) => Promise<string>
  fetcher?: TagFetcher
  model?: string
}

const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp'])

const fail = (message: string): TagHelperResult => ({ ok: false, tags: '', items: [], message })

type Validated =
  | { error: string }
  | { text: string; imageDataUrl?: undefined; parts?: undefined }
  | { imageDataUrl: string; parts: TagHelperPart[]; text?: undefined }

function validate(req: TagHelperTextRequest | TagHelperImageRequest): Validated {
  if ('imageBase64' in req) {
    const parts = normalizeParts(req.parts)
    if (!parts.length) return { error: '뽑을 것을 하나 이상 골라주세요.' }
    const mime = String(req.mime || '')
      .trim()
      .toLowerCase()
    if (!IMAGE_MIMES.has(mime)) {
      return { error: '지원하지 않는 그림 형식이에요. PNG, JPG, WEBP만 넣을 수 있어요.' }
    }
    const base64 = String(req.imageBase64 || '').trim()
    if (!base64) return { error: '그림이 비어 있어요. 다시 올려주세요.' }
    if (base64.length > TAG_HELPER_IMAGE_MAX) {
      return { error: '그림이 너무 커요. 조금 줄여서 다시 올려주세요.' }
    }
    return { imageDataUrl: 'data:' + mime + ';base64,' + base64, parts }
  }
  const text = String(req.text ?? '').trim()
  if (!text) return { error: '설명이 비어 있어요. 태그로 바꿀 한글 설명을 적어주세요.' }
  if (text.length > TAG_HELPER_TEXT_MAX) {
    return { error: '설명이 너무 길어요. ' + TAG_HELPER_TEXT_MAX + '자까지 넣을 수 있어요.' }
  }
  return { text }
}

export async function runTagHelper(
  req: TagHelperTextRequest | TagHelperImageRequest,
  deps: TagHelperDeps
): Promise<TagHelperResult> {
  try {
    if (!req || typeof req !== 'object') return fail('요청을 읽지 못했어요. 다시 시도해주세요.')
    const input = validate(req)
    if ('error' in input) return fail(input.error)

    let key = ''
    try {
      key = (deps.getKey() ?? '').trim()
    } catch {
      key = ''
    }
    if (!key) return fail(OPENROUTER_MESSAGES.NO_KEY)

    const messages = buildTagMessages({
      text: input.text,
      imageDataUrl: input.imageDataUrl,
      parts: input.parts,
      note: req.note
    })
    const chat = deps.chat ?? openrouterChat
    const raw = await chat(
      key,
      {
        model: deps.model || DEEPSEEK_MODEL,
        messages,
        temperature: 0.2,
        maxTokens: 900,
        timeoutMs: 90_000
      },
      deps.fetcher
    )

    const tags = fixAnchors(parseTags(raw), input.parts ? input.parts.includes('look') : null)
    if (!tags.length) {
      return fail('태그를 찾지 못했어요. 설명을 조금 더 구체적으로 적어주세요.')
    }
    const items: TagHelperItem[] = toItems(tags, deps.isKnown)
    return {
      ok: true,
      tags: joinTags(tags),
      items,
      message: '태그 ' + tags.length + '개를 만들었어요.'
    }
  } catch (error) {
    return fail(openRouterMessage(error))
  }
}
