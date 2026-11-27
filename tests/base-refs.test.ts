import type Database from 'better-sqlite3'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  normalizeBaseRefs,
  parseBaseRefs,
  refsWithBase,
  sceneOrPresetRefs,
  serializeBaseRefs
} from '../src/shared/base-refs'
import { planBaseRefs, type PlanSource } from '../src/main/claude-gen/base-refs-plan'

// better-sqlite3는 Electron용 빌드라 vitest에서 못 연다 — node:sqlite로 필요한 API만 흉내 낸다
let raw: DatabaseSync
function shim(): Database.Database {
  const api = {
    exec(sql: string) {
      raw.exec(sql)
      return api
    },
    prepare(sql: string) {
      const st = raw.prepare(sql)
      return {
        run: (...p: never[]) => st.run(...p),
        get: (...p: never[]) => st.get(...p),
        all: (...p: never[]) => st.all(...p)
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
      const run = (): T => {
        raw.exec('BEGIN')
        try {
          const r = fn()
          raw.exec('COMMIT')
          return r
        } catch (e) {
          raw.exec('ROLLBACK')
          throw e
        }
      }
      return Object.assign(run, { immediate: run, deferred: run })
    }
  }
  return api as unknown as Database.Database
}

vi.mock('electron', () => ({ BrowserWindow: {}, dialog: {} }))
vi.mock('../src/main/images/storage', () => ({ libraryRoot: () => 'C:/lib' }))
vi.mock('../src/main/db', () => ({ getDb: () => shim() }))

const A = { filePath: 'D:\\refs\\a.webp', refType: 'character' as const, strength: 2.5 }
const B = { filePath: 'D:\\refs\\b.png', refType: 'costume' as const, strength: 1 }

describe('기준 레퍼 규칙', () => {
  it('종류 기본 character, 강도 기본 2.5, 빈 목록은 지우기', () => {
    expect(normalizeBaseRefs([{ filePath: 'D:\\x\\y.webp' }])).toEqual({
      ok: true,
      refs: [{ filePath: 'D:\\x\\y.webp', refType: 'character', strength: 2.5 }]
    })
    expect(normalizeBaseRefs([])).toEqual({ ok: true, refs: null })
    expect(normalizeBaseRefs(null)).toEqual({ ok: true, refs: null })
  })

  it('잘못된 경로·종류·강도·장수는 거절한다', () => {
    expect(normalizeBaseRefs([{ filePath: 'rel/y.webp' }]).ok).toBe(false)
    expect(normalizeBaseRefs([{ filePath: 'D:\\y.gif' }]).ok).toBe(false)
    expect(normalizeBaseRefs([{ filePath: 'D:\\y.png', refType: 'delta' }]).ok).toBe(false)
    expect(normalizeBaseRefs([{ filePath: 'D:\\y.png', strength: 5.5 }]).ok).toBe(false)
    expect(normalizeBaseRefs(Array(5).fill({ filePath: 'D:\\y.png' })).ok).toBe(false)
  })

  it('DB 글은 깨졌으면 없음으로 읽는다', () => {
    expect(parseBaseRefs(serializeBaseRefs([A]))).toEqual([A])
    expect(parseBaseRefs('{oops')).toBeNull()
    expect(serializeBaseRefs([])).toBeNull()
  })

  it('씬 것이 있으면 씬 것, 없으면 프리셋 것', () => {
    expect(sceneOrPresetRefs([B], [A])).toEqual({ refs: [B], from: 'scene' })
    expect(sceneOrPresetRefs(null, [A])).toEqual({ refs: [A], from: 'preset' })
    expect(sceneOrPresetRefs([], null)).toBeNull()
  })

  it('기준 레퍼가 있으면 화면 레퍼 대신 싣고, 일회성 레퍼는 함께, 클로 요청은 받은 것만', () => {
    const once = {
      filePath: 'D:\\o.png',
      refType: 'character' as const,
      strength: 0.6,
      fidelity: 0.8
    }
    expect(refsWithBase(undefined, null, false)).toEqual({ extraCharRefs: [], screenRefs: true })
    expect(refsWithBase([once], [A], false)).toEqual({
      extraCharRefs: [once, { ...A, fidelity: 1 }],
      screenRefs: false
    })
    expect(refsWithBase([once], [A], true)).toEqual({ extraCharRefs: [once], screenRefs: false })
  })
})

describe('POST /base-refs 계획', () => {
  const source: PlanSource = {
    presets: [
      { id: 1, name: 'y01', folderId: 11 },
      { id: 2, name: 'y01', folderId: 12 },
      { id: 3, name: 'g1', folderId: 11 }
    ],
    folders: [
      { id: 10, name: '작품', collapsed: false, color: null, parentId: null },
      { id: 11, name: '작품 1부', collapsed: false, color: null, parentId: 10 },
      { id: 12, name: '다른 작품', collapsed: false, color: null, parentId: null }
    ],
    scenesOf: (presetId) =>
      presetId === 3
        ? [
            { id: 31, presetId: 3, name: 'SC_t1_34_a' },
            { id: 32, presetId: 3, name: 'SC_t1_52_a' }
          ]
        : [],
    fileExists: (p) => !p.includes('missing')
  }

  it('폴더 이름으로 겹치는 프리셋을 가르고, 씬·프리셋 변경을 만든다', () => {
    const plan = planBaseRefs(
      [
        { preset: 'y01', folder: '작품 1부', refs: [{ filePath: A.filePath }] },
        { preset: 'g1', folder: '작품', scene: 'SC_t1_52_a', refs: [B] },
        { presetId: 3, refs: null }
      ],
      source
    )
    expect(plan).toEqual({
      ok: true,
      changes: [
        { target: 'preset', id: 1, presetId: 1, label: 'y01', refs: [A] },
        { target: 'scene', id: 32, presetId: 3, label: 'g1 / SC_t1_52_a', refs: [B] },
        { target: 'preset', id: 3, presetId: 3, label: 'g1', refs: null }
      ]
    })
  })

  it('하나라도 틀리면 전부 거절하고 까닭을 모두 돌려준다', () => {
    const plan = planBaseRefs(
      [
        { preset: 'y01', refs: [A] },
        { preset: 'g1', scene: '없는 씬', refs: [A] },
        { preset: 'g1', refs: [{ filePath: 'D:\\missing.webp' }] },
        { preset: 'g1', scene: 'SC_t1_34_a', refs: [A] },
        { preset: 'g1', scene: 'SC_t1_34_a', refs: [A] }
      ],
      source
    )
    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.errors).toHaveLength(4)
    expect(plan.errors[0]).toContain('2개')
    expect(plan.errors[1]).toContain('없는 씬')
    expect(plan.errors[2]).toContain('missing.webp')
    expect(plan.errors[3]).toContain('두 번')
  })
})

