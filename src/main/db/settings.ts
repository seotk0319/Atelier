import { safeStorage } from 'electron'
import { randomUUID } from 'crypto'
import type { NaiAccountInfo } from '../../shared/types'
import { getDb } from './index'

export function getSetting(key: string): string | null {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    { value: string } | undefined
  return row?.value ?? null
}

export function setSetting(key: string, value: string): void {
  getDb()
    .prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    )
    .run(key, value)
}

const TOKEN_KEY = 'nai_token_encrypted'
const ACCOUNTS_KEY = 'nai_accounts_encrypted_v1'

export interface NaiAccountSecret {
  id: string
  name: string
  token: string
}

function encryptValue(value: string): string {
  return safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(value).toString('base64')
    : Buffer.from(value).toString('base64')
}

function decryptValue(stored: string): string | null {
  const buf = Buffer.from(stored, 'base64')
  try {
    return safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(buf)
      : buf.toString('utf-8')
  } catch {
    return null
  }
}

function getLegacyNaiToken(): string | null {
  const stored = getSetting(TOKEN_KEY)
  if (!stored) return null
  return decryptValue(stored)
}

function readStoredAccounts(): NaiAccountSecret[] | null {
  const stored = getSetting(ACCOUNTS_KEY)
  if (stored === null) return null
  const raw = decryptValue(stored)
  if (raw === null) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((value) => {
      if (!value || typeof value !== 'object') return []
      const row = value as Partial<NaiAccountSecret>
      const token = typeof row.token === 'string' ? row.token.trim() : ''
      if (!token) return []
      return [
        {
          id: typeof row.id === 'string' && row.id ? row.id : randomUUID(),
          name: typeof row.name === 'string' && row.name ? row.name : '',
          token
        }
      ]
    })
  } catch {
    return []
  }
}

/**
 * 저장된 토큰 값이 있는데 지금 읽을 수 없는지 — 키체인 잠김, 다른 PC·사용자에서 옮겨 온 데이터 폴더,
 * 손상된 값. 이때 읽은 결과는 빈 목록이라, 그 위에 새 계정을 쓰면 기존 계정이 조용히 사라진다
 * (upstream NAIS3 37aa08b·2d08255).
 */
export function isNaiTokenStoreUnreadable(): boolean {
  const stored = getSetting(ACCOUNTS_KEY)
  if (stored !== null) {
    const raw = decryptValue(stored)
    if (raw === null) return true
    try {
      return !Array.isArray(JSON.parse(raw))
    } catch {
      return true
    }
  }
  const legacy = getSetting(TOKEN_KEY)
  if (legacy === null) return false
  const token = decryptValue(legacy)
  return token === null || !/^[!-~]+$/.test(token.trim())
}

/**
 * 읽을 수 없는 토큰 값을 지우지 않고 다른 키로 옮겨 둔다 (키체인이 돌아오면 되살릴 수 있게).
 * 계정을 새로 쓰기 직전에만 부른다.
 */
function preserveUnreadableTokens(): void {
  if (!isNaiTokenStoreUnreadable()) return
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  for (const key of [ACCOUNTS_KEY, TOKEN_KEY]) {
    const value = getSetting(key)
    if (value !== null) setSetting(`${key}_unreadable_${stamp}`, value)
  }
  getDb().prepare('DELETE FROM settings WHERE key IN (?, ?)').run(TOKEN_KEY, ACCOUNTS_KEY)
}

function writeAccounts(accounts: NaiAccountSecret[]): void {
  const normalized = accounts.map((account, index) => ({
    ...account,
    name: `계정 ${index + 1}`,
    token: account.token.trim()
  }))
  setSetting(ACCOUNTS_KEY, encryptValue(JSON.stringify(normalized)))
  const primary = normalized[0]?.token
  if (primary) setSetting(TOKEN_KEY, encryptValue(primary))
  else getDb().prepare('DELETE FROM settings WHERE key = ?').run(TOKEN_KEY)
}

/**
 * NAI 토큰은 OS 키체인 기반 safeStorage로 암호화해 저장한다.
 * (NAIS2에서 "설정 파일 못 뜯어본다"는 불만이 있었지만 토큰만큼은 평문 금지)
 */
export function setNaiToken(token: string): void {
  const normalized = token.trim()
  preserveUnreadableTokens()
  const accounts = readStoredAccounts()
  if (accounts !== null) {
    if (accounts[0]) accounts[0] = { ...accounts[0], token: normalized }
    else accounts.push({ id: randomUUID(), name: '계정 1', token: normalized })
    writeAccounts(accounts)
    return
  }
  setSetting(TOKEN_KEY, encryptValue(normalized))
}

export function getNaiToken(): string | null {
  const accounts = readStoredAccounts()
  if (accounts !== null) return accounts[0]?.token ?? null
  return getLegacyNaiToken()
}

export function deleteNaiToken(): void {
  const db = getDb()
  db.prepare('DELETE FROM settings WHERE key IN (?, ?)').run(TOKEN_KEY, ACCOUNTS_KEY)
}

// 댓글 번역용 DeepL API 키. NAI 토큰과 같은 방식으로 암호화해 저장한다.
const DEEPL_KEY = 'deepl_key_encrypted'
export function getDeeplKey(): string | null {
  const stored = getSetting(DEEPL_KEY)
  return stored ? decryptValue(stored) : null
}
export function setDeeplKey(key: string): void {
  setSetting(DEEPL_KEY, encryptValue(key.trim()))
}
export function deleteDeeplKey(): void {
  getDb().prepare('DELETE FROM settings WHERE key = ?').run(DEEPL_KEY)
}

