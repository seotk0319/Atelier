import type Database from 'better-sqlite3'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { findRecoveryNotice, restoreBackup, setBackupOpener } from '../src/main/backup/recovery'
import { migrateDatabase, snapshotBeforeImport } from '../src/main/db/migrate'
import { migrations } from '../src/main/db/migrations'

// better-sqlite3는 Electron용으로 빌드돼 vitest(Node)에서 열 수 없다 — node:sqlite로 흉내 낸다.
function wrap(raw: DatabaseSync): Database.Database {
  const api = {
    exec(sql: string) {
      raw.exec(sql)
      return api
    },
    prepare(sql: string) {
      const statement = raw.prepare(sql)
      return {
        run: (...params: never[]) => statement.run(...params),
        get: (...params: never[]) => statement.get(...params),
        all: (...params: never[]) => statement.all(...params)
      }
    },
    pragma(source: string, options?: { simple?: boolean }) {
      if (source.includes('=')) {
        raw.exec(`PRAGMA ${source}`)
        return []
      }
      const row = raw.prepare(`PRAGMA ${source}`).get() as Record<string, unknown>
      return options?.simple ? Object.values(row)[0] : [row]
    },
    transaction<T>(fn: () => T) {
      const run = (mode: string) => (): T => {
        raw.exec(`BEGIN ${mode}`)
        try {
          const result = fn()
          raw.exec('COMMIT')
          return result
        } catch (error) {
          raw.exec('ROLLBACK')
          throw error
        }
      }
      return Object.assign(run('DEFERRED'), {
        immediate: run('IMMEDIATE'),
        deferred: run('DEFERRED')
      })
    },
    close() {
      raw.close()
    }
  }
  return api as unknown as Database.Database
}

let root: string
let opened: DatabaseSync[]

function connect(path: string, readOnly = false): Database.Database {
  const raw = new DatabaseSync(path, readOnly ? { readOnly: true } : {})
  if (!readOnly) raw.exec('PRAGMA journal_mode = WAL')
  opened.push(raw)
  return wrap(raw)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'atelier-recovery-'))
  opened = []
  setBackupOpener((path) => connect(path, true))
})

afterEach(() => {
  for (const raw of opened) {
    try {
      raw.close()
    } catch {
      /* 이미 닫힘 */
    }
  }
  rmSync(root, { recursive: true, force: true })
})

const paths = (): {
  root: string
  dbPath: string
  backupDir: string
  upgradeBackupDir: string
} => ({
  root,
  dbPath: join(root, 'nais3.db'),
  backupDir: join(root, 'backups'),
  upgradeBackupDir: join(root, 'upgrade-backups')
})

const presetCount = (db: Database.Database): number =>
  (db.prepare('SELECT COUNT(*) AS n FROM prompt_presets').get() as { n: number }).n

describe('데이터 유실 감지와 백업으로 되돌리기', () => {
  it('작업 공간이 비었는데 백업에 데이터가 있으면 알리고, 되돌리면 그 데이터가 돌아온다', () => {
    const p = paths()
    const db = connect(p.dbPath)
    migrateDatabase(db, migrations, { backupDir: p.backupDir })
    // 새 DB는 기본 씬 프리셋만 있다 — 데이터 없음으로 본다
    expect(findRecoveryNotice(db, p, null)).toBeNull()

    db.prepare(
      "INSERT INTO prompt_presets (name, prompt, negative_prompt, params_json, sort_order) VALUES ('a', 'x', '', NULL, 0)"
    ).run()
    snapshotBeforeImport(db, p.backupDir)
    // 데이터가 있으면 백업을 열지 않는다
    expect(findRecoveryNotice(db, p, null)).toBeNull()

    db.prepare('DELETE FROM prompt_presets').run()
    const notice = findRecoveryNotice(db, p, null)
    expect(notice?.kind).toBe('import')
    expect(notice?.counts.promptPresets).toBe(1)
    expect(notice?.schemaVersion).toBe(migrations.length)
    // 「그대로 쓰기」를 고른 같은 파일은 다시 알리지 않는다
    expect(findRecoveryNotice(db, p, notice!.key)).toBeNull()

    let current: Database.Database | null = db
    restoreBackup(notice!, p, {
      current: () => current!,
      snapshotCurrent: () =>
        void snapshotBeforeImport(current!, p.backupDir, new Date(), 'pre-restore'),
      close: () => {
        ;(current as unknown as { close: () => void }).close()
        current = null
      },
      reopen: () => {
        current = connect(p.dbPath)
      }
    })
    expect(presetCount(connect(p.dbPath))).toBe(1)
    // 되돌리기 직전 상태도 남는다
    expect(readdirSync(join(p.backupDir, 'pre-restore'))).toHaveLength(1)
    // 임시 파일이 남지 않는다
    expect(readdirSync(root).filter((f) => f.includes('.restore-'))).toEqual([])
    expect(existsSync(notice!.path)).toBe(true)
  })

  it('알아보지 못하는 파일·빈 백업은 건너뛴다', () => {
    const p = paths()
    const db = connect(p.dbPath)
    migrateDatabase(db, migrations, { backupDir: p.backupDir })
    snapshotBeforeImport(db, p.backupDir) // 빈 백업
    expect(findRecoveryNotice(db, p, null)).toBeNull()
  })
})
