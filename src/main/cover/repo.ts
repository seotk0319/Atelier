import { app, BrowserWindow, dialog, shell } from 'electron'
import { randomUUID } from 'crypto'
import { promises as fsp } from 'fs'
import { basename, extname, join, resolve, sep } from 'path'
import {
  cleanCoverName,
  coverBlobKeys,
  isCoverKey,
  newCoverProject,
  normalizeCoverProject,
  type CoverProject,
  type CoverProjectSummary
} from '../../shared/cover'
import { getSetting, setSetting } from '../db/settings'
import {
  backfillCoverArchive,
  coverArchiveName,
  listCoverArchive,
  recordCoverProject
} from './archive'
import type { CoverArchiveItem } from '../../shared/cover'

/**
 * 표지 작품 저장소. userData/cover/projects/<id>.json + userData/cover/blobs/<key>.
 * 키는 COVER_KEY_RE 로만 받고, 출력은 사용자가 고른 폴더 아래에만 쓴다.
 */

const OUTPUT_DIR_KEY = 'cover_output_dir'
const IMPORT_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'])
const MAX_BLOB = 256 * 1024 * 1024
/** 저장 전(디바운스 중)인 새 이미지가 지워지지 않게, 이보다 오래된 고아 blob 만 정리 */
const ORPHAN_AGE_MS = 60 * 60 * 1000

const root = (): string => join(app.getPath('userData'), 'cover')
const projectsDir = (): string => join(root(), 'projects')
const blobsDir = (): string => join(root(), 'blobs')

function projectPath(id: string): string {
  if (!isCoverKey(id)) throw new Error('잘못된 작품 키')
  return join(projectsDir(), id + '.json')
}

function blobPath(key: string): string {
  if (!isCoverKey(key)) throw new Error('잘못된 이미지 키')
  return join(blobsDir(), key)
}

/** 표지 기록이 작품 속 blob 을 읽을 때 */
async function readBlob(key: string): Promise<Uint8Array | null> {
  if (!isCoverKey(key)) return null
  return fsp.readFile(blobPath(key)).catch(() => null)
}

async function ensureDirs(): Promise<void> {
  await fsp.mkdir(projectsDir(), { recursive: true })
  await fsp.mkdir(blobsDir(), { recursive: true })
}

async function atomicWrite(path: string, data: string | Uint8Array): Promise<void> {
  const tmp = path + '.' + process.pid + '.' + Date.now() + '.tmp'
  await fsp.writeFile(tmp, data)
  try {
    await fsp.rename(tmp, path)
  } catch (e) {
    await fsp.rm(tmp, { force: true }).catch(() => {})
    throw e
  }
}

/** 같은 작품 저장이 겹치면 순서대로 (마지막 저장이 이긴다) */
const writeChains = new Map<string, Promise<unknown>>()
function serial<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = writeChains.get(id) ?? Promise.resolve()
  const next = prev.catch(() => {}).then(fn)
  writeChains.set(id, next)
  void next.finally(() => {
    if (writeChains.get(id) === next) writeChains.delete(id)
  })
  return next
}

async function readProject(id: string): Promise<CoverProject | null> {
  try {
    const raw = JSON.parse(await fsp.readFile(projectPath(id), 'utf8')) as unknown
    return normalizeCoverProject(raw)
  } catch {
    return null
  }
}

async function allProjects(): Promise<CoverProject[]> {
  await ensureDirs()
  const names = await fsp.readdir(projectsDir())
  const out: CoverProject[] = []
  for (const n of names) {
    if (!n.endsWith('.json')) continue
    const id = n.slice(0, -5)
    if (!isCoverKey(id)) continue
    const p = await readProject(id)
    if (p) out.push(p)
  }
  return out
}

let gcDone = false
async function gcOrphans(projects: CoverProject[]): Promise<void> {
  if (gcDone) return
  gcDone = true
  const used = new Set(projects.flatMap(coverBlobKeys))
  const now = Date.now()
  for (const n of await fsp.readdir(blobsDir())) {
    if (!isCoverKey(n) || used.has(n)) continue
    const st = await fsp.stat(join(blobsDir(), n)).catch(() => null)
    if (st && now - st.mtimeMs > ORPHAN_AGE_MS) await fsp.rm(join(blobsDir(), n), { force: true })
  }
}