// AI 답글용 Claude API 키. DeepL 키와 같은 방식으로 암호화해 저장한다.
const CLAUDE_KEY = 'claude_key_encrypted'
export function getClaudeKey(): string | null {
  const stored = getSetting(CLAUDE_KEY)
  return stored ? decryptValue(stored) : null
}
export function setClaudeKey(key: string): void {
  setSetting(CLAUDE_KEY, encryptValue(key.trim()))
}
export function deleteClaudeKey(): void {
  getDb().prepare('DELETE FROM settings WHERE key = ?').run(CLAUDE_KEY)
}

// OpenRouter API 키 (DeepSeek 번역 · AI 태그 도우미 공용). 다른 키와 같은 방식으로 암호화한다.
const OPENROUTER_KEY = 'openrouter_key_encrypted'
export function getOpenRouterKey(): string | null {
  const stored = getSetting(OPENROUTER_KEY)
  return stored ? decryptValue(stored) : null
}
export function setOpenRouterKey(key: string): void {
  setSetting(OPENROUTER_KEY, encryptValue(key.trim()))
}
export function deleteOpenRouterKey(): void {
  getDb().prepare('DELETE FROM settings WHERE key = ?').run(OPENROUTER_KEY)
}

/** 마스킹 표시용 메타 (WHIMS 프로바이더 키 UI 패턴) */
export function getNaiTokenInfo(): { hasToken: boolean; prefix: string; length: number } {
  const token = getNaiToken()
  if (!token) return { hasToken: false, prefix: '', length: 0 }
  return { hasToken: true, prefix: token.slice(0, 4), length: token.length }
}

/** 구버전 단일 토큰은 쓰기 없이 계정 1로 투영한다. 두 번째 계정을 추가할 때만 새 배열로 이관한다. */
export function getNaiAccounts(): NaiAccountSecret[] {
  const stored = readStoredAccounts()
  if (stored !== null) return stored
  const token = getLegacyNaiToken()
  return token ? [{ id: 'legacy-primary', name: '계정 1', token }] : []
}

export function getNaiAccountInfos(): NaiAccountInfo[] {
  const excluded = new Set(getAccelerationExcluded())
  const memos = getAccountMemos()
  return getNaiAccounts().map((account, index) => ({
    id: account.id,
    name: `계정 ${index + 1}`,
    prefix: account.token.slice(0, 4),
    length: account.token.length,
    accelerated: !excluded.has(account.id),
    memo: memos[account.id] ?? ''
  }))
}

// 계정별 메모. 비밀값이 아니라서 토큰 묶음과 따로 평문으로 둔다 (계정 id → 메모).
const MEMOS_KEY = 'nai_account_memos'
export const ACCOUNT_MEMO_MAX = 200
function getAccountMemos(): Record<string, string> {
  try {
    const value = JSON.parse(getSetting(MEMOS_KEY) || '{}') as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
    return Object.fromEntries(
      Object.entries(value).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string'
      )
    )
  } catch {
    return {}
  }
}
function writeAccountMemos(memos: Record<string, string>): void {
  setSetting(MEMOS_KEY, JSON.stringify(memos))
}
/** 계정 메모를 저장한다. 비우면 지운다. */
export function setNaiAccountMemo(id: string, memo: string): { ok: boolean; error?: string } {
  if (!getNaiAccounts().some((account) => account.id === id))
    return { ok: false, error: '계정을 찾지 못했어요' }
  const text = memo.trim().slice(0, ACCOUNT_MEMO_MAX)
  const memos = getAccountMemos()
  if (text) memos[id] = text
  else delete memos[id]
  writeAccountMemos(memos)
  return { ok: true }
}

// 가속 모드에서 쓰지 않을 계정 id. 비어 있으면(기본) 모든 계정을 쓴다.
const ACCEL_EXCLUDED_KEY = 'acceleration_excluded'
export function getAccelerationExcluded(): string[] {
  try {
    const value = JSON.parse(getSetting(ACCEL_EXCLUDED_KEY) || '[]') as unknown
    return Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}
/** 계정을 가속 모드에 넣거나 뺀다. 마지막 남은 계정은 뺄 수 없다. */
export function setAccountAccelerated(id: string, on: boolean): { ok: boolean; error?: string } {
  const accounts = getNaiAccounts()
  if (!accounts.some((account) => account.id === id))
    return { ok: false, error: '계정을 찾지 못했어요' }
  const excluded = new Set(
    getAccelerationExcluded().filter((x) => accounts.some((account) => account.id === x))
  )
  if (on) excluded.delete(id)
  else excluded.add(id)
  if (accounts.every((account) => excluded.has(account.id)))
    return { ok: false, error: '가속 모드에는 계정이 하나 이상 있어야 해요' }
  setSetting(ACCEL_EXCLUDED_KEY, JSON.stringify([...excluded]))
  return { ok: true }
}

export function getNaiAccountToken(id: string): string | null {
  return getNaiAccounts().find((account) => account.id === id)?.token ?? null
}

export function addNaiAccount(token: string): { added: boolean; error?: string } {
  const normalized = token.trim()
  preserveUnreadableTokens()
  const accounts = getNaiAccounts()
  if (accounts.some((account) => account.token === normalized)) {
    return { added: false, error: '이미 등록된 토큰입니다' }
  }
  accounts.push({ id: randomUUID(), name: `계정 ${accounts.length + 1}`, token: normalized })
  writeAccounts(accounts)
  return { added: true }
}

export function deleteNaiAccount(id: string): boolean {
  const accounts = getNaiAccounts()
  const next = accounts.filter((account) => account.id !== id)
  if (next.length === accounts.length) return false
  writeAccounts(next)
  const memos = getAccountMemos()
  if (id in memos) {
    delete memos[id]
    writeAccountMemos(memos)
  }
  return true
}
