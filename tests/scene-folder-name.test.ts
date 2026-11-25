import { join } from 'path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => 'C:/userdata', getName: () => 'Atelier' } }))
vi.mock('../src/main/db/settings', () => ({
  getSetting: (key: string) => (key === 'scene_save_dir' ? 'C:/scenes' : null)
}))
vi.mock('../src/main/db', () => ({ getDb: () => ({}) }))

describe('scene folder names', () => {
  it('keeps "." and ".." scene/preset names inside the scene root', async () => {
    const { sceneDir, scenePresetDir } = await import('../src/main/images/storage')
    expect(sceneDir('프리셋', '..', 7)).toBe(join('C:/scenes', '프리셋', '씬-7'))
    expect(sceneDir('프리셋', '.', 7)).toBe(join('C:/scenes', '프리셋', '씬-7'))
    expect(scenePresetDir('..')).toBe(join('C:/scenes', '기본'))
  })

  it('drops trailing dots and spaces and avoids Windows device names', async () => {
    const { sceneDir } = await import('../src/main/images/storage')
    expect(sceneDir('p', '웃음. ', 1)).toBe(join('C:/scenes', 'p', '웃음'))
    expect(sceneDir('p', 'CON', 1)).toBe(join('C:/scenes', 'p', '_CON'))
    expect(sceneDir('p', 'nul.txt', 1)).toBe(join('C:/scenes', 'p', '_nul.txt'))
    expect(sceneDir('p', 'console', 1)).toBe(join('C:/scenes', 'p', 'console'))
  })
})
