import { describe, expect, it } from 'vitest'
import { probeRemoteMcp } from '../src/main/mcp/remote-probe'

describe('probeRemoteMcp', () => {
  it('counts any HTTP answer as up, including 401', async () => {
    const calls: string[] = []
    const fake = (async (url: string) => {
      calls.push(url)
      return new Response('', { status: 401 })
    }) as unknown as typeof fetch
    expect(await probeRemoteMcp(39217, fake)).toBe('up')
    expect(calls).toEqual(['http://127.0.0.1:39217/mcp'])
  })

  it('is down when nothing listens', async () => {
    const fake = (async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch
    expect(await probeRemoteMcp(39217, fake)).toBe('down')
  })

  it('is down when the answer does not come in time', async () => {
    const fake = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })) as unknown as typeof fetch
    expect(await probeRemoteMcp(39217, fake, 20)).toBe('down')
  })

  it('does not call out for a port outside the allowed range', async () => {
    let called = false
    const fake = (async () => {
      called = true
      return new Response('')
    }) as unknown as typeof fetch
    expect(await probeRemoteMcp(0, fake)).toBe('down')
    expect(called).toBe(false)
  })
})
