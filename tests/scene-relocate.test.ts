import type Database from 'better-sqlite3'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { sqliteShim } from './fixtures/sqlite-shim'

let raw: DatabaseSync
let root = ''
const shim = (): Database.Database => sqliteShim(() => raw)

vi.mock('electron', () => ({ BrowserWindow: {}, dialog: {} }))
vi.mock('../src/main/db', () => ({ getDb: () => shim() }))
vi.mock('../src/main/images/storage', async () => {
  const { join: j } = await import('path')
  return {
    libraryRoot: () => j(root, '_library'),
    scenePresetDir: (p: string | null) => j(root, 'scenes', p ?? '기본'),
    sceneDir: (p: string | null, s: string) => j(root, 'scenes', p ?? '기본', s)
  }
})

function addImage(sceneId: number, path: string, onDisk = true): number {
  if (onDisk) {
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, 'img')
  }
  return Number(
    raw
      .prepare('INSERT INTO images (file_path, kind, scene_id) VALUES (?, ?, ?)')
      .run(path, 'scene', sceneId).lastInsertRowid
  )
}
const pathOf = (id: number): string =>
  (raw.prepare('SELECT file_path FROM images WHERE id = ?').get(id) as { file_path: string })
    .file_path

describe('씬 그림 폴더가 프리셋을 따라간다', () => {
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'relocate-'))
    raw = new DatabaseSync(join(root, 't.db'))
    const { migrateDatabase } = await import('../src/main/db/migrate')
    const { migrations } = await import('../src/main/db/migrations')
    migrateDatabase(shim(), migrations, { backupDir: join(root, 'b') })
  })
  afterAll(() => {
    raw.close()
    rmSync(root, { recursive: true, force: true })
  })

  it('씬을 다른 프리셋으로 옮기면 그림과 기록이 새 폴더로 간다 (겹치는 이름은 덮지 않는다)', async () => {
    const repo = await import('../src/main/scenes/repo')
    const from = repo.createPreset('클로 생성')
    const to = repo.createPreset('p01 주연')
    const scene = repo.createScene(from, 'SC_h01_01')
    const oldDir = join(root, 'scenes', '클로 생성', 'SC_h01_01')
    const newDir = join(root, 'scenes', 'p01 주연', 'SC_h01_01')
    const a = addImage(scene, join(oldDir, 'a.webp'))
    const b = addImage(scene, join(oldDir, 'b.webp'))
    // 옮긴 뒤 새 폴더에 이미 뽑힌 그림 (같은 이름 b.webp)
    const already = addImage(scene, join(newDir, 'b.webp'))
    const elsewhere = addImage(scene, join(root, '_library', 'scene', 'c.webp'))
    const gone = addImage(scene, join(oldDir, 'gone.webp'), false)
    raw.prepare('INSERT INTO library_images (file_path) VALUES (?)').run(join(oldDir, 'a.webp'))

    expect(repo.bulkMove([scene], to)).toEqual({ moved: 2, failed: 0 })
    expect(pathOf(a)).toBe(join(newDir, 'a.webp'))
    expect(pathOf(b)).toBe(join(newDir, 'b_2.webp'))
    expect(pathOf(already)).toBe(join(newDir, 'b.webp'))
    expect(pathOf(elsewhere)).toBe(join(root, '_library', 'scene', 'c.webp'))
    expect(pathOf(gone)).toBe(join(oldDir, 'gone.webp'))
    expect(readdirSync(newDir).sort()).toEqual(['a.webp', 'b.webp', 'b_2.webp'])
    expect(existsSync(oldDir)).toBe(false)
    expect(
      raw
        .prepare('SELECT file_path FROM library_images')
        .all()
        .map((r) => r.file_path)
    ).toEqual([join(newDir, 'a.webp')])
    expect(repo.getScene(scene)?.presetId).toBe(to)
  })

  it('프리셋 이름을 바꾸면 씬 폴더가 새 이름 아래로 가고 빈 옛 프리셋 폴더는 지운다', async () => {
    const repo = await import('../src/main/scenes/repo')
    const p = repo.createPreset('옛 이름')
    const s1 = repo.createScene(p, '씬1')
    const s2 = repo.createScene(p, '씬2')
    const i1 = addImage(s1, join(root, 'scenes', '옛 이름', '씬1', 'x.png'))
    const i2 = addImage(s2, join(root, 'scenes', '옛 이름', '씬2', 'y.png'))
    expect(repo.renamePreset(p, '새 이름')).toEqual({ moved: 2, failed: 0 })
    expect(pathOf(i1)).toBe(join(root, 'scenes', '새 이름', '씬1', 'x.png'))
    expect(pathOf(i2)).toBe(join(root, 'scenes', '새 이름', '씬2', 'y.png'))
    expect(existsSync(join(root, 'scenes', '옛 이름'))).toBe(false)
    expect(repo.getPresetName(p)).toBe('새 이름')
    // 같은 이름으로 바꾸면 아무것도 안 옮긴다
    expect(repo.renamePreset(p, '새 이름')).toEqual({ moved: 0, failed: 0 })
  })
})
