import { describe, expect, it } from 'vitest'
import { fixAnchors, joinTags, parseTags, stripWeight, toItems } from '../src/main/tag-helper/parse'
import {
  buildTagMessages,
  normalizeParts,
  tagHelperSystemPrompt
} from '../src/main/tag-helper/prompt'
import { runTagHelper, type TagHelperDeps } from '../src/main/tag-helper/run'
import { OPENROUTER_MESSAGES, OpenRouterError, type ChatOptions } from '../src/main/llm/openrouter'
import { DEEPSEEK_MODEL } from '../src/shared/llm'
import { TAG_HELPER_IMAGE_MAX, TAG_HELPER_TEXT_MAX } from '../src/shared/tag-helper'

const KNOWN = new Set(['long hair', 'smile', 'black hair', 'highly detailed'])

const deps = (over: Partial<TagHelperDeps> = {}): TagHelperDeps => ({
  getKey: () => 'test-key',
  isKnown: (tag) => KNOWN.has(tag),
  ...over
})

describe('tag parsing', () => {
  it('cleans fences, labels, numbering, underscores and quotes', () => {
    const raw =
      '그림 태그:\n' +
      '\x60\x60\x60' +
      'text\n' +
      'tags: Long_Hair, Smile\n1. black_hair\n2. "highly detailed"\n' +
      '\x60\x60\x60'
    expect(parseTags(raw)).toEqual(['long hair', 'smile', 'black hair', 'highly detailed'])
  })

  it('drops duplicates, hangul and overly long pieces', () => {
    const long = 'a'.repeat(61)
    const tags = parseTags('long hair, LONG_HAIR, 이건 한글이에요, ' + long + ', , smile')
    expect(tags).toEqual(['long hair', 'smile'])
  })

  it('keeps weight syntax and reads through it for known checks', () => {
    const tags = parseTags('1.2::Long_Hair ::, 0.8::smile::')
    expect(tags).toEqual(['1.2::long hair ::', '0.8::smile::'])
    expect(stripWeight('1.2::long hair ::')).toBe('long hair')
    expect(toItems(tags, (tag) => KNOWN.has(tag))).toEqual([
      { tag: '1.2::long hair ::', known: true },
      { tag: '0.8::smile::', known: true }
    ])
    expect(joinTags(['a', 'b'])).toBe('a, b')
  })

  it('returns nothing for empty answers', () => {
    expect(parseTags('')).toEqual([])
    expect(parseTags('   \n  ')).toEqual([])
  })
})

describe('prompt building', () => {
  it('keeps the 31-slot order and adult anchors in every prompt', () => {
    for (const system of [
      tagHelperSystemPrompt({ image: false }),
      tagHelperSystemPrompt({ image: true, parts: ['look'] })
    ]) {
      expect(system).toContain('31 highly detailed')
      expect(system).toContain('10 hair')
      expect(system).toContain('adult woman')
      expect(system).toContain('Never output child')
      expect(system).toContain('lowercase')
    }
  })

  it('text requests convert only what is written', () => {
    const system = tagHelperSystemPrompt({ image: false })
    expect(system).toContain('convert ONLY what the Korean description states')
    expect(system).toContain('Do not fill slots the description does not mention')
    expect(system).not.toContain('output tags ONLY for these parts')
  })

  it('image requests list chosen parts and forbid the rest', () => {
    const system = tagHelperSystemPrompt({ image: true, parts: ['scene', 'outfit'] })
    const task = system.slice(system.indexOf('Task:'), system.indexOf('Tag order'))
    const allowed = task.slice(0, task.indexOf('Do NOT'))
    const banned = task.slice(task.indexOf('Do NOT'))
    expect(allowed).toContain('outfit: slots 14-30')
    expect(allowed).toContain('composition and background')
    expect(allowed.indexOf('outfit:')).toBeLessThan(allowed.indexOf('composition'))
    expect(banned).toContain('appearance:')
    expect(banned).toContain('pose and expression:')
  })

  it('normalizes parts to a known, ordered list', () => {
    expect(normalizeParts(['scene', 'look', 'nope', 'look'])).toEqual(['look', 'scene'])
    expect(normalizeParts(undefined)).toEqual([])
  })

  it('builds a text message with the description and the extra note', () => {
    const messages = buildTagMessages({
      text: '검은 긴 머리 여성',
      note: '마스크는 빼고'
    })
    expect(messages[0].role).toBe('system')
    const user = messages[1]
    expect(typeof user.content).toBe('string')
    expect(String(user.content)).toContain('검은 긴 머리 여성')
    expect(String(user.content)).toContain('마스크는 빼고')
  })

  it('builds an image message with a data url part', () => {
    const messages = buildTagMessages({
      parts: ['pose'],
      imageDataUrl: 'data:image/png;base64,AAAA'
    })
    const parts = messages[1].content
    expect(Array.isArray(parts)).toBe(true)
    if (!Array.isArray(parts)) return
    expect(parts[0]).toMatchObject({ type: 'text' })
    expect(parts[1]).toEqual({
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,AAAA' }
    })
  })
})

