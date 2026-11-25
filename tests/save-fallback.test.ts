import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import sharp from 'sharp'
import { afterAll, describe, expect, it, vi } from 'vitest'

const root = mkdtempSync(join(tmpdir(), 'atelier-save-fallback-'))
// 저장 폴더 자리에 파일이 있어 폴더를 만들 수 없다 (빠진 드라이브·막힌 폴더와 같은 경우)
const blocker = join(root, 'blocker')
writeFileSync(blocker, 'x')
let saveDir = join(blocker, 'out')

vi.mock('electron', () => ({ app: { getPath: () => root, getName: () => 'Atelier' } }))
vi.mock('../src/main/db/settings', () => ({
  getSetting: (key: string) =>
    key === 'save_dir' || key === 'scene_save_dir' ? saveDir : key === 'date_folders' ? '0' : null
}))
vi.mock('../src/main/db', () => ({
  getDb: () => ({
    prepare: () => ({ run: () => ({ lastInsertRowid: 1 }), get: () => undefined, all: () => [] }),
    transaction:
      <A extends unknown[], T>(fn: (...args: A) => T) =>
      (...args: A): T =>
        fn(...args)
  })
}))

afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('saving when the save folder cannot be written', () => {
  it('keeps the paid image in the app library instead of throwing it away', async () => {
    const { saveGeneratedImage } = await import('../src/main/images/storage')
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#fff' } })
      .png()
      .toBuffer()
    const base = { png, sentPayload: '{}', seed: 1 }
    const a = await saveGeneratedImage({ ...base, kind: 't2i' })
    const b = await saveGeneratedImage({ ...base, kind: 'scene', sceneId: 3, sceneName: '웃음' })
    for (const saved of [a, b]) {
      expect(saved.filePath.startsWith(join(root, 'unsaved-images'))).toBe(true)
      expect(existsSync(saved.filePath)).toBe(true)
    }

    // 폴더가 정상이면 원래 자리에 저장한다
    saveDir = join(root, 'ok')
    const c = await saveGeneratedImage({ ...base, kind: 't2i' })
    expect(c.filePath.startsWith(saveDir)).toBe(true)
  })
})
