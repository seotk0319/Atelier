import { describe, expect, it } from 'vitest'
import {
  autoCandidates,
  countToday,
  readAiConfig,
  runAuto,
  AUTO_GAP_MS,
  type AutoDeps,
  type AutoItem
} from '../src/main/ai-reply/auto'
import { claudeMessage, claudeVerify, codeForStatus } from '../src/main/ai-reply/claude'
import { addUsage, draftRequest, pickExamples, readDraft } from '../src/main/ai-reply/prompt'
import { readReplied } from '../src/main/notifications/replied'
import { AI_MODEL, usageCost, type AiLogEntry, type AiReplyConfig } from '../src/shared/ai-reply'
import type { InboxReplied } from '../src/shared/inbox'

const replied = (at: string, content: string, via: InboxReplied['via'] = 'site'): InboxReplied => ({
  at,
  content,
  via
})

describe('style examples from past replies', () => {
  it('pairs replies with their comments, newest first, without AI replies or repeats', () => {
    const comments = new Map([
      ['a', '주희 너무 귀여워요ㅠ'],
      ['b', '재밌어요'],
      ['c', '최고'],
      ['d', 'AI가 답한 댓글'],
      ['e', '   ']
    ])
    const record = {
      a: replied('2026-10-01T10:00:00Z', '감사해요~ 주희도 좋아할 거예요!'),
      b: replied('2026-10-03T10:00:00Z', '즐겨주셔서 감사합니다~'),
      c: replied('2026-10-02T10:00:00Z', '즐겨주셔서  감사합니다~'),
      d: replied('2026-10-04T10:00:00Z', '고마워요', 'ai'),
      e: replied('2026-10-05T10:00:00Z', '빈 댓글 답'),
      gone: replied('2026-10-06T10:00:00Z', '알림이 없는 답글')
    }
    const { examples, total } = pickExamples(comments, record)
    expect(examples).toEqual([
      { comment: '재밌어요', reply: '즐겨주셔서 감사합니다~' },
      { comment: '주희 너무 귀여워요ㅠ', reply: '감사해요~ 주희도 좋아할 거예요!' }
    ])
    expect(total).toBe(2)
    expect(pickExamples(comments, record, 1).examples).toHaveLength(1)
  })
})

describe('draft request and reply parsing', () => {
  const examples = [{ comment: '재밌어요', reply: '즐겨주셔서 감사합니다~' }]
  it('caches the style prompt and forces the reply tool', () => {
    const body = draftRequest(examples, {
      platform: '에덴',
      work: '주희',
      author: 'fan',
      comment: 'I love her!'
    }) as {
      model: string
      system: { text: string; cache_control: unknown }[]
      tool_choice: unknown
      tools: { name: string }[]
      messages: { role: string; content: string }[]
    }
    expect(body.model).toBe(AI_MODEL)
    expect(body.system[0].cache_control).toEqual({ type: 'ephemeral' })
    expect(body.system[0].text).toContain('1. 댓글: 재밌어요\n   답글: 즐겨주셔서 감사합니다~')
    expect(body.system[0].text).toContain('댓글과 같은 언어로 쓴다')
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'reply_drafts' })
    expect(body.tools[0].name).toBe('reply_drafts')
    expect(body.messages[0].content).toContain('작품: 주희')
    expect(body.messages[0].content).toContain('I love her!')
  })

  it('reads up to three distinct replies and explains hand-offs', () => {
    const tool = (input: unknown): Parameters<typeof readDraft>[0] => ({
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', name: 'reply_drafts', input }]
    })
    expect(
      readDraft(
        tool({
          language: 'en',
          handoff: false,
          replies: [' Thanks! ', 'Thanks!', 'Yay', 'More', 'Extra']
        })
      )
    ).toEqual({ replies: ['Thanks!', 'Yay', 'More'], handoff: false, reason: null })
    expect(readDraft(tool({ language: 'ko', handoff: true, replies: ['감사해요'] }))).toEqual({
      replies: ['감사해요'],
      handoff: true,
      reason: '직접 확인이 필요한 댓글이에요.'
    })
    expect(() => readDraft({ stop_reason: 'refusal', content: [] })).toThrow(
      expect.objectContaining({ code: 'REFUSED' })
    )
    expect(() => readDraft(tool({ handoff: false, replies: ['  '] }))).toThrow(
      expect.objectContaining({ code: 'REFUSED' })
    )
  })

  it('adds usage within a month and starts over in the next one', () => {
    const response = {
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 2000,
        cache_creation_input_tokens: 0
      }
    }
    const october = addUsage(
      addUsage(null, response, new Date(2026, 9, 8)),
      response,
      new Date(2026, 9, 9)
    )
    expect(october).toEqual({
      month: '2026-10',
      requests: 2,
      input: 200,
      output: 100,
      cacheRead: 4000,
      cacheWrite: 0
    })
    expect(addUsage(october, response, new Date(2026, 10, 1)).requests).toBe(1)
    expect(
      usageCost({ input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 0 })
    ).toBeCloseTo(0.61)
  })
})

