import { describe, expect, it, vi } from 'vitest'

vi.mock('../src/main/refs/repo', () => ({
  enabledCharRefRows: () => [
    {
      name: '루나 정면',
      filePath: 'C:/nowhere/deleted.png',
      refType: 'character',
      strength: 1,
      fidelity: 1
    }
  ],
  enabledVibeRows: () => [
    {
      id: 1,
      name: '수채화',
      filePath: 'C:/nowhere/vibe.png',
      strength: 0.6,
      infoExtracted: 1,
      encoded: null,
      encodedIe: null
    }
  ],
  saveVibeEncoding: () => undefined
}))

describe('reference whose image file was deleted', () => {
  it('names the reference instead of a raw ENOENT', async () => {
    const { prepareCharRefs, prepareVibes } = await import('../src/main/refs/prepare')
    await expect(prepareCharRefs()).rejects.toThrow('「루나 정면」')
    await expect(prepareCharRefs()).rejects.not.toThrow('ENOENT')
    await expect(prepareVibes('token')).rejects.toThrow('「수채화」')
  })
})
