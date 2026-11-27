import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmdirSync,
  unlinkSync
} from 'fs'
import { basename, dirname, extname, join, resolve } from 'path'
import { getDb } from '../db'

/**
 * 씬 그림 폴더 옮기기. 씬 폴더는 scenesRoot/{프리셋 이름}/{씬 이름}이라
 * 씬을 다른 프리셋으로 옮기거나 프리셋 이름을 바꾸면 폴더도 따라 옮겨야 「폴더 열기」와 실제 그림이 이어진다.
 *
 * - 그 씬의 DB 그림(images.scene_id) 중 옛 씬 폴더에 바로 들어 있는 파일만 옮긴다.
 *   다른 곳(라이브러리 내부 폴더 등)에 있는 그림과 디스크에 없는 기록은 그대로 둔다.
 * - 새 폴더에 같은 이름이 있으면 덮지 않고 「_2」를 붙인다.
 * - 경로가 바뀐 그림은 images·library_images의 file_path를 맞춘다.
 * - 다 옮겨 빈 옛 폴더는 지운다 (비어 있을 때만).
 */

export interface SceneFolderMove {
  sceneId: number
  fromDir: string
  toDir: string
}

export interface RelocateResult {
  moved: number
  failed: number
}

/** 윈도는 대소문자를 가리지 않는다 */
export function samePath(a: string, b: string): boolean {
  const norm = (p: string): string => {
    const r = resolve(p).replace(/[\\/]+$/, '')
    return process.platform === 'win32' ? r.toLowerCase() : r
  }
  return norm(a) === norm(b)
}

/** dir 안에서 쓰지 않은 파일 이름 — 있으면 「이름_2.확장자」, 「이름_3.확장자」… */
export function freeName(dir: string, name: string, taken: (path: string) => boolean): string {
  const first = join(dir, name)
  if (!taken(first)) return first
  const ext = extname(name)
  const stem = name.slice(0, name.length - ext.length)
  for (let n = 2; ; n++) {
    const next = join(dir, `${stem}_${n}${ext}`)
    if (!taken(next)) return next
  }
}

function moveFile(from: string, to: string): void {
  try {
    renameSync(from, to)
  } catch (e) {
    // 다른 드라이브로는 rename이 안 된다 — 복사 뒤 지운다
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e
    copyFileSync(from, to)
    unlinkSync(from)
  }
}

/** 비었으면 지운다. 하나라도 남아 있으면 두고 false */
export function removeIfEmpty(dir: string): boolean {
  try {
    if (readdirSync(dir).length > 0) return false
    rmdirSync(dir)
    return true
  } catch {
    return false
  }
}

export function relocateSceneImages(moves: SceneFolderMove[]): RelocateResult {
  const db = getDb()
  const rowsOf = db.prepare('SELECT id, file_path FROM images WHERE scene_id = ?')
  const inDb = db.prepare('SELECT 1 FROM images WHERE file_path = ?')
  const setImage = db.prepare('UPDATE images SET file_path = ? WHERE id = ?')
  const setLibrary = db.prepare('UPDATE library_images SET file_path = ? WHERE file_path = ?')
  const result: RelocateResult = { moved: 0, failed: 0 }
  for (const move of moves) {
    if (samePath(move.fromDir, move.toDir)) continue
    const rows = (rowsOf.all(move.sceneId) as { id: number; file_path: string }[]).filter(
      (r) => samePath(dirname(r.file_path), move.fromDir) && existsSync(r.file_path)
    )
    if (rows.length === 0) continue
    mkdirSync(move.toDir, { recursive: true })
    for (const row of rows) {
      const target = freeName(
        move.toDir,
        basename(row.file_path),
        (p) => existsSync(p) || Boolean(inDb.get(p))
      )
      try {
        moveFile(row.file_path, target)
      } catch {
        // 잠긴 파일 등 — 옛 자리와 옛 기록을 그대로 둔다
        result.failed++
        continue
      }
      // 파일은 이미 옮겼다 — 기록이 실패하면 파일을 되돌린다
      try {
        db.transaction(() => {
          setImage.run(target, row.id)
          setLibrary.run(target, row.file_path)
        })()
        result.moved++
      } catch {
        try {
          moveFile(target, row.file_path)
        } catch {
          // 되돌리지도 못하면 남은 기록이 없는 파일이 된다 — 아래 실패 수로 알린다
        }
        result.failed++
      }
    }
    removeIfEmpty(move.fromDir)
  }
  return result
}