describe('tag helper runner', () => {
  it('needs a key before anything else', async () => {
    const result = await runTagHelper({ text: '앉아 있는 여성' }, deps({ getKey: () => null }))
    expect(result).toEqual({ ok: false, tags: '', items: [], message: OPENROUTER_MESSAGES.NO_KEY })
  })

  it('rejects empty and overly long descriptions', async () => {
    expect((await runTagHelper({ text: '  ' }, deps())).ok).toBe(false)
    const long = '가'.repeat(TAG_HELPER_TEXT_MAX + 1)
    const result = await runTagHelper({ text: long }, deps())
    expect(result.ok).toBe(false)
    expect(result.message).toContain(String(TAG_HELPER_TEXT_MAX))
  })

  it('rejects unsupported mime types and oversized images', async () => {
    const gif = await runTagHelper(
      { parts: ['look'], imageBase64: 'AAAA', mime: 'image/gif' },
      deps()
    )
    expect(gif.ok).toBe(false)
    expect(gif.message).toContain('PNG')
    const huge = await runTagHelper(
      { parts: ['look'], imageBase64: 'A'.repeat(TAG_HELPER_IMAGE_MAX + 1), mime: 'image/png' },
      deps()
    )
    expect(huge.ok).toBe(false)
    expect(huge.message).toContain('너무 커요')
  })

  it('turns the model answer into one line with known flags', async () => {
    let seen: ChatOptions | null = null
    let seenKey = ''
    const chat = async (key: string, options: ChatOptions): Promise<string> => {
      seenKey = key
      seen = options
      return '\x60\x60\x60' + '\ntags: Long_Hair, smile, mysterious_hat\n' + '\x60\x60\x60'
    }
    const result = await runTagHelper({ text: '긴 머리 여성' }, deps({ chat }))
    expect(seenKey).toBe('test-key')
    expect(seen?.model).toBe(DEEPSEEK_MODEL)
    expect(seen?.temperature).toBe(0.2)
    expect(seen?.maxTokens).toBe(900)
    expect(result.ok).toBe(true)
    expect(result.tags).toBe('long hair, smile, mysterious hat')
    expect(result.items).toEqual([
      { tag: 'long hair', known: true },
      { tag: 'smile', known: true },
      { tag: 'mysterious hat', known: false }
    ])
    expect(result.message).toContain('3')
  })

  it('turns API failures into Korean messages instead of throwing', async () => {
    const chat = async (): Promise<string> => {
      throw new OpenRouterError('AUTH', 401)
    }
    const result = await runTagHelper({ text: '검은 교복' }, deps({ chat }))
    expect(result.ok).toBe(false)
    expect(result.message).toBe(OPENROUTER_MESSAGES.AUTH)

    const broken = async (): Promise<string> => {
      throw new Error('boom')
    }
    const unknown = await runTagHelper({ text: '검은 교복' }, deps({ chat: broken }))
    expect(unknown.ok).toBe(false)
    expect(unknown.message).toBe(OPENROUTER_MESSAGES.UNKNOWN)
  })

  it('reports when the model returns no usable tags', async () => {
    const chat = async (): Promise<string> => '죄송해요, 태그를 만들 수 없어요.'
    const result = await runTagHelper({ text: '밤 거리' }, deps({ chat }))
    expect(result.ok).toBe(false)
    expect(result.message).toContain('태그를 찾지 못했어요')
  })
})

describe('image parts validation', () => {
  it('asks for at least one part', async () => {
    const result = await runTagHelper({ parts: [], imageBase64: 'AAAA', mime: 'image/png' }, deps())
    expect(result.ok).toBe(false)
    expect(result.message).toContain('하나 이상')
  })
})

describe('anchor cleanup', () => {
  it('drops girl/adult woman when no appearance tag is present', () => {
    expect(
      fixAnchors(['girl', 'grey dress', 'shrug (clothing)', 'hair ribbon', 'highly detailed'], null)
    ).toEqual(['grey dress', 'shrug (clothing)', 'hair ribbon', 'highly detailed'])
    expect(fixAnchors(['girl', 'adult woman', 'sitting', 'light smile'], null)).toEqual([
      'sitting',
      'light smile'
    ])
  })

  it('adds the adult anchor before the body tags when hair or body is described', () => {
    expect(
      fixAnchors(
        ['girl', 'black hair', 'hair bun', 'wide hips', 'grey dress', 'highly detailed'],
        null
      )
    ).toEqual([
      'girl',
      'black hair',
      'hair bun',
      'adult woman',
      'wide hips',
      'grey dress',
      'highly detailed'
    ])
    expect(fixAnchors(['girl', 'black hair', 'long dress'], null)).toEqual([
      'girl',
      'black hair',
      'adult woman',
      'long dress'
    ])
  })

  it('follows the chosen image parts', () => {
    expect(fixAnchors(['girl', 'adult woman', 'white hair', 'grey shirt'], false)).toEqual([
      'white hair',
      'grey shirt'
    ])
    expect(fixAnchors(['girl', 'white hair', 'medium breasts'], true)).toEqual([
      'girl',
      'white hair',
      'adult woman',
      'medium breasts'
    ])
  })
})
