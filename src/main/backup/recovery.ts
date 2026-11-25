import Database from 'better-sqlite3'
import { randomUUID } from 'crypto'
import { existsSync, readdirSync, renameSync, rmSync, statSync } from 'fs'
import { basename, dirname, join, relative, sep } from 'path'
import { migrations } from '../db/migrations'

/**
 * 앱이 데이터 폴더 안에 스스로 남긴 DB 백업(업데이트·가져오기·복원 직전)을 찾아 데이터 수를 세고,
 * 그중 하나로 작업 공간 전체를 되돌린다 (upstream NAIS3 56299a5의 감지·복원 부분만).
 *
 * 데이터가 사라졌다고 알릴 근거는 "지금 작업 공간은 비었는데 백업에는 데이터가 있다"뿐이다 —
 * 일부만 지운 것은 사용자가 의도했을 수 있어 알리지 않는다.
 *
 * electron에 의존하지 않는다 — 경로는 호출하는 쪽(db/index.ts)이 넘긴다.
 */

/** 센다 — 새 DB가 스스로 넣는 줄(기본 씬 프리셋 등)이 없는 표만 */
export const COUNTED_TABLES = {
  scenes: 'gen_scenes',
  promptPresets: 'prompt_presets',
  characters: 'character_prompts',
  fragments: 'fragments',
  history: 'images',
  library: 'library_images',
  vibes: 'vibe_images',
  characterReferences: 'charref_images'
} as const

export type WorkspaceCounts = Record<keyof typeof COUNTED_TABLES, number>

export const COUNT_LABELS: Record<keyof WorkspaceCounts, string> = {
  scenes: '씬',
  promptPresets: '프롬프트 프리셋',
  characters: '캐릭터',
  fragments: '조각',
  history: '생성 기록',
  library: '라이브러리',
  vibes: '바이브',
  characterReferences: '캐릭터 레퍼런스'
}

export type RecoverableBackupKind = 'upgrade-original' | 'upgrade' | 'import' | 'restore'

export const KIND_LABELS: Record<RecoverableBackupKind, string> = {
  'upgrade-original': '업데이트 직전 원본',
  upgrade: '업데이트 직전 백업',
  import: '가져오기 직전 백업',
  restore: '되돌리기 직전 백업'
}

export interface RecoverableBackup {
  /** 데이터 폴더 기준 상대 경로 (슬래시) */
  id: string
  kind: RecoverableBackupKind
  path: string
  /** 같은 이름이라도 다시 쓴 파일은 다른 백업이다 (pre-migration-v{N}.db는 덮어쓴다) */
  key: string
  createdAt: number
  schemaVersion: number
  counts: WorkspaceCounts
}

export interface RecoveryPaths {
  /** 데이터 폴더 (userData) */
  root: string
  dbPath: string
  backupDir: string
  upgradeBackupDir: string
}

export function totalCount(counts: WorkspaceCounts): number {
  return Object.values(counts).reduce((sum, n) => sum + n, 0)
}

/** 오래된 스키마는 일부 표가 없다 — 있는 표만 센다 */
export function countWorkspace(database: Database.Database): WorkspaceCounts {
  const tables = new Set(
    (
      database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
        name: string
      }[]
    ).map((row) => row.name)
  )
  const counts = {} as WorkspaceCounts
  for (const [key, table] of Object.entries(COUNTED_TABLES)) {
    counts[key as keyof WorkspaceCounts] = tables.has(table)
      ? (database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
      : 0
  }
  return counts
}