describe('Claude client', () => {
  it('sends the key and version headers and maps failures', async () => {
    let seen: { url: string; headers: Record<string, string> } | null = null
    const ok = (async (url: string, init: RequestInit) => {
      seen = { url, headers: init.headers as Record<string, string> }
      return new Response(JSON.stringify({ data: [] }))
    }) as unknown as typeof fetch
    await claudeVerify(' sk-ant-test ', ok)
    expect(seen).toEqual({
      url: 'https://api.anthropic.com/v1/models?limit=1',
      headers: { 'x-api-key': 'sk-ant-test', 'anthropic-version': '2023-06-01' }
    })
    expect([401, 403, 402, 429, 529, 500, 400].map((s) => codeForStatus(s))).toEqual([
      'AUTH',
      'AUTH',
      'CREDIT',
      'RATE',
      'OVERLOADED',
      'SERVER',
      'BAD_REQUEST'
    ])
    const lowCredit = (async () =>
      new Response(
        JSON.stringify({
          error: { message: 'Your credit balance is too low to access the Anthropic API.' }
        }),
        { status: 400 }
      )) as unknown as typeof fetch
    await expect(claudeMessage('k', {}, lowCredit)).rejects.toMatchObject({
      code: 'CREDIT',
      status: 400
    })
    const offline = (async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch
    await expect(claudeVerify('k', offline)).rejects.toMatchObject({ code: 'NETWORK' })
    await expect(claudeVerify('  ', ok)).rejects.toMatchObject({ code: 'NO_KEY' })
  })
})

const config = (patch: Partial<AiReplyConfig> = {}): AiReplyConfig => ({
  mode: 'send',
  excluded: [],
  dailyLimit: 50,
  since: '2026-10-08T00:00:00Z',
  ...patch
})
const item = (id: string, patch: Partial<AutoItem> = {}): AutoItem => ({
  id,
  platform: 'eden',
  event: 'comment',
  at: '2026-10-08T01:00:00Z',
  author: 'fan',
  comment: '재밌어요',
  canReply: true,
  ...patch
})

describe('auto reply selection', () => {
  it('takes only new, answerable comments that have no reply or record yet', () => {
    const items = [
      item('late', { at: '2026-10-08T03:00:00Z' }),
      item('early', { at: '2026-10-08T02:00:00Z' }),
      item('before', { at: '2026-10-07T23:59:00Z' }),
      item('reply', { event: 'reply' }),
      item('like', { event: 'like' }),
      item('cannot', { canReply: false }),
      item('off', { platform: 'babe' }),
      item('done'),
      item('logged'),
      item('notime', { at: null })
    ]
    const log = { logged: { id: 'logged' } as AiLogEntry }
    const picked = autoCandidates(items, config({ excluded: ['babe'] }), { done: true }, log)
    expect(picked.map((x) => x.id)).toEqual(['early', 'late'])
    expect(autoCandidates(items, config({ mode: 'off' }), {}, {})).toEqual([])
    expect(autoCandidates(items, config({ since: null }), {}, {})).toEqual([])
    expect(
      autoCandidates(items, config({ excluded: ['babe'] }), { done: true }, log, 1).map((x) => x.id)
    ).toEqual(['early'])
  })

  it('reads stored settings defensively', () => {
    expect(readAiConfig(null)).toEqual({ mode: 'off', excluded: [], dailyLimit: 50, since: null })
    expect(
      readAiConfig(
        JSON.stringify({
          mode: 'send',
          excluded: ['eden', 'nope'],
          dailyLimit: 100,
          since: '2026-10-08T00:00:00Z'
        })
      )
    ).toEqual({ mode: 'send', excluded: ['eden'], dailyLimit: 100, since: '2026-10-08T00:00:00Z' })
    expect(readAiConfig(JSON.stringify({ mode: 'yolo', dailyLimit: 9999 }))).toMatchObject({
      mode: 'off',
      dailyLimit: 50
    })
    expect(readAiConfig('{broken')).toMatchObject({ mode: 'off' })
  })

  it('counts today by local date', () => {
    const at = (d: Date): string => d.toISOString()
    const now = new Date(2026, 9, 8, 15)
    const log = {
      a: { id: 'a', at: at(new Date(2026, 9, 8, 9)), state: 'sent' } as AiLogEntry,
      b: { id: 'b', at: at(new Date(2026, 9, 8, 10)), state: 'skipped' } as AiLogEntry,
      c: { id: 'c', at: at(new Date(2026, 9, 7, 23)), state: 'sent' } as AiLogEntry
    }
    expect(countToday(log, now)).toEqual({ sent: 1, drafted: 0, skipped: 1, failed: 0 })
  })
})

function deps(patch: Partial<AutoDeps> = {}): AutoDeps & {
  records: AiLogEntry[]
  sends: [string, string][]
  waits: number[]
} {
  const records: AiLogEntry[] = []
  const sends: [string, string][] = []
  const waits: number[] = []
  return {
    records,
    sends,
    waits,
    config: config(),
    candidates: [item('a'), item('b')],
    sentToday: 0,
    draft: async (id) => ({
      ok: true,
      message: '',
      replies: [id + ' 감사해요~', id + ' 고마워요'],
      handoff: false,
      reason: null
    }),
    send: async (id, content) => {
      sends.push([id, content])
      return { ok: true, message: '' }
    },
    record: (entry) => {
      records.push(entry)
    },
    wait: async (ms) => {
      waits.push(ms)
    },
    now: () => new Date('2026-10-08T05:00:00Z'),
    ...patch
  }
}

describe('auto reply run', () => {
  it('sends the first candidate with a gap between replies and records each one', async () => {
    const d = deps()
    expect(await runAuto(d)).toEqual({ handled: 2, sent: 2, stopped: null })
    expect(d.sends).toEqual([
      ['a', 'a 감사해요~'],
      ['b', 'b 감사해요~']
    ])
    expect(d.waits).toEqual([AUTO_GAP_MS])
    expect(d.records.map((r) => [r.id, r.state, r.content])).toEqual([
      ['a', 'sent', 'a 감사해요~'],
      ['b', 'sent', 'b 감사해요~']
    ])
  })

  it('only drafts in draft mode and hands questions to the creator', async () => {
    const d = deps({
      config: config({ mode: 'draft' }),
      draft: async (id) =>
        id === 'b'
          ? {
              ok: true,
              message: '',
              replies: ['감사해요'],
              handoff: true,
              reason: '업데이트 일정 문의예요.'
            }
          : { ok: true, message: '', replies: ['고마워요'], handoff: false, reason: null }
    })
    await runAuto(d)
    expect(d.sends).toEqual([])
    expect(d.records.map((r) => [r.id, r.state, r.reason])).toEqual([
      ['a', 'drafted', null],
      ['b', 'skipped', '업데이트 일정 문의예요.']
    ])
  })

  it('stops at the daily limit, on key or credit problems, and when turned off', async () => {
    const limited = deps({ config: config({ dailyLimit: 20 }), sentToday: 19 })
    expect((await runAuto(limited)).sent).toBe(1)
    expect(limited.sends.map((s) => s[0])).toEqual(['a'])

    const broke = deps({
      draft: async () => ({
        ok: false,
        message: '크레딧이 모자라요',
        replies: [],
        handoff: false,
        reason: null,
        code: 'CREDIT'
      })
    })
    expect(await runAuto(broke)).toEqual({ handled: 0, sent: 0, stopped: '크레딧이 모자라요' })
    expect(broke.records).toEqual([])

    const paused = deps({ active: () => false })
    expect((await runAuto(paused)).handled).toBe(0)
  })

  it('skips a signed-out platform without recording and records other failures', async () => {
    const d = deps({
      candidates: [
        item('a'),
        item('b'),
        item('c', { platform: 'babe' }),
        item('d', { platform: 'neko' })
      ],
      draft: async (id) =>
        id === 'a'
          ? {
              ok: false,
              message: '로그인이 풀렸어요',
              replies: [],
              handoff: false,
              reason: null,
              code: 'LOGIN_REQUIRED'
            }
          : id === 'd'
            ? {
                ok: false,
                message: 'AI가 답글을 쓰지 않았어요',
                replies: [],
                handoff: false,
                reason: null,
                code: 'REFUSED'
              }
            : { ok: true, message: '', replies: ['감사해요'], handoff: false, reason: null },
      send: async (id) =>
        id === 'c'
          ? { ok: false, message: '원래 댓글을 찾지 못했어요', code: 'COMMENT_NOT_FOUND' }
          : { ok: true, message: '' }
    })
    await runAuto(d)
    expect(d.records.map((r) => [r.id, r.state, r.reason])).toEqual([
      ['c', 'failed', '원래 댓글을 찾지 못했어요'],
      ['d', 'failed', 'AI가 답글을 쓰지 않았어요']
    ])
  })
})

describe('reply record', () => {
  it('keeps replies sent by the AI marked as such', () => {
    const record = readReplied({
      items: {
        x: { at: '2026-10-08T00:00:00Z', content: '감사해요', via: 'ai' },
        y: { at: '2026-10-08T00:00:00Z', content: 'a', via: 'odd' }
      }
    })
    expect(record.items.x.via).toBe('ai')
    expect(record.items.y.via).toBe('app')
  })
})
