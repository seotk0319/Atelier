import { afterEach, describe, expect, it, vi } from 'vitest'
import { verifyToken } from '../src/main/nai/client'

describe('verifyToken input checks for first-time users', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('rejects a pasted "Bearer " prefix without calling NovelAI', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const result = await verifyToken('Bearer pst-abc')
    expect(result.valid).toBe(false)
    expect(result.error).toContain('Bearer')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects whitespace or non-ASCII inside the token', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    for (const value of ['pst-ab\ncd', 'pst-ab cd', 'pst-토큰']) {
      const result = await verifyToken(value)
      expect(result.valid).toBe(false)
      expect(result.error).toContain('pst-')
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns a plain message instead of throwing when NovelAI is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')))
    const result = await verifyToken('pst-abc')
    expect(result).toEqual({
      valid: false,
      error: 'NovelAI에 연결하지 못했어요. 인터넷 연결을 확인해 주세요.'
    })
  })

  it('explains a 401 with where to get a persistent token', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 401 })))
    const result = await verifyToken('pst-abc')
    expect(result.valid).toBe(false)
    expect(result.error).toContain('pst-')
  })
})