export async function listCoverProjects(): Promise<CoverProjectSummary[]> {
  const projects = await allProjects()
  void gcOrphans(projects).catch(() => {})
  void backfillCoverArchive(projects, readBlob).catch(() => {})
  return projects
    .map((p) => ({
      id: p.id,
      name: p.name,
      updatedAt: p.updatedAt,
      backgrounds: p.backgrounds.length,
      typos: p.typos.length
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

/** 표지 기록. 기능이 생기기 전 작품들을 다 훑은 뒤에 돌려준다 */
export async function coverArchiveItems(): Promise<CoverArchiveItem[]> {
  await backfillCoverArchive(await allProjects(), readBlob).catch(() => {})
  return listCoverArchive()
}

export async function createCoverProject(name: string): Promise<CoverProject> {
  await ensureDirs()
  const p = newCoverProject(randomUUID(), name.trim() || '새 작품')
  await serial(p.id, () => atomicWrite(projectPath(p.id), JSON.stringify(p)))
  return p
}

export async function loadCoverProject(id: string): Promise<CoverProject | null> {
  if (!isCoverKey(id)) return null
  return readProject(id)
}

export async function saveCoverProject(
  project: unknown
): Promise<{ updatedAt: number; archiveChanged: boolean }> {
  const p = normalizeCoverProject(project)
  if (!p) throw new Error('작품 형식이 올바르지 않아요')
  p.updatedAt = Date.now()
  await ensureDirs()
  await serial(p.id, () => atomicWrite(projectPath(p.id), JSON.stringify(p)))
  // 표지에 넣었던 그림은 작품에서 빼도 남도록 따로 보관 (실패해도 저장은 성공)
  const archiveChanged = await recordCoverProject(p, readBlob).catch(() => false)
  return { updatedAt: p.updatedAt, archiveChanged }
}

export async function deleteCoverProject(id: string): Promise<void> {
  if (!isCoverKey(id)) return
  await serial(id, async () => {
    const p = await readProject(id)
    await fsp.rm(projectPath(id), { force: true })
    if (p) for (const k of coverBlobKeys(p)) await fsp.rm(blobPath(k), { force: true })
  })
}

export async function putCoverBlob(bytes: Uint8Array): Promise<{ key: string }> {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) throw new Error('빈 이미지')
  if (bytes.byteLength > MAX_BLOB) throw new Error('이미지가 너무 커요')
  await ensureDirs()
  const key = randomUUID()
  await atomicWrite(blobPath(key), bytes)
  return { key }
}

/** 라이브러리·GPT·탐색기에서 끌어온 파일을 blob 으로 복사한다 */
export async function importCoverPaths(
  paths: string[]
): Promise<{ items: { key: string; name: string }[]; failed: number }> {
  await ensureDirs()
  const items: { key: string; name: string }[] = []
  let failed = 0
  for (const p of Array.isArray(paths) ? paths : []) {
    try {
      if (typeof p !== 'string' || !IMPORT_EXT.has(extname(p).toLowerCase())) throw new Error()
      const st = await fsp.stat(p)
      if (!st.isFile() || st.size === 0 || st.size > MAX_BLOB) throw new Error()
      const key = randomUUID()
      await fsp.copyFile(p, blobPath(key))
      const name = (await coverArchiveName(p).catch(() => null)) ?? basename(p, extname(p))
      items.push({ key, name })
    } catch {
      failed++
    }
  }
  return { items, failed }
}

export async function getCoverBlob(key: string): Promise<Uint8Array | null> {
  if (!isCoverKey(key)) return null
  try {
    return await fsp.readFile(blobPath(key))
  } catch {
    return null
  }
}

export async function deleteCoverBlobs(keys: string[]): Promise<void> {
  for (const k of Array.isArray(keys) ? keys : []) {
    if (isCoverKey(k)) await fsp.rm(blobPath(k), { force: true })
  }
}

// ───────────── 출력 폴더 ─────────────

export function coverOutputDir(): string | null {
  return getSetting(OUTPUT_DIR_KEY)?.trim() || null
}

export async function pickCoverOutputDir(): Promise<string | null> {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  const cur = coverOutputDir()
  const result = await dialog.showOpenDialog(win, {
    title: '표지를 저장할 폴더',
    defaultPath: cur ?? undefined,
    properties: ['openDirectory', 'createDirectory']
  })
  if (result.canceled || !result.filePaths[0]) return null
  setSetting(OUTPUT_DIR_KEY, result.filePaths[0])
  return result.filePaths[0]
}

function safeSegment(s: unknown): string {
  if (typeof s !== 'string' || !s || s !== cleanCoverName(s) || s === '.' || s === '..') {
    throw new Error('잘못된 파일 이름')
  }
  return s
}

/** 사용자가 고른 출력 폴더(설정에 저장된 것) 아래 folder/file 에만 쓴다 */
export async function writeCoverOutput(req: {
  folder: string
  file: string
  bytes: Uint8Array
}): Promise<{ path: string }> {
  const dir = coverOutputDir()
  if (!dir) throw new Error('저장 폴더를 먼저 골라 주세요')
  const folder = safeSegment(req.folder)
  const file = safeSegment(req.file)
  if (!/\.(png|webp)$/i.test(file)) throw new Error('png·webp 만 저장할 수 있어요')
  if (!(req.bytes instanceof Uint8Array) || req.bytes.byteLength === 0) throw new Error('빈 파일')
  const base = resolve(dir)
  const target = resolve(base, folder, file)
  if (!target.startsWith(base + sep)) throw new Error('저장 폴더 밖에는 쓸 수 없어요')
  await fsp.mkdir(resolve(base, folder), { recursive: true })
  await atomicWrite(target, req.bytes)
  return { path: target }
}

export async function openCoverOutput(folder?: string): Promise<boolean> {
  const dir = coverOutputDir()
  if (!dir) return false
  const base = resolve(dir)
  let target = base
  if (folder) {
    const t = resolve(base, safeSegment(folder))
    const exists = await fsp
      .stat(t)
      .then((s) => s.isDirectory())
      .catch(() => false)
    if (t.startsWith(base + sep) && exists) target = t
  }
  await fsp.mkdir(target, { recursive: true }).catch(() => {})
  return (await shell.openPath(target)) === ''
}
