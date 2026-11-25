import { describe, expect, it, vi } from 'vitest'

const store = new Map<string, string>()
let canDecrypt = true

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from('enc:' + s),
    decryptString: (b: Buffer) => {
      const s = b.toString()
      if (!canDecrypt || !s.startsWith('enc:')) throw new Error('decrypt failed')
      return s.slice(4)
    }
  }
}))
vi.mock('../src/main/db/index', () => ({
  getDb: () => ({
    prepare: (sql: string) => ({
      get: (key: string) => (store.has(key) ? { value: store.get(key) } : undefined),
      run: (...args: string[]) => {
        if (sql.startsWith('DELETE')) for (const k of args) store.delete(k)
        else store.set(args[0], args[1])
      }
    })
  })
}))

describe('NAI accounts that this PC cannot decrypt', () => {
  it('keeps the unreadable bundle aside before a new token overwrites it', async () => {
    const { addNaiAccount, getNaiAccounts } = await import('../src/main/db/settings')
    addNaiAccount('pst-old')
    const original = store.get('nai_accounts_encrypted_v1')
    expect(original).toBeTruthy()

    canDecrypt = false // 다른 PC로 옮긴 DB
    expect(getNaiAccounts()).toEqual([])
    canDecrypt = true
    // 같은 상황을 흉내 내려고 저장값을 이 PC가 못 푸는 값으로 바꾼다
    store.set('nai_accounts_encrypted_v1', Buffer.from('other-pc').toString('base64'))
    const unreadable = store.get('nai_accounts_encrypted_v1')
    addNaiAccount('pst-new')
    expect(store.get('nai_accounts_encrypted_v1_unreadable')).toBe(unreadable)
    expect(getNaiAccounts().map((a) => a.token)).toEqual(['pst-new'])
  })
})
