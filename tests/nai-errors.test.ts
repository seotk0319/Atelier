import { describe, expect, it } from 'vitest'
import { friendlyNaiStatus, NaiNetworkError, networkError } from '../src/main/nai/errors'
import { GenerationQueue } from '../src/main/queue/generation-queue'
import type { GenerationRequest } from '../src/shared/types'

describe('NAI error text', () => {
  it('turns a 402 into plain Korean without the raw JSON body', () => {
    const msg = friendlyNaiStatus('생성', 402, '{"statusCode":402,"message":"Training steps..."}')
    expect(msg).toContain('Anlas가 부족하거나 NovelAI 구독이 없어요')
    expect(msg).not.toContain('statusCode')
    expect(friendlyNaiStatus('생성', 401, '')).toContain('토큰')
    expect(friendlyNaiStatus('생성', 503, '<html>')).not.toContain('html')
    expect(friendlyNaiStatus('생성', 400, 'bad width')).toContain('bad width')
  })

  it('turns "fetch failed" into an internet message and marks not-sent errors as retryable', () => {
    const offline = Object.assign(new TypeError('fetch failed'), {
      cause: { code: 'ENOTFOUND' }
    })
    const e = networkError('생성', offline) as NaiNetworkError
    expect(e).toBeInstanceOf(NaiNetworkError)
    expect(e.message).toContain('인터넷 연결')
    expect(e.message).not.toContain('fetch failed')
    expect(e.retryable).toBe(true)
    const reset = networkError(
      '생성',
      Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } })
    ) as NaiNetworkError
    expect(reset.retryable).toBe(false)
    const abort = new DOMException('Aborted', 'AbortError')
    expect(networkError('생성', abort)).toBe(abort)
  })

  it('the queue sends a not-sent network failure again', async () => {
    let calls = 0
    const queue = new GenerationQueue(async () => {
      calls++
      if (calls === 1) throw new NaiNetworkError('offline', 'ENOTFOUND', true)
      return 'C:/out.png'
    })
    queue.setDelayMs(0)
    queue.enqueue({ seed: 1 } as GenerationRequest, 1)
    await new Promise((r) => setTimeout(r, 3500))
    expect(calls).toBe(2)
    expect(queue.status().counts.done).toBe(1)
  }, 10000)
})
