import { describe, expect, it, vi } from 'vitest'

let requests = 0
vi.mock('../src/main/gpt/auth', () => ({
  GptAuthError: class extends Error {},
  getCredentials: async () => ({ accessToken: 't', accountId: 'a' })
}))
vi.mock('../src/main/images/storage', () => ({
  saveGeneratedImage: async () => {
    throw new Error('EPERM: operation not permitted')
  }
}))
vi.mock('../src/main/db', () => ({ getDb: () => ({}) }))
vi.mock('../src/main/gpt/client', async () => {
  const real =
    await vi.importActual<typeof import('../src/main/gpt/client')>('../src/main/gpt/client')
  return {
    ...real,
    requestImage: async () => {
      requests++
      return { png: Buffer.from('png'), revisedPrompt: 'ok', sent: {} }
    }
  }
})

describe('gpt job when saving fails', () => {
  it('fails once without asking ChatGPT for the same image again', async () => {
    const { generate, initGpt, listJobs } = await import('../src/main/gpt/service')
    initGpt(
      () => undefined,
      () => undefined
    )
    await generate(
      {
        prompt: 'cup',
        refs: [],
        size: 'auto',
        quality: 'low',
        model: 'gpt-5.6-luna',
        mode: 'direct'
      },
      1
    )
    await vi.waitFor(() => expect(listJobs()[0].state).toBe('failed'))
    expect(requests).toBe(1)
    expect(listJobs()[0].error).toContain('저장하지 못했어요')
  })
})
