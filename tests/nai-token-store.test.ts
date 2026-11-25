import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// 키체인(safeStorage)은 "enc:" 접두로 흉내 낸다. canDecrypt=false면 이 실행에서 해독이 안 되는 상황
// (키체인 잠김, 다른 PC에서 옮겨 온 데이터 폴더).
const keychain = vi.hoisted(() => ({ canDecrypt: true }))
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`enc:${value}`, 'utf-8'),
    decryptString: (buf: Buffer) => {
      const text = buf.toString('utf-8')
      if (!keychain.canDecrypt || !text.startsWith('enc:')) throw new Error('cannot decrypt')
      return text.slice(4)
    }
  },
  app: { getPath: () => '' }
}))

const store = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('../src/main/db/index', () => ({ getDb: () => store.db }))

import {
  addNaiAccount,
  getNaiAccounts,
  getSetting,
  isNaiTokenStoreUnreadable
} from '../src/main/db/settings'

function freshDb(): DatabaseSync {
  const raw = new DatabaseSync(':memory:')
  raw.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  return raw
}

function wrap(raw: DatabaseSync): unknown {
  return {
    prepare: (sql: string) => {
      const statement = raw.prepare(sql)
      return {
        get: (...p: never[]) => statement.get(...p),
        run: (...p: never[]) => statement.run(...p),
        all: (...p: never[]) => statement.all(...p)
      }
    }
  }
}

let raw: DatabaseSync
beforeEach(() => {
  keychain.canDecrypt = true
  raw = freshDb()
  store.db = wrap(raw)
})

describe('NAI 토큰 저장소 (읽을 수 없는 토큰을 덮어쓰지 않는다)', () => {
  it('읽을 수 있으면 평소처럼 계정을 더한다', () => {
    expect(addNaiAccount('pst-aaa')).toEqual({ added: true })
    expect(addNaiAccount('pst-bbb')).toEqual({ added: true })
    expect(getNaiAccounts().map((a) => a.token)).toEqual(['pst-aaa', 'pst-bbb'])
    expect(isNaiTokenStoreUnreadable()).toBe(false)
  })

  it('해독이 안 되는 실행에서 계정을 더해도 옛 값은 다른 키로 남는다', () => {
    addNaiAccount('pst-aaa')
    addNaiAccount('pst-bbb')
    const before = getSetting('nai_accounts_encrypted_v1')

    keychain.canDecrypt = false
    expect(getNaiAccounts()).toEqual([])
    expect(isNaiTokenStoreUnreadable()).toBe(true)
    expect(addNaiAccount('pst-ccc')).toEqual({ added: true })

    const keys = raw.prepare('SELECT key, value FROM settings').all() as {
      key: string
      value: string
    }[]
    const kept = keys.find((r) => r.key.startsWith('nai_accounts_encrypted_v1_unreadable_'))
    expect(kept?.value).toBe(before)

    // 키체인이 돌아오면 새 계정은 읽히고, 옛 두 계정은 옮겨 둔 값에서 되살릴 수 있다
    keychain.canDecrypt = true
    expect(getNaiAccounts().map((a) => a.token)).toEqual(['pst-ccc'])
    const restored = JSON.parse(Buffer.from(kept!.value, 'base64').toString('utf-8').slice(4)) as {
      token: string
    }[]
    expect(restored.map((a) => a.token)).toEqual(['pst-aaa', 'pst-bbb'])
  })

  it('예전 단일 토큰도 읽을 수 없으면 옮겨 둔다', () => {
    raw
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?)')
      .run('nai_token_encrypted', Buffer.from('enc:pst-old').toString('base64'))
    keychain.canDecrypt = false
    expect(isNaiTokenStoreUnreadable()).toBe(true)
    addNaiAccount('pst-new')
    const keys = (raw.prepare('SELECT key FROM settings').all() as { key: string }[]).map(
      (r) => r.key
    )
    expect(keys.some((k) => k.startsWith('nai_token_encrypted_unreadable_'))).toBe(true)
  })
})
