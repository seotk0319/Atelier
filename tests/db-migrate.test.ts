import type Database from 'better-sqlite3'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrateDatabase, pruneBackups } from '../src/main/db/migrate'
import { migrations } from '../src/main/db/migrations'

// better-sqlite3는 Electron용으로 빌드돼 있어 vitest(Node)에서 열 수 없다.
// 같은 SQLite 파일을 Node 내장 node:sqlite로 열고, migrate.ts가 쓰는 better-sqlite3 API만 흉내 낸다.
type Hook = (sql: string) => void

function open(path: string, afterVersionRead?: Hook): { db: Database.Database; raw: DatabaseSync } {
  const raw = new DatabaseSync(path)
  raw.exec('PRAGMA journal_mode = WAL')
  let hooked = afterVersionRead
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
      const value = Object.values(row)[0]
      if (hooked && source === 'user_version') {
        // 첫 버전 읽기 직후 다른 연결이 끼어든다 — 읽은 값은 이미 낡은 값이 된다
        const hook = hooked
        hooked = undefined
        hook(source)
      }
      return options?.simple ? value : [row]
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
    }
  }
  return { db: api as unknown as Database.Database, raw }
}

let dir: string
let opened: DatabaseSync[]

function connect(path: string, hook?: Hook): Database.Database {
  const { db, raw } = open(path, hook)
  opened.push(raw)
  return db
}

function version(path: string): number {
  const raw = new DatabaseSync(path)
  try {
    return (raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
  } finally {
    raw.close()
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'nais3-migrate-'))
  opened = []
})

afterEach(() => {
  for (const raw of opened) {
    try {
      raw.close()
    } catch {
      /* 이미 닫힘 */
    }
  }
  rmSync(dir, { recursive: true, force: true })
})

