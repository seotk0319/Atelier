import type Database from 'better-sqlite3'
import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'fs'
import { join } from 'path'

// electron에 의존하지 않는다 — initDb(db/index.ts)가 쓰고, 테스트가 임시 파일 DB로 직접 돌린다.

type Migration = (db: Database.Database) => void

/** 마이그레이션 전 스냅샷은 DB 크기만 하다 — 최근 것만 남긴다 */
export const KEEP_MIGRATION_BACKUPS = 3

export interface MigrateResult {
  /** 적용 뒤 user_version */
  version: number
  /** 이번 실행에서 뜬 마이그레이션 전 백업 (마이그레이션이 필요 없었으면 null) */
  backupPath: string | null
}

/**
 * 남은 마이그레이션 적용.
 *
 * - 실행마다 백업 폴더에 남은 스냅샷 임시 파일(.tmp, .tmp-journal)을 지운다.
 * - 적용할 마이그레이션이 있을 때만(기존 DB, 버전 1 이상) 먼저 VACUUM INTO 스냅샷을 뜬다.
 * - 버전은 쓰기 잠금(IMMEDIATE)을 잡은 뒤 다시 읽고 한 버전씩 개별 트랜잭션으로 적용한다 —
 *   같은 DB를 연 다른 프로세스가 먼저 올린 버전을 또 적용하지 않는다.
 */
export function migrateDatabase(
  db: Database.Database,
  migrations: readonly Migration[],
  options: { backupDir: string; keepBackups?: number }
): MigrateResult {
  const target = migrations.length
  let current = readVersion(db)
  assertSupportedVersion(current, target)
  removeSnapshotTemps(options.backupDir)
  if (current === target) return { version: current, backupPath: null }

  let backupPath: string | null = null
  if (current > 0) {
    backupPath = backupBeforeMigration(
      db,
      options.backupDir,
      current,
      options.keepBackups ?? KEEP_MIGRATION_BACKUPS
    )
  }

  // Custom 1.0.12의 v12/v13은 upstream과 번호 의미가 달랐다. 라이브러리 테이블이
  // 없다면 v11부터 upstream v12~v14를 다시 적용하되, 각 migration은 기존 컬럼을 보존한다.
  if ((current === 12 || current === 13) && !hasTable(db, 'library_stacks')) {
    current = 11
    db.pragma('user_version = 11')
  }

  const migrateNext = db.transaction((): boolean => {
    const v = readVersion(db)
    // 그사이 다른 프로세스가 더 새 버전으로 올렸을 수도 있다
    assertSupportedVersion(v, target)
    if (v >= target) return false
    migrations[v](db)
    db.pragma(`user_version = ${v + 1}`)
    return true
  })
  try {
    while (migrateNext.immediate()) {
      /* 한 버전씩 */
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(
      `DB migration 실패: ${detail}` + (backupPath ? `\n마이그레이션 전 백업: ${backupPath}` : '')
    )
  }
  return { version: readVersion(db), backupPath }
}

function readVersion(db: Database.Database): number {
  return db.pragma('user_version', { simple: true }) as number
}

function assertSupportedVersion(version: number, target: number): void {
  // 다운그레이드된 앱이 미래 버전 DB를 여는 상황 — 조용히 진행하면 데이터가 깨진다
  if (version > target) {
    throw new Error(
      `DB version ${version} is newer than app supports (${target}). ` +
        'NAIS3를 최신 버전으로 업데이트하세요.'
    )
  }
}

function backupBeforeMigration(
  db: Database.Database,
  backupDir: string,
  fromVersion: number,
  keep: number
): string {
  mkdirSync(backupDir, { recursive: true })
  const destination = join(backupDir, `pre-migration-v${fromVersion}.db`)
  writeSnapshot(db, destination)
  pruneBackups(backupDir, keep)
  return destination
}

/** 커밋된 WAL 내용까지 포함한 스냅샷. 다 뜬 뒤에만 같은 이름의 옛 백업을 바꾼다 */
export function writeSnapshot(db: Database.Database, destination: string): void {
  const temporary = `${destination}.${randomUUID()}.tmp`
  try {
    db.prepare('VACUUM INTO ?').run(temporary)
    rmSync(destination, { force: true })
    renameSync(temporary, destination)
  } finally {
    rmSync(temporary, { force: true })
    rmSync(`${temporary}-journal`, { force: true })
  }
}

/** 스냅샷 도중 강제 종료되면 DB 크기만 한 .tmp(와 그 -journal)가 남는다 */
export function removeSnapshotTemps(backupDir: string): void {
  if (!existsSync(backupDir)) return
  for (const f of readdirSync(backupDir)) {
    if (f.endsWith('.tmp') || f.endsWith('.tmp-journal')) {
      rmSync(join(backupDir, f), { force: true })
    }
  }
}

/** 마이그레이션 전 백업(pre-migration-*.db)만 수정 시각 순으로 최근 keep개 남긴다 */
export function pruneBackups(backupDir: string, keep: number): void {
  const files = readdirSync(backupDir)
    .filter((f) => f.startsWith('pre-migration-') && f.endsWith('.db'))
    .map((name) => ({ name, mtimeMs: statSync(join(backupDir, name)).mtimeMs }))
    .sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name))
  for (const f of files.slice(0, Math.max(0, files.length - keep))) {
    rmSync(join(backupDir, f.name), { force: true })
  }
}

function hasTable(database: Database.Database, table: string): boolean {
  return Boolean(
    database.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table)
  )
}
