import type Database from 'better-sqlite3'
import { randomUUID } from 'crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeSync
} from 'fs'
import { basename, join } from 'path'

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
 * - 적용할 마이그레이션이 있을 때만(기존 DB, 버전 1 이상) 먼저 DB 파일(과 WAL)을 바이트 그대로
 *   upgradeBackupDir/schema-v{N}/에 복사하고(지우지 않는다), 이어서 VACUUM INTO 스냅샷을 뜬다.
 *   둘 중 하나라도 실패하면 마이그레이션하지 않는다.
 * - 버전은 쓰기 잠금(IMMEDIATE)을 잡은 뒤 다시 읽고 한 버전씩 개별 트랜잭션으로 적용한다 —
 *   같은 DB를 연 다른 프로세스가 먼저 올린 버전을 또 적용하지 않는다.
 */
export function migrateDatabase(
  db: Database.Database,
  migrations: readonly Migration[],
  options: {
    backupDir: string
    keepBackups?: number
    /** 업그레이드 직전 원본 복사본 폴더 (schema-v{N}/). 정리하지 않는다. dbPath와 같이 줄 때만 복사한다 */
    upgradeBackupDir?: string
    dbPath?: string
  }
): MigrateResult {
  const target = migrations.length
  let current = readVersion(db)
  assertSupportedVersion(current, target)
  removeSnapshotTemps(options.backupDir)
  if (options.upgradeBackupDir) removeUpgradeCopyTemps(options.upgradeBackupDir)
  if (current === target) return { version: current, backupPath: null }

  let backupPath: string | null = null
  if (current > 0) {
    // 원본 복사가 먼저 — 스냅샷은 SQLite가 다시 써서 만든 사본이라, 손상된 페이지가 있으면
    // 실패하거나 원본과 달라질 수 있다 (upstream NAIS3 9ed17dc)
    if (options.upgradeBackupDir && options.dbPath)
      copyOriginalFiles(options.dbPath, options.upgradeBackupDir, current)
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

/**
 * 이전 버전 앱이 남긴 DB 파일(과 체크포인트되지 않은 WAL)을 바이트 그대로 upgradeBackupDir/schema-v{N}/에
 * 복사한다. 이 연결은 아직 아무것도 쓰지 않았고 다른 실행은 single-instance 잠금으로 막혀 있어 파일이
 * 복사 도중 바뀌지 않는다. 여기는 정리하지 않는다 — 업데이트 뒤 데이터가 사라졌을 때 직접 되돌릴 원본이다.
 *
 * 같은 버전의 복사본이 이미 있으면 그대로 둔다: 업그레이드가 중단돼 다시 시작할 때마다 큰 DB를 또
 * 복사하지 않고, 처음 남긴 원본을 덮어쓰지 않는다. DB 파일은 임시 이름으로 복사한 뒤 바꿔 달아,
 * 복사 도중 종료돼도 반쪽짜리 nais3.db가 완성된 복사본으로 남지 않는다.
 */
export function copyOriginalFiles(dbPath: string, upgradeBackupDir: string, version: number): void {
  const folder = join(upgradeBackupDir, `schema-v${version}`)
  const destination = join(folder, basename(dbPath))
  if (existsSync(destination)) return
  mkdirSync(folder, { recursive: true })
  // WAL을 먼저 — DB 파일이 생겨야 완성된 복사본이다. 중단된 이전 시도의 WAL은 버린다
  const wal = `${dbPath}-wal`
  const walCopy = `${destination}-wal`
  rmSync(walCopy, { force: true })
  if (existsSync(wal) && statSync(wal).size > 0) copyOpenFile(wal, walCopy)
  const temporary = `${destination}.${randomUUID()}.tmp`
  try {
    copyOpenFile(dbPath, temporary)
    renameSync(temporary, destination)
  } finally {
    rmSync(temporary, { force: true })
  }
}

/**
 * 이 프로세스가 열어 둔 DB 파일도 복사하고, 마이그레이션이 커밋되기 전에 디스크에 내려 둔다.
 * copyFileSync는 Windows에서 CopyFile을 쓰는데, 다른 핸들이 쓰기 권한으로 연 파일은 공유 위반으로
 * 거부될 수 있다 — fs.openSync는 읽기·쓰기·삭제 공유를 모두 열어 둔다.
 */
function copyOpenFile(source: string, destination: string): void {
  const input = openSync(source, 'r')
  try {
    const output = openSync(destination, 'w')
    try {
      const buffer = Buffer.allocUnsafe(4 * 1024 * 1024)
      let length: number
      while ((length = readSync(input, buffer, 0, buffer.length, null)) > 0) {
        for (let offset = 0; offset < length;)
          offset += writeSync(output, buffer, offset, length - offset)
      }
      fsyncSync(output)
    } finally {
      closeSync(output)
    }
  } finally {
    closeSync(input)
  }
}

/** 원본 복사 도중 종료돼 schema-v{N}/ 안에 남은 임시 파일 정리 */
function removeUpgradeCopyTemps(upgradeBackupDir: string): void {
  if (!existsSync(upgradeBackupDir)) return
  for (const entry of readdirSync(upgradeBackupDir, { withFileTypes: true })) {
    if (entry.isDirectory()) removeSnapshotTemps(join(upgradeBackupDir, entry.name))
  }
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

/** 백업(기본 pre-migration-*.db)만 수정 시각 순으로 최근 keep개 남긴다 */
export function pruneBackups(backupDir: string, keep: number, prefix = 'pre-migration-'): void {
  const files = readdirSync(backupDir)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.db'))
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

/** 가져오기 전 스냅샷은 마이그레이션 백업과 따로 최근 것만 남긴다 */
export const KEEP_IMPORT_BACKUPS = 3

/**
 * 가져오기(백업 복원·NAIS2)가 표를 비우고 다시 채우기 직전에 지금 DB를 backups/pre-import/에 뜬다
 * (upstream NAIS3 3724ef5). 실패하면 던진다 — 호출 쪽은 가져오기를 하지 않는다.
 */
export function snapshotBeforeImport(
  db: Database.Database,
  backupDir: string,
  now: Date = new Date()
): string {
  const folder = join(backupDir, 'pre-import')
  mkdirSync(folder, { recursive: true })
  removeSnapshotTemps(folder)
  const stamp = now.toISOString().replace(/[:.]/g, '-')
  const destination = join(folder, `pre-import-${stamp}.db`)
  writeSnapshot(db, destination)
  pruneBackups(folder, KEEP_IMPORT_BACKUPS, 'pre-import-')
  return destination
}