function listNames(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

interface BackupFile {
  id: string
  kind: RecoverableBackupKind
  path: string
  key: string
  createdAt: number
}

/** 열지 않고 파일만 찾는다. 이름 규칙에 맞는 파일만 — 사용자가 넣어 둔 다른 파일은 건드리지 않는다 */
function backupFiles(paths: RecoveryPaths): BackupFile[] {
  const files: BackupFile[] = []
  const add = (path: string, kind: RecoverableBackupKind): void => {
    try {
      const stat = statSync(path)
      if (!stat.isFile()) return
      const id = relative(paths.root, path).split(sep).join('/')
      files.push({
        id,
        kind,
        path,
        key: `${id}:${stat.size}:${stat.mtimeMs}`,
        createdAt: stat.mtimeMs
      })
    } catch {
      // 그사이 지워졌거나 읽을 수 없다
    }
  }
  for (const name of listNames(paths.upgradeBackupDir)) {
    if (/^schema-v\d+$/.test(name))
      add(join(paths.upgradeBackupDir, name, basename(paths.dbPath)), 'upgrade-original')
  }
  for (const name of listNames(paths.backupDir)) {
    if (/^pre-migration-v\d+\.db$/.test(name)) add(join(paths.backupDir, name), 'upgrade')
  }
  for (const [folder, kind] of [
    ['pre-import', 'import'],
    ['pre-restore', 'restore']
  ] as const) {
    const dir = join(paths.backupDir, folder)
    for (const name of listNames(dir)) {
      if (name.startsWith(`${folder}-`) && name.endsWith('.db')) add(join(dir, name), kind)
    }
  }
  return files
}

/**
 * 백업을 읽기 전용으로 연다. WAL 모드 DB는 읽기 전용으로 열어도 SQLite가 -wal/-shm을 만든다 —
 * 원래 없던 것만 닫은 뒤 지운다 (업데이트 직전 원본 옆의 -wal은 그 원본의 일부라 남긴다)
 */
type OpenReadOnly = (path: string) => Database.Database
let openReadOnly: OpenReadOnly = (path) =>
  new Database(path, { readonly: true, fileMustExist: true })

/** 시험용 — better-sqlite3는 Electron용으로 빌드돼 vitest에서 열 수 없다 */
export function setBackupOpener(open: OpenReadOnly): void {
  openReadOnly = open
}

function withReadOnlyBackup<T>(path: string, read: (database: Database.Database) => T): T {
  const created = [`${path}-wal`, `${path}-shm`].filter((sidecar) => !existsSync(sidecar))
  let database: Database.Database | undefined
  try {
    database = openReadOnly(path)
    return read(database)
  } finally {
    database?.close()
    for (const sidecar of created) rmSync(sidecar, { force: true })
  }
}

/** 이 앱이 열 수 있는 스키마인지 — 0은 빈 파일, 지금보다 높으면 더 새 버전 앱이 쓴 DB */
function isSupportedVersion(version: number): boolean {
  return version >= 1 && version <= migrations.length
}

/** 데이터가 남은 백업을 최근 것부터 */
export function scanBackups(paths: RecoveryPaths): RecoverableBackup[] {
  const found: RecoverableBackup[] = []
  for (const file of backupFiles(paths)) {
    try {
      const read = withReadOnlyBackup(file.path, (database) => {
        const schemaVersion = database.pragma('user_version', { simple: true }) as number
        if (!isSupportedVersion(schemaVersion)) return null
        return { schemaVersion, counts: countWorkspace(database) }
      })
      // 빈 백업은 되돌려도 얻는 것이 없다
      if (read && totalCount(read.counts) > 0) found.push({ ...file, ...read })
    } catch {
      // 손상됐거나 SQLite 파일이 아니다 — 되돌릴 수 없으니 뺀다
    }
  }
  return found.sort((a, b) => b.createdAt - a.createdAt)
}

/**
 * 지금 작업 공간이 비었고 데이터가 남은 백업이 있으면 가장 최근 것을 돌려준다.
 * 비어 있지 않으면 백업을 열지 않는다 — 평소 시작에는 표 몇 개를 세는 비용뿐이다.
 * dismissedKey: 이미 「그대로 쓰기」를 고른 백업 — 같은 파일이면 다시 알리지 않는다.
 */
export function findRecoveryNotice(
  current: Database.Database,
  paths: RecoveryPaths,
  dismissedKey: string | null
): RecoverableBackup | null {
  removeRestoreTemps(paths.dbPath)
  if (totalCount(countWorkspace(current)) > 0) return null
  const [newest] = scanBackups(paths)
  if (!newest || newest.key === dismissedKey) return null
  return newest
}

const RESTORE_TEMP_PREFIX = '.restore-'

/** 되돌리기 도중 종료돼 데이터 폴더에 남은 DB 크기만 한 임시 파일 정리 */
function removeRestoreTemps(dbPath: string): void {
  const prefix = `${basename(dbPath)}${RESTORE_TEMP_PREFIX}`
  for (const name of listNames(dirname(dbPath))) {
    if (!name.startsWith(prefix) || !(name.endsWith('.tmp') || name.endsWith('.tmp-journal')))
      continue
    try {
      rmSync(join(dirname(dbPath), name), { force: true })
    } catch {
      // 다른 프로그램이 잡고 있으면 다음 기회에
    }
  }
}

/**
 * 고른 백업으로 nais3.db를 바꾼다. 성공하면 DB가 닫힌 채로 돌아온다 — 호출한 쪽이 앱을 다시 시작한다.
 * 실패하면 지금 DB를 그대로 둔 채 다시 열고(reopen) 오류를 던진다.
 *
 * 1. 백업을 읽기 전용으로 열어 데이터 폴더 안 임시 파일로 VACUUM INTO — 백업 원본은 바뀌지 않는다
 * 2. 지금 DB를 snapshotCurrent로 남긴다 (실패하면 아무것도 바꾸지 않는다)
 * 3. 지금 DB를 체크포인트하고 닫은 뒤 -wal/-shm을 지우고 임시 파일을 nais3.db 자리에 바꿔 단다.
 *    남은 -wal은 새 DB에 엉뚱하게 적용되므로 반드시 먼저 지운다
 *
 * 백업이 더 낮은 스키마면 다음 시작에서 평소 업데이트처럼 백업을 남기고 마이그레이션한다.
 */
export function restoreBackup(
  backup: RecoverableBackup,
  paths: RecoveryPaths,
  hooks: {
    current: () => Database.Database
    snapshotCurrent: () => void
    close: () => void
    reopen: () => void
  }
): void {
  removeRestoreTemps(paths.dbPath)
  const replacement = `${paths.dbPath}${RESTORE_TEMP_PREFIX}${randomUUID()}.tmp`
  try {
    withReadOnlyBackup(backup.path, (database) => {
      const version = database.pragma('user_version', { simple: true }) as number
      if (!isSupportedVersion(version)) throw new Error('이 앱이 열 수 없는 백업이에요')
      database.prepare('VACUUM INTO ?').run(replacement)
    })
    hooks.snapshotCurrent()
    hooks.current().pragma('wal_checkpoint(TRUNCATE)')
    hooks.close()
    try {
      const wal = `${paths.dbPath}-wal`
      // 깨끗이 닫혔으면 -wal은 지워졌거나 비어 있다. 내용이 남았다면 이 DB의 마지막 쓰기라 지우지 않는다
      if (existsSync(wal) && statSync(wal).size > 0)
        throw new Error('데이터베이스를 다른 곳에서 쓰고 있어 바꾸지 못했어요')
      rmSync(wal, { force: true })
      rmSync(`${paths.dbPath}-shm`, { force: true })
      renameSync(replacement, paths.dbPath)
    } catch (error) {
      // 바꿔 달기 전이면 원래 파일 그대로다 — 다시 열어 앱을 계속 쓸 수 있게 한다
      hooks.reopen()
      throw error
    }
  } finally {
    rmSync(replacement, { force: true })
  }
}
