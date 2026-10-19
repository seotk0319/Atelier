import { describe, expect, it } from 'vitest'
import { deepseekTranslate, parseDeepSeekReply } from '../src/main/translate/deepseek'
import { DEEPSEEK_MODEL } from '../src/shared/llm'

interface SentBody {
  model?: string
  temperature?: number
  messages?: { role: string; content: string }[]
}

const jsonReply = (content: string): typeof fetch =>
  (async () =>
    new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })) as unknown as typeof fetch

const fence = (inner: string): string =>
  String.fromCharCode(96, 96, 96) + inner + String.fromCharCode(96, 96, 96)

describe('DeepSeek translator', () => {
  it('asks for translation with the DeepSeek model and parses the JSON answer', async () => {
    let sent: SentBody | null = null
    const fetcher = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body)) as SentBody
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '{"detected":"JA","text":"안녕"}' } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    }) as unknown as typeof fetch

    const result = await deepseekTranslate('k', { text: 'こんにちは', target: 'ZH-HANT' }, fetcher)

    expect(result).toEqual({ text: '안녕', detected: 'JA' })
    expect(sent).not.toBeNull()
    expect(sent?.model).toBe(DEEPSEEK_MODEL)
    expect(sent?.temperature).toBe(0.2)
    expect(sent?.messages?.[1]).toEqual({ role: 'user', content: 'こんにちは' })
    expect(sent?.messages?.[0]?.content).toContain('Traditional Chinese')
  })

  it('strips code fences and falls back to the whole reply when the answer is not JSON', () => {
    expect(parseDeepSeekReply(fence('json\n{"detected":"EN-US","text":"Hello"}\n'))).toEqual({
      text: 'Hello',
      detected: 'EN'
    })
    expect(parseDeepSeekReply(fence('\nHello there\n'))).toEqual({
      text: 'Hello there',
      detected: null
    })
    expect(parseDeepSeekReply('안녕하세요')).toEqual({ text: '안녕하세요', detected: null })
  })

  it('accepts a plain non-JSON reply end to end', async () => {
    const result = await deepseekTranslate(
      'k',
      { text: 'Hello', target: 'JA' },
      jsonReply('こんにちは')
    )
    expect(result).toEqual({ text: 'こんにちは', detected: null })
  })
})
