import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import JSZip from 'jszip'
import { afterAll, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir(), getName: () => 'Atelier' },
  BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
  dialog: {},
  shell: {}
}))
vi.mock('../src/main/db', () => ({ getDb: () => ({}) }))

const dir = mkdtempSync(join(tmpdir(), 'atelier-import-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('scene JSON import', () => {
  it('says what is wrong with a broken or foreign file', async () => {
    const { parseScenesJson } = await import('../src/main/scenes/repo')
    expect(parseScenesJson('{"scenes": [')).toEqual({ error: expect.stringContaining('JSON') })
    expect(parseScenesJson('{"foo": 1}')).toEqual({ error: expect.stringContaining('scenes') })
    expect(parseScenesJson('{"scenes": [1]}')).toEqual({ error: expect.stringContaining('1번째') })
  })

  it('reads a good file (BOM allowed) and fixes sizes to multiples of 64', async () => {
    const { parseScenesJson } = await import('../src/main/scenes/repo')
    const r = parseScenesJson(
      '﻿{"name":"p","scenes":[{"name":"a","prompt":"x","width":1000,"height":"big"}]}'
    )
    expect(r).toEqual({
      name: 'p',
      scenes: [expect.objectContaining({ name: 'a', prompt: 'x', width: 1024, height: 1216 })]
    })
  })
})

describe('fragment TXT/ZIP import', () => {
  it('reads nothing when one zip is broken, and names the file', async () => {
    const { readFragmentFiles } = await import('../src/main/fragments/repo')
    const ok = join(dir, 'hair.txt')
    writeFileSync(ok, 'long hair\nshort hair')
    const bad = join(dir, 'broken.zip')
    writeFileSync(bad, 'not a zip')
    expect(await readFragmentFiles([ok, bad])).toEqual({
      error: expect.stringContaining('broken.zip')
    })
  })

  it('reads txt files inside a good zip', async () => {
    const { readFragmentFiles } = await import('../src/main/fragments/repo')
    const zip = new JSZip()
    zip.file('outfit.txt', 'dress')
    zip.file('readme.md', 'skip')
    const good = join(dir, 'good.zip')
    writeFileSync(good, await zip.generateAsync({ type: 'nodebuffer' }))
    expect(await readFragmentFiles([good])).toEqual({
      items: [{ name: 'outfit', content: 'dress' }]
    })
  })
})
