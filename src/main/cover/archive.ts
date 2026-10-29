import { app } from 'electron'
import { createHash } from 'crypto'
import { existsSync, promises as fsp } from 'fs'
import { join, resolve, sep } from 'path'
import sharp from 'sharp'
import type {
  CoverArchiveItem,
  CoverArchiveKind,
  CoverItem,
  CoverProject
} from '../../shared/cover'

/**
 * 표지 기록. 표지에 넣었던 그림·타이포·문구를 userData/cover/archive/<sha1>.<ext> 로 따로 보관한다.
 * 작품에서 빼거나 작품을 지워도 남아서, 업데이트·이식 때 이전 버전을 다시 꺼낼 수 있다.
 * 같은 그림은 내용 해시 하나로 묶고, 배경은 검열 마스크도 함께 보관한다.
 */

interface Entry {
  hash: string
  ext: string
  kind: CoverArchiveKind
  name: string
  width: number
  height: number
  maskHash: string | null
  projectId: string
  projectName: string
  addedAt: number
  usedAt: number
}

interface Index {
  v: 1
  entries: Entry[]
  /**
   * 작품 blob 키 → 해시. 한 번 본 키는 다시 읽지 않는다.
   * 사용자가 기록에서 뺀 그림은 키만 남아서, 같은 키로는 되살아나지 않는다 (새로 넣으면 다시 기록).
   */
  keys: Record<string, string>
}

export type BlobReader = (key: string) => Promise<Uint8Array | null>

const HASH_RE = /^[0-9a-f]{40}$/
const THUMB = 240

/** 배경과 타이포(문구 포함)는 같은 그림이어도 따로 기록한다 */
const slotOf = (kind: CoverArchiveKind): 'bg' | 'typo' => (kind === 'background' ? 'bg' : 'typo')
const entryId = (e: { hash: string; kind: CoverArchiveKind }): string =>
  e.hash + '-' + slotOf(e.kind)

const dir = (): string => join(app.getPath('userData'), 'cover', 'archive')
const thumbDir = (): string => join(dir(), 'thumbs')
const indexPath = (): string => join(dir(), 'index.json')
const imagePath = (e: Entry): string => join(dir(), e.hash + '.' + e.ext)
const maskPath = (hash: string): string => join(dir(), hash + '.png')
const thumbPath = (hash: string): string => join(thumbDir(), hash + '.webp')

let index: Index | null = null
let chain: Promise<unknown> = Promise.resolve()
let backfilled = false
const thumbCache = new Map<string, string>()

function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.catch(() => {}).then(fn)
  chain = next
  return next
}

const isStr = (v: unknown): v is string => typeof v === 'string'
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const KINDS = new Set<CoverArchiveKind>(['background', 'typo', 'phrase'])

function parseEntry(v: unknown): Entry | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  if (!isStr(o.hash) || !HASH_RE.test(o.hash)) return null
  if (!isStr(o.ext) || !/^(png|jpg|webp|gif|bmp)$/.test(o.ext)) return null
  if (!KINDS.has(o.kind as CoverArchiveKind)) return null
  if (!isNum(o.width) || !isNum(o.height)) return null
  return {
    hash: o.hash,
    ext: o.ext,
    kind: o.kind as CoverArchiveKind,
    name: isStr(o.name) ? o.name : '',
    width: o.width,
    height: o.height,
    maskHash: isStr(o.maskHash) && HASH_RE.test(o.maskHash) ? o.maskHash : null,
    projectId: isStr(o.projectId) ? o.projectId : '',
    projectName: isStr(o.projectName) ? o.projectName : '',
    addedAt: isNum(o.addedAt) ? o.addedAt : 0,
    usedAt: isNum(o.usedAt) ? o.usedAt : 0
  }
}

async function load(): Promise<Index> {
  if (index) return index
  await fsp.mkdir(thumbDir(), { recursive: true })
  let next: Index = { v: 1, entries: [], keys: {} }
  try {
    const raw = JSON.parse(await fsp.readFile(indexPath(), 'utf8')) as Record<string, unknown>
    const entries = Array.isArray(raw.entries)
      ? raw.entries.map(parseEntry).filter((e): e is Entry => e !== null)
      : []
    const keys: Record<string, string> = {}
    if (raw.keys && typeof raw.keys === 'object') {
      for (const [k, h] of Object.entries(raw.keys as Record<string, unknown>))
        if (isStr(h) && HASH_RE.test(h)) keys[k] = h
    }
    next = { v: 1, entries, keys }
  } catch {
    // 처음이거나 깨진 색인: 빈 기록으로 시작 (보관 파일은 지우지 않는다)
  }
  index = next
  return next
}