describe('migrateDatabase', () => {
  it('새 DB는 백업 없이 모든 마이그레이션을 적용한다', () => {
    const path = join(dir, 'nais3.db')
    const backupDir = join(dir, 'backups')
    const result = migrateDatabase(connect(path), migrations, { backupDir })
    expect(result).toEqual({ version: migrations.length, backupPath: null })
    expect(existsSync(backupDir)).toBe(false)
  })

  it('다른 연결이 먼저 올린 버전을 다시 적용하지 않는다 (가짜 마이그레이션 호출 횟수)', () => {
    const path = join(dir, 'nais3.db')
    const backupDir = join(dir, 'backups')
    const calls: number[] = []
    // IF NOT EXISTS 없음 — 두 번 적용되면 "already exists"로 실패한다
    const list = [0, 1, 2].map((n) => (db: Database.Database) => {
      calls.push(n)
      db.exec(`CREATE TABLE t${n} (id INTEGER)`)
    })
    migrateDatabase(connect(path), list.slice(0, 1), { backupDir })
    calls.length = 0

    const first = connect(path, () => {
      migrateDatabase(connect(path), list, { backupDir })
    })
    const result = migrateDatabase(first, list, { backupDir })

    expect(calls).toEqual([1, 2])
    expect(result.version).toBe(3)
    expect(version(path)).toBe(3)
  })

  it('실제 마이그레이션도 v15 → 최신을 두 프로세스가 겹쳐 돌려도 한 번만 적용된다', () => {
    const path = join(dir, 'nais3.db')
    const backupDir = join(dir, 'backups')
    migrateDatabase(connect(path), migrations.slice(0, 15), { backupDir })
    expect(version(path)).toBe(15)

    const first = connect(path, () => {
      migrateDatabase(connect(path), migrations, { backupDir })
    })
    expect(() => migrateDatabase(first, migrations, { backupDir })).not.toThrow()
    expect(version(path)).toBe(migrations.length)
  })

  it('마이그레이션이 필요할 때만 백업을 뜨고, 백업은 옛 버전 그대로다', () => {
    const path = join(dir, 'nais3.db')
    const backupDir = join(dir, 'backups')
    migrateDatabase(connect(path), migrations.slice(0, 20), { backupDir })
    expect(existsSync(backupDir)).toBe(false)

    const result = migrateDatabase(connect(path), migrations, { backupDir })
    expect(result.backupPath).toBe(join(backupDir, 'pre-migration-v20.db'))
    expect(readdirSync(backupDir)).toEqual(['pre-migration-v20.db'])
    expect(version(join(backupDir, 'pre-migration-v20.db'))).toBe(20)
    expect(version(path)).toBe(migrations.length)

    // 이미 최신이면 새 백업을 뜨지 않는다
    const again = migrateDatabase(connect(path), migrations, { backupDir })
    expect(again.backupPath).toBeNull()
    expect(readdirSync(backupDir)).toEqual(['pre-migration-v20.db'])
  })

  it('마이그레이션 전에 원본 DB를 바이트 그대로 upgrade-backups/schema-v{N}/에 남기고 지우지 않는다', () => {
    const path = join(dir, 'nais3.db')
    const backupDir = join(dir, 'backups')
    const upgradeBackupDir = join(dir, 'upgrade-backups')
    const opts = { backupDir, upgradeBackupDir, dbPath: path }
    const first = connect(path)
    migrateDatabase(first, migrations.slice(0, 20), opts)
    expect(existsSync(upgradeBackupDir)).toBe(false)
    // 원래 DB 파일 내용(복사 직전 상태) — WAL을 비워 파일에 모두 내려 둔다
    ;(first as unknown as { pragma: (s: string) => unknown }).pragma('wal_checkpoint(TRUNCATE)')
    const original = readFileSync(path)

    migrateDatabase(connect(path), migrations, opts)
    const copy = join(upgradeBackupDir, 'schema-v20', 'nais3.db')
    expect(readFileSync(copy).equals(original)).toBe(true)
    expect(version(copy)).toBe(20)
    expect(version(path)).toBe(migrations.length)

    // 같은 버전 복사본은 덮어쓰지 않고, 남은 임시 파일은 다음 실행에서 지운다
    writeFileSync(join(upgradeBackupDir, 'schema-v20', 'nais3.db.abcd.tmp'), 'partial')
    migrateDatabase(connect(path), migrations, opts)
    expect(readdirSync(join(upgradeBackupDir, 'schema-v20'))).toEqual(['nais3.db'])
    expect(readFileSync(copy).equals(original)).toBe(true)
  })

  it('스냅샷 도중 끊겨 남은 임시 파일을 마이그레이션이 없는 실행에서도 지운다', () => {
    const path = join(dir, 'nais3.db')
    const backupDir = join(dir, 'backups')
    migrateDatabase(connect(path), migrations, { backupDir: join(dir, 'unused') })
    rmSync(join(dir, 'unused'), { recursive: true, force: true })

    mkdirSync(backupDir)
    writeFileSync(join(backupDir, 'pre-migration-v20.db.1234.tmp'), 'partial')
    writeFileSync(join(backupDir, 'pre-migration-v20.db.1234.tmp-journal'), 'partial')
    writeFileSync(join(backupDir, 'pre-migration-v19.db'), 'keep')

    migrateDatabase(connect(path), migrations, { backupDir })
    expect(readdirSync(backupDir)).toEqual(['pre-migration-v19.db'])
  })

  it('v23은 썸네일과 요청 본문을 image_blobs로 옮기고 images에서 뺀다', () => {
    const path = join(dir, 'nais3.db')
    const backupDir = join(dir, 'backups')
    migrateDatabase(connect(path), migrations.slice(0, 22), { backupDir })
    const raw = new DatabaseSync(path)
    opened.push(raw)
    const insert = raw.prepare(
      'INSERT INTO images (file_path, thumbnail, kind, seed, payload_json, favorite) VALUES (?, ?, ?, ?, ?, ?)'
    )
    insert.run('a.png', Buffer.from([1, 2, 3]), 't2i', 11, '{"a":1}', 1)
    insert.run('b.png', null, 'scene', 22, '{"b":2}', 0)
    const before = raw
      .prepare('SELECT id, file_path, kind, seed, created_at, favorite FROM images ORDER BY id')
      .all()

    migrateDatabase(connect(path), migrations, { backupDir })

    const columns = (raw.prepare('PRAGMA table_info(images)').all() as { name: string }[]).map(
      (c) => c.name
    )
    expect(columns).not.toContain('thumbnail')
    expect(columns).not.toContain('payload_json')
    expect(
      raw
        .prepare('SELECT id, file_path, kind, seed, created_at, favorite FROM images ORDER BY id')
        .all()
    ).toEqual(before)
    const blobs = raw
      .prepare('SELECT image_id, thumbnail, payload_json FROM image_blobs ORDER BY image_id')
      .all() as {
      image_id: number
      thumbnail: Uint8Array | null
      payload_json: string
    }[]
    expect(
      blobs.map((b) => [b.image_id, b.thumbnail ? [...b.thumbnail] : null, b.payload_json])
    ).toEqual([
      [1, [1, 2, 3], '{"a":1}'],
      [2, null, '{"b":2}']
    ])
    // 색인은 그대로 남는다
    const indexes = (
      raw
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'images'")
        .all() as { name: string }[]
    ).map((r) => r.name)
    expect(indexes).toEqual(
      expect.arrayContaining([
        'idx_images_created',
        'idx_images_kind',
        'idx_images_scene',
        'idx_images_file_path',
        'idx_images_library_folder'
      ])
    )
    // 그림을 지우면 무거운 칸도 같이 지워진다
    raw.exec('PRAGMA foreign_keys = ON')
    raw.prepare('DELETE FROM images WHERE id = 1').run()
    expect(raw.prepare('SELECT image_id FROM image_blobs').all()).toEqual([{ image_id: 2 }])
  })

  it('지원하는 것보다 새 버전 DB는 열지 않는다', () => {
    const path = join(dir, 'nais3.db')
    const raw = new DatabaseSync(path)
    raw.exec(`PRAGMA user_version = ${migrations.length + 1}`)
    raw.close()
    expect(() => migrateDatabase(connect(path), migrations, { backupDir: join(dir, 'b') })).toThrow(
      /newer than app supports/
    )
  })
})

describe('pruneBackups', () => {
  it('마이그레이션 전 백업만 최근 것부터 정해진 개수만 남긴다', () => {
    const now = Date.now() / 1000
    // 이름순과 시간순이 다르게 (v9가 v10보다 이름순으로 뒤)
    const names = [
      'pre-migration-v9.db',
      'pre-migration-v10.db',
      'pre-migration-v11.db',
      'pre-migration-v12.db'
    ]
    names.forEach((name, i) => {
      writeFileSync(join(dir, name), name)
      utimesSync(join(dir, name), now - 100 + i, now - 100 + i)
    })
    writeFileSync(join(dir, 'other.db'), 'not a migration backup')

    pruneBackups(dir, 2)
    expect(readdirSync(dir).sort()).toEqual(
      ['other.db', 'pre-migration-v11.db', 'pre-migration-v12.db'].sort()
    )
  })
})