describe('씬 저장소의 기준 레퍼 (v24)', () => {
  let dir: string
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'base-refs-'))
    raw = new DatabaseSync(join(dir, 't.db'))
    const { migrateDatabase } = await import('../src/main/db/migrate')
    const { migrations } = await import('../src/main/db/migrations')
    expect(migrateDatabase(shim(), migrations, { backupDir: join(dir, 'b') }).version).toBe(24)
  })
  afterAll(() => {
    raw.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('저장·읽기·씬 우선·복제가 기준 레퍼를 따라간다', async () => {
    const repo = await import('../src/main/scenes/repo')
    const presetId = repo.createPreset('g1')
    const s1 = repo.createScene(presetId, 'SC_t1_34')
    const s2 = repo.createScene(presetId, 'SC_t1_52')
    expect(repo.resolveSceneBaseRefs(s1)).toBeNull()

    expect(repo.setPresetBaseRefs(presetId, [A])).toBe(true)
    expect(repo.setSceneBaseRefs(s2, [B])).toBe(true)
    expect(repo.listPresets().find((p) => p.id === presetId)?.baseRefs).toEqual([A])
    expect(repo.listScenes(presetId).map((s) => s.baseRefs)).toEqual([null, [B]])
    expect(repo.getScene(s2)?.baseRefs).toEqual([B])
    expect(repo.resolveSceneBaseRefs(s1)).toEqual([A])
    expect(repo.resolveSceneBaseRefs(s2)).toEqual([B])

    const copy = repo.duplicateScene(s2)
    expect(repo.getScene(copy)?.baseRefs).toEqual([B])
    const [dupPreset] = repo.manageScenePresets([presetId], 'duplicate')
    expect(repo.listPresets().find((p) => p.id === dupPreset)?.baseRefs).toEqual([A])
    expect(repo.listScenes(dupPreset).map((s) => s.baseRefs)).toEqual([null, [B], [B]])

    // 씬 칸을 지우면 프리셋 것을 따른다
    repo.setSceneBaseRefs(s2, null)
    expect(repo.resolveSceneBaseRefs(s2)).toEqual([A])
    expect(repo.setSceneBaseRefs(99999, [A])).toBe(false)
  })
})