async function persist(idx: Index): Promise<void> {
  const tmp = indexPath() + '.' + process.pid + '.' + Date.now() + '.tmp'
  await fsp.writeFile(tmp, JSON.stringify(idx))
  try {
    await fsp.rename(tmp, indexPath())
  } catch (e) {
    await fsp.rm(tmp, { force: true }).catch(() => {})
    throw e
  }
}

function sniffExt(b: Uint8Array): string | null {
  if (b.length < 12) return null
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png'
  if (b[0] === 0xff && b[1] === 0xd8) return 'jpg'
  if (
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 &&
    b[8] === 0x57 &&
    b[9] === 0x45
  )
    return 'webp'
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'gif'
  if (b[0] === 0x42 && b[1] === 0x4d) return 'bmp'
  return null
}

const sha1 = (b: Uint8Array): string => createHash('sha1').update(b).digest('hex')

async function writeIfMissing(path: string, bytes: Uint8Array): Promise<void> {
  if (existsSync(path)) return
  const tmp = path + '.' + process.pid + '.tmp'
  await fsp.writeFile(tmp, bytes)
  await fsp.rename(tmp, path).catch(async () => {
    await fsp.rm(tmp, { force: true }).catch(() => {})
  })
}

async function makeThumb(hash: string, bytes: Uint8Array): Promise<void> {
  const out = thumbPath(hash)
  if (existsSync(out)) return
  try {
    await sharp(bytes, { animated: false })
      .resize(THUMB, THUMB, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82 })
      .toFile(out)
  } catch {
    // 썸네일이 없어도 기록은 남긴다 (화면은 빈 칸으로 보여 준다)
  }
}

/** 작품 하나를 훑어 처음 보는 그림을 보관한다. 기록이 바뀌었으면 true */
async function record(p: CoverProject, read: BlobReader, now: number): Promise<boolean> {
  const idx = await load()
  const byId = new Map(idx.entries.map((e) => [entryId(e), e]))
  /** 이번에 타이포로 본 기록 (같은 그림이 문구로도 쓰이면 타이포로 둔다) */
  const seenAsTypo = new Set<string>()
  let changed = false

  const resolveKey = async (key: string): Promise<{ hash: string; bytes?: Uint8Array } | null> => {
    const known = idx.keys[key]
    if (known) return { hash: known }
    const bytes = await read(key)
    if (!bytes || bytes.byteLength === 0) return null
    const hash = sha1(bytes)
    idx.keys[key] = hash
    changed = true
    return { hash, bytes }
  }

  const visit = async (
    item: CoverItem,
    kind: CoverArchiveKind,
    maskKey?: string | null
  ): Promise<void> => {
    const r = await resolveKey(item.blobKey)
    if (!r) return
    const id = entryId({ hash: r.hash, kind })
    let e = byId.get(id)
    if (!e) {
      // 아는 키인데 기록이 없으면 사용자가 뺀 것 — 되살리지 않는다
      if (!r.bytes) return
      const ext = sniffExt(r.bytes)
      if (!ext) return
      e = {
        hash: r.hash,
        ext,
        kind,
        name: item.name,
        width: item.width,
        height: item.height,
        maskHash: null,
        projectId: p.id,
        projectName: p.name,
        addedAt: now,
        usedAt: now
      }
      await writeIfMissing(imagePath(e), r.bytes)
      await makeThumb(r.hash, r.bytes)
      idx.entries.push(e)
      byId.set(id, e)
      changed = true
    } else if (r.bytes && e.projectId !== p.id) {
      // 같은 그림을 다른 작품에 새로 넣었다 → 그 작품 기록으로 옮긴다
      e.projectId = p.id
      e.usedAt = now
      changed = true
    }
    if (e.projectId !== p.id) return
    const nextKind = kind === 'phrase' && seenAsTypo.has(id) ? 'typo' : kind
    if (kind === 'typo') seenAsTypo.add(id)
    if (e.name !== item.name || e.projectName !== p.name || e.kind !== nextKind) {
      e.name = item.name
      e.projectName = p.name
      e.kind = nextKind
      changed = true
    }
    if (kind !== 'background') return
    let maskHash: string | null = null
    if (maskKey) {
      const m = await resolveKey(maskKey)
      if (m) {
        maskHash = m.hash
        if (m.bytes) await writeIfMissing(maskPath(m.hash), m.bytes)
      }
    }
    if (maskHash !== e.maskHash) {
      e.maskHash = maskHash
      changed = true
    }
  }

  for (const b of p.backgrounds) await visit(b, 'background', b.maskKey)
  for (const t of p.typos) await visit(t, 'typo')
  for (const t of p.typos) for (const x of t.extras ?? []) await visit(x, 'phrase')
  return changed
}

