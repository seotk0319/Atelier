import type Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { migrateDatabase } from '../src/main/db/migrate'
import { migrations } from '../src/main/db/migrations'

const store = vi.hoisted(() => ({ db: null as unknown, dir: '' }))
vi.mock('electron', () => ({ safeStorage: {}, app: { getPath: () => store.dir } }))
vi.mock('../src/main/db/index', () => ({ getDb: () => store.db }))
vi.mock('../src/main/db', () => ({ getDb: () => store.db }))
vi.mock('../src/main/images/storage', () => ({ imagesRoot: () => store.dir }))

import { exportAll, importAll } from '../src/main/backup/repo'

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
        run: (...p: never[]) => statement.run(...p),
        get: (...p: never[]) => statement.get(...p),
        all: (...p: never[]) => statement.all(...p)
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
      return Object.assign(run('DEFERRED'), { immediate: run('IMMEDIATE') })
    }
  }
  return api as unknown as Database.Database
}

let raw: DatabaseSync
beforeEach(() => {
  store.dir = mkdtempSync(join(tmpdir(), 'atelier-import-'))
  raw = new DatabaseSync(join(store.dir, 'nais3.db'))
  store.db = wrap(raw)
  migrateDatabase(store.db as Database.Database, migrations, { backupDir: join(store.dir, 'b') })
  raw.exec('PRAGMA foreign_keys = ON')
})
afterEach(() => {
  raw.close()
  rmSync(store.dir, { recursive: true, force: true })
})

const sceneOf = (imageId: number): unknown =>
  (raw.prepare('SELECT scene_id FROM images WHERE id = ?').get(imageId) as { scene_id: unknown })
    .scene_id

describe('백업 가져오기 (importAll)', () => {
  it('같은 씬이면 히스토리 그림의 씬 연결을 다시 잇고, 바뀐 씬 번호를 돌려준다', () => {
    raw.exec(`
      INSERT INTO gen_scenes (id, preset_id, name, created_at) VALUES (10, 1, 'a', '2026-01-01 00:00:00');
      INSERT INTO gen_scenes (id, preset_id, name, created_at) VALUES (11, 1, 'b', '2026-01-02 00:00:00');
      INSERT INTO images (id, file_path, kind, seed, scene_id) VALUES (1, 'a.png', 'scene', 1, 10);
      INSERT INTO images (id, file_path, kind, seed, scene_id) VALUES (2, 'b.png', 'scene', 2, 11);
    `)
    const backup = exportAll()
    // 백업 뒤 씬 11은 지우고 같은 번호로 다른 씬을 만들었다
    raw.exec(`
      DELETE FROM gen_scenes WHERE id = 11;
      INSERT INTO gen_scenes (id, preset_id, name, created_at) VALUES (11, 1, 'c', '2026-02-01 00:00:00');
      UPDATE images SET scene_id = 11 WHERE id = 2;
    `)

    const result = importAll(backup)
    expect(sceneOf(1)).toBe(10) // 같은 씬 — 다시 이어짐
    expect(sceneOf(2)).toBeNull() // 다른 씬이 된 번호 — 엉뚱한 씬에 붙이지 않는다
    expect(result.replacedSceneIds).toEqual([11])
  })

  it('백업에 없는 표는 비우지 않는다', () => {
    raw.exec(`INSERT INTO scene_preset_folders (id, name, sort_order) VALUES (5, 'keep', 0)`)
    const backup = exportAll() as { tables: Record<string, unknown> }
    delete backup.tables.scene_preset_folders // 폴더가 생기기 전 백업
    importAll(backup)
    expect(raw.prepare('SELECT name FROM scene_preset_folders').all()).toEqual([{ name: 'keep' }])
  })

  it('빈 백업은 거절하고 아무것도 지우지 않는다', () => {
    raw.exec(
      `INSERT INTO prompt_presets (name, prompt, negative_prompt, sort_order) VALUES ('keep', 'x', '', 0)`
    )
    expect(() =>
      importAll({ _app: 'NAIS3', tables: { prompt_presets: [], gen_scenes: [] } })
    ).toThrow('백업에 가져올 항목이 없어요')
    expect(raw.prepare('SELECT name FROM prompt_presets').all()).toEqual([{ name: 'keep' }])
  })

  it('지금 표에 없는 열(새 판 백업)은 빼고 넣는다', () => {
    const backup = exportAll() as { tables: Record<string, Record<string, unknown>[]> }
    backup.tables.prompt_presets = [
      { id: 7, name: 'from-newer', prompt: 'p', negative_prompt: '', sort_order: 0, future_col: 1 }
    ]
    importAll(backup)
    expect(raw.prepare('SELECT id, name FROM prompt_presets').all()).toEqual([
      { id: 7, name: 'from-newer' }
    ])
  })
})
