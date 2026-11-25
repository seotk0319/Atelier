import Database from 'better-sqlite3'
import { app } from 'electron'
import { mkdirSync } from 'fs'
import { join } from 'path'
import { migrateDatabase } from './migrate'
import { migrations } from './migrations'

let db: Database.Database | null = null

export function getDb(): Database.Database {
  if (!db) throw new Error('DB not initialized — call initDb() first')
  return db
}

export function getDbPath(): string {
  return join(app.getPath('userData'), 'nais3.db')
}

/**
 * DB 열기 + 마이그레이션.
 *
 * 안전장치 (NAIS2 세이브 유실 문제의 근본 대책):
 * - WAL 모드: 크래시 시에도 커밋된 데이터 보존
 * - 적용할 마이그레이션이 있을 때만 실행 전 원본 파일 복사본(userData\upgrade-backups\schema-v{N}\,
 *   지우지 않음)과 스냅샷(userData\backups\pre-migration-v{N}.db, 최근 3개만 보관)을 만든다.
 *   도중 끊겨 남은 임시 파일은 실행마다 정리
 * - 각 마이그레이션은 쓰기 잠금 안에서 버전을 다시 읽고 개별 트랜잭션으로 적용:
 *   실패하면 해당 버전 이전 상태로 남고 앱은 에러 표면화
 */
export function initDb(): { version: number; path: string } {
  const dir = app.getPath('userData')
  mkdirSync(dir, { recursive: true })
  const path = getDbPath()

  db = new Database(path)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('synchronous = NORMAL')
  db.pragma('temp_store = MEMORY')
  db.pragma('cache_size = -65536')

  const { version, backupPath } = migrateDatabase(db, migrations, {
    backupDir: join(dir, 'backups'),
    upgradeBackupDir: join(dir, 'upgrade-backups'),
    dbPath: path
  })
  // 큰 표를 옮긴 마이그레이션(v23) 뒤에는 WAL 파일이 DB만큼 커져 남는다 — 비워서 줄인다
  if (backupPath) db.pragma('wal_checkpoint(TRUNCATE)')

  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_images_scene_favorite ON images(scene_id, favorite DESC, id DESC)'
  )

  return { version, path }
}

export function closeDb(): void {
  db?.close()
  db = null
}
