import { describe, expect, it } from 'vitest'
import { deepseekDraft, parseDraftJson } from '../src/main/ai-reply/deepseek'
import { draftRequest, readDraft } from '../src/main/ai-reply/prompt'

const body = draftRequest([{ comment: '재밌어요', reply: '감사해요~!' }], {
  platform: '에덴',
  work: '과외생 길들이기',
  author: 'User1',
  comment: '目前體驗下來非常不錯'
})

describe('DeepSeek AI reply', () => {
  it('sends the same system prompt with a JSON rule and reads the drafts like Claude', async () => {
    let seen: { system: string; user: string } | null = null
    const response = await deepseekDraft('k', body, async (_key, options) => {
      seen = {
        system: String(options.messages[0].content),
        user: String(options.messages[1].content)
      }
      return {
        text: '\x60\x60\x60json\n{"language":"zh-Hant","handoff":false,"reason":"","replies":["謝謝喜歡～","感謝支持！"]}\n\x60\x60\x60',
        usage: { input: 900, output: 60 }
      }
    })
    expect(seen?.system).toContain('크리에이터의 지난 답글')
    expect(seen?.system).toContain('JSON')
    expect(seen?.user).toContain('目前體驗下來非常不錯')
    expect(seen?.user).not.toContain('reply_drafts 도구')
    expect(response.usage).toEqual({ input_tokens: 900, output_tokens: 60 })
    expect(readDraft(response)).toEqual({
      replies: ['謝謝喜歡～', '感謝支持！'],
      handoff: false,
      reason: null
    })
  })

  it('treats an unreadable answer as a refusal', async () => {
    const response = await deepseekDraft('k', body, async () => ({
      text: '답글을 쓸 수 없어요',
      usage: { input: 1, output: 1 }
    }))
    expect(() => readDraft(response)).toThrow()
  })

  it('finds the JSON object inside extra text', () => {
    expect(parseDraftJson('여기요: {"replies":["a"]} 끝')).toEqual({ replies: ['a'] })
    expect(parseDraftJson('nope')).toBeNull()
  })
})