/** 저장할 때마다 부른다. 기록이 바뀌었으면 true */
export function recordCoverProject(p: CoverProject, read: BlobReader): Promise<boolean> {
  return serial(async () => {
    const idx = await load()
    const changed = await record(p, read, Date.now())
    if (changed) await persist(idx)
    return changed
  })
}

/** 기능이 생기기 전 작품들도 한 번 훑는다 (오래된 작품부터, 최근 작품이 이긴다) */
export function backfillCoverArchive(projects: CoverProject[], read: BlobReader): Promise<void> {
  if (backfilled) return Promise.resolve()
  backfilled = true
  return serial(async () => {
    const idx = await load()
    let changed = false
    for (const p of [...projects].sort((a, b) => a.updatedAt - b.updatedAt)) {
      if (await record(p, read, p.updatedAt || Date.now())) changed = true
    }
    if (changed) await persist(idx)
  })
}

async function thumbOf(hash: string): Promise<string> {
  const hit = thumbCache.get(hash)
  if (hit !== undefined) return hit
  const b64 = await fsp
    .readFile(thumbPath(hash))
    .then((b) => b.toString('base64'))
    .catch(() => '')
  if (b64) thumbCache.set(hash, b64)
  return b64
}

export function listCoverArchive(): Promise<CoverArchiveItem[]> {
  return serial(async () => {
    const idx = await load()
    const keysOf = new Map<string, string[]>()
    for (const [k, h] of Object.entries(idx.keys)) {
      const arr = keysOf.get(h)
      if (arr) arr.push(k)
      else keysOf.set(h, [k])
    }
    const out: CoverArchiveItem[] = []
    for (const e of idx.entries) {
      const path = imagePath(e)
      if (!existsSync(path)) continue
      const mask = e.maskHash ? maskPath(e.maskHash) : null
      out.push({
        id: entryId(e),
        hash: e.hash,
        kind: e.kind,
        name: e.name,
        width: e.width,
        height: e.height,
        path,
        maskPath: mask && existsSync(mask) ? mask : null,
        thumb: await thumbOf(e.hash),
        projectId: e.projectId,
        projectName: e.projectName,
        addedAt: e.addedAt,
        usedAt: e.usedAt,
        blobKeys: keysOf.get(e.hash) ?? []
      })
    }
    return out.sort((a, b) => b.usedAt - a.usedAt || b.addedAt - a.addedAt)
  })
}

export function deleteCoverArchive(id: string): Promise<void> {
  return serial(async () => {
    const idx = await load()
    const e = idx.entries.find((x) => entryId(x) === id)
    if (!e) return
    const hash = e.hash
    idx.entries = idx.entries.filter((x) => x !== e)
    await persist(idx)
    // 같은 그림을 배경·타이포 양쪽에 기록했으면 보관본은 남긴다
    if (!idx.entries.some((x) => x.hash === hash)) {
      thumbCache.delete(hash)
      await fsp.rm(imagePath(e), { force: true })
      await fsp.rm(thumbPath(hash), { force: true })
    }
    if (e.maskHash && !idx.entries.some((x) => x.maskHash === e.maskHash))
      await fsp.rm(maskPath(e.maskHash), { force: true })
  })
}

/** 보관본을 표지로 다시 가져올 때 원래 이름을 쓴다 */
export async function coverArchiveName(path: string): Promise<string | null> {
  const base = resolve(dir())
  const full = resolve(path)
  if (!full.startsWith(base + sep)) return null
  const idx = await load()
  const e = idx.entries.find((x) => resolve(imagePath(x)) === full)
  return e ? e.name : null
}
