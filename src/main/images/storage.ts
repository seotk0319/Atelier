import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { createHash, randomUUID } from 'crypto'
import { extname, join, resolve } from 'path'
import sharp from 'sharp'
import type { DirectorMethod, HistoryItem, ImageMetadata } from '../../shared/types'
import { getDb } from '../db'
import { getSetting } from '../db/settings'
import { localDateRange } from '../library/repo'
import { sanitizeImageMetadata } from './strip-metadata'

/**
 * 생성 이미지 저장 규칙 (P3의 핵심):
 * - 원본 PNG는 디스크 파일로만. base64를 어디에도 상주시키지 않는다.
 * - DB에는 경로·시드·전송 payload 원본·소형 썸네일(webp BLOB)만.
 */

export interface SavedImage extends HistoryItem {}

/** 기본 저장 폴더 (설정 미지정 시) */
export function defaultImagesRoot(): string {
  return join(app.getPath('pictures'), app.getName())
}

/**
 * 메인 모드 저장 폴더.
 * - 미지정: 기본폴더/NAIS3_output
 * - 지정(save_dir): 그 폴더에 바로 쌓임 (하위 폴더 자동 생성 없음 — 유저가 고른 곳 그대로)
 */
export function imagesRoot(): string {
  const custom = getSetting('save_dir')
  return custom && custom.trim() ? custom : join(defaultImagesRoot(), 'NAIS3_output')
}

/** 씬 모드 저장 루트 — 미지정이면 기본폴더/NAIS3_scene, 지정(scene_save_dir)이면 그 폴더 */
export function scenesRoot(): string {
  const custom = getSetting('scene_save_dir')
  return custom && custom.trim() ? custom : join(defaultImagesRoot(), 'NAIS3_scene')
}

/** 앱 내부 라이브러리 폴더 — 자동 저장 OFF일 때 저장 위치 (히스토리엔 남지만 저장 폴더엔 안 감) */
export function libraryRoot(): string {
  return join(app.getPath('userData'), 'library')
}

function cleanStorageSegment(value: string, fallback: string): string {
  return value.replace(/[/\\:*?"<>|]/g, '_').trim() || fallback
}

/** 활성 씬 프리셋 이미지 폴더 경로 */
export function scenePresetDir(presetName: string | null): string {
  return join(scenesRoot(), cleanStorageSegment(presetName ?? '', '기본'))
}

/** 씬 이미지 폴더 경로: 프리셋명/씬명 */
export function sceneDir(presetName: string | null, sceneName: string, sceneId?: number): string {
  const scene = cleanStorageSegment(sceneName, `씬-${sceneId ?? 0}`)
  return join(scenePresetDir(presetName), scene)
}

export async function saveGeneratedImage(input: {
  png: Buffer
  sentPayload: string
  seed: number
  // 디렉터 결과는 개별 req_type(bg-removal 등)을 kind로 저장 → 히스토리 뱃지가 툴별로 표시
  kind:
    | 't2i'
    | 'i2i'
    | 'inpaint'
    | 'scene'
    | 'upscale'
    | 'director'
    | 'mosaic'
    | 'arena'
    | 'manga'
    | 'gpt'
    | DirectorMethod
  sceneId?: number
  /** 일반 저장 폴더 아래 하위 폴더 (그림체 월드컵: arena/<세션>). 날짜 폴더 대신 쓴다 */
  subDir?: string
  /** 저장 파일 확장자 (NAI가 반환한 실제 포맷). 기본 png */
  format?: 'png' | 'webp'
  /** 씬 생성이면 씬 이름 — 씬루트/<프리셋>/<씬 이름>/ 아래에 저장 (NAIS2 구조와 동일 계층) */
  sceneName?: string
  /** 씬이 속한 프리셋 이름 (프리셋 간 동명 씬 충돌 방지) */
  scenePresetName?: string
  /** 전송 payload에는 없는 NAIS3 전용 왕복 메타데이터 */
  localMetadata?: Pick<ImageMetadata, 'promptParts'>
}): Promise<SavedImage> {
  const now = new Date()
  // 자동 저장 OFF면 저장 폴더 대신 앱 내부 라이브러리에 보관 (히스토리엔 남지만
  // 유저가 지정한 저장 폴더/NAIS3_output에는 안 감). 씬·일반·디렉터·업스케일 모두 여기서 판정.
  const autoSave = getSetting('auto_save') !== '0'
  // 구조: 메인 = 메인폴더/[YYYY-MM-DD/] (날짜 폴더는 설정으로 on/off),
  //       씬 = 씬루트/<프리셋>/<씬 이름>/
  let monthDir: string
  if (input.sceneName) {
    monthDir = autoSave
      ? sceneDir(input.scenePresetName ?? null, input.sceneName, input.sceneId)
      : join(libraryRoot(), 'scene')
  } else if (input.subDir) {
    monthDir = join(autoSave ? imagesRoot() : libraryRoot(), input.subDir)
  } else {
    const out = autoSave ? imagesRoot() : libraryRoot()
    monthDir =
      getSetting('date_folders') !== '0'
        ? join(
            out,
            `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
          )
        : out
  }
  const ext = input.format ?? 'png'
  const stripExif = getSetting('strip_exif') === '1'
  const metadataBuffer =
    ext === 'png' && input.localMetadata && !stripExif
      ? injectNais3Params(input.png, input.localMetadata)
      : input.png
  const fileBuffer = stripExif ? await sanitizeImageMetadata(metadataBuffer, ext) : metadataBuffer

  const writeInto = (dir: string): string => {
    mkdirSync(dir, { recursive: true })
    if (input.sceneName) {
      // 씬 이미지: 씬이름_생성시각_난수. 이름을 절대 다시 쓰지 않는다 — 지운 이미지 이름을 새 이미지가 받으면
      // 화면이 같은 주소로 기억해 둔 옛 썸네일을 보여 주고, 옮긴 파일의 DB 기록과도 겹친다.
      const safeName =
        input.sceneName.replace(/[/\\:*?"<>|]/g, '_').trim() || `씬-${input.sceneId ?? 0}`
      const p2 = (n: number): string => String(n).padStart(2, '0')
      const stamp = `${now.getFullYear()}${p2(now.getMonth() + 1)}${p2(now.getDate())}-${p2(now.getHours())}${p2(now.getMinutes())}${p2(now.getSeconds())}`
      for (;;) {
        const path = join(dir, `${safeName}_${stamp}_${randomUUID().slice(0, 6)}.${ext}`)
        try {
          writeFileSync(path, fileBuffer, { flag: 'wx' })
          return path
        } catch (error) {
          if (!isFileExistsError(error)) throw error
        }
      }
    }
    const stamp = now.toISOString().replace(/[:.]/g, '-')
    const path = join(dir, `NAIS3_${stamp}_${input.seed}_${randomUUID().slice(0, 8)}.${ext}`)
    writeFileSync(path, fileBuffer, { flag: 'wx' })
    return path
  }

  let filePath: string
  try {
    filePath = writeInto(monthDir)
  } catch (error) {
    // 저장 폴더를 못 쓰면(드라이브 빠짐·권한·Windows 「제어된 폴더 액세스」) 이미 Anlas를 쓴 그림을 버리지 않고
    // 앱 데이터 폴더에 둔다. 히스토리에는 그대로 보인다. 자동 저장 OFF 보관소(library)와 따로 두어
    // 「히스토리 비우기」가 내부 파일로 보고 지우지 않게 한다.
    const fallback = join(app.getPath('userData'), 'unsaved-images')
    console.error(`저장 폴더에 쓰지 못해 ${fallback}에 저장합니다:`, error)
    try {
      filePath = writeInto(fallback)
    } catch {
      throw error
    }
  }

  try {
    // 히스토리/라이브러리용 소형 썸네일. 씬 카드는 원본 경로를 직접 사용한다.
    const thumbnail = await sharp(input.png)
      .resize(512, 512, { fit: 'inside' })
      .webp({ quality: 82 })
      .toBuffer()

    // 가벼운 값은 images에, 썸네일과 요청 본문은 image_blobs에 (v23). 둘은 한 트랜잭션으로 넣는다
    const db = getDb()
    const insertImage = db.prepare(
      'INSERT INTO images (file_path, kind, seed, scene_id) VALUES (?, ?, ?, ?)'
    )
    const insertBlob = db.prepare(
      'INSERT INTO image_blobs (image_id, thumbnail, payload_json) VALUES (?, ?, ?)'
    )
    const payloadJson = payloadWithLocalMetadata(input.sentPayload, input.localMetadata)
    const save = db.transaction((sceneId: number | null): number => {
      const id = Number(insertImage.run(filePath, input.kind, input.seed, sceneId).lastInsertRowid)
      insertBlob.run(id, thumbnail, payloadJson)
      return id
    })
    let id: number
    try {
      id = save(input.sceneId ?? null)
    } catch (error) {
      // 생성 완료 직전에 씬이 삭제된 경우 이미지는 일반 히스토리로 보존한다.
      if (!input.sceneId || !isForeignKeyError(error)) throw error
      id = save(null)
    }
    return {
      id,
      filePath,
      thumbnail: thumbnail.toString('base64'),
      kind: input.kind,
      seed: input.seed,
      createdAt: new Date().toISOString(),
      virtualFolderId: null
    }
  } catch (error) {
    try {
      unlinkSync(filePath)
    } catch {
      // 저장 실패 cleanup 중 이미 없어진 파일은 무시한다.
    }
    throw error
  }
}

function isFileExistsError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST')
}

function isForeignKeyError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'SQLITE_CONSTRAINT_FOREIGNKEY'
  )
}

function payloadWithLocalMetadata(
  sentPayload: string,
  localMetadata?: Pick<ImageMetadata, 'promptParts'>
): string {
  if (!localMetadata) return sentPayload
  try {
    return JSON.stringify({ ...JSON.parse(sentPayload), nais3: localMetadata })
  } catch {
    return sentPayload
  }
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const NAIS3_KEYWORD = 'nais3-params'
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(bytes: Buffer): number {
  let c = 0xffffffff
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function textChunk(keyword: string, value: string): Buffer {
  const data = Buffer.concat([
    Buffer.from(keyword, 'latin1'),
    Buffer.from([0]),
    Buffer.from(value, 'latin1')
  ])
  const type = Buffer.from('tEXt', 'ascii')
  const out = Buffer.alloc(4 + 4 + data.length + 4)
  out.writeUInt32BE(data.length, 0)
  type.copy(out, 4)
  data.copy(out, 8)
  out.writeUInt32BE(crc32(Buffer.concat([type, data])), 8 + data.length)
  return out
}

function injectNais3Params(png: Buffer, meta: Pick<ImageMetadata, 'promptParts'>): Buffer {
  if (png.length < 33 || !png.subarray(0, 8).equals(PNG_SIG)) return png
  const value = Buffer.from(JSON.stringify({ version: 1, ...meta }), 'utf8').toString('base64')
  const chunk = textChunk(NAIS3_KEYWORD, value)
  const ihdrEnd = 33
  return Buffer.concat([png.subarray(0, ihdrEnd), chunk, png.subarray(ihdrEnd)])
}

export function listImages(
  limit: number,
  offset: number,
  filter?: {
    date?: string
    virtualFolderId?: number
    unfiledOnly?: boolean
    /** 이 번호보다 오래된 것만 (이어 읽기). 주면 offset은 쓰지 않는다 */
    beforeId?: number
    /** 이 로컬 날짜(YYYY-MM-DD)부터의 것만. total에는 반영하지 않는다 */
    since?: string
  }
): { items: HistoryItem[]; total: number } {
  const db = getDb()
  const where: string[] = []
  const values: (string | number)[] = []
  // 그림체 월드컵 이미지는 월드컵 탭에서만 본다 (히스토리·라이브러리에 수백 장이 섞이지 않게).
  // images 한 줄은 썸네일·요청 본문 때문에 평균 100KB가 넘어, 줄에서 kind를 읽으면 줄마다 넘침 페이지를
  // 따라가야 한다 (3만 장 뒤쪽을 OFFSET으로 읽는 데 7초). 그래서 kind 인덱스로 뺄 번호만 모으고,
  // 번호를 인덱스만으로 고른 뒤, 고른 60줄만 본문을 읽는다.
  where.push("id NOT IN (SELECT id FROM images WHERE kind IN ('arena', 'manga'))")
  if (filter?.date) {
    // 줄마다 시간대 변환하던 date(…,'localtime') 대신 범위 조건 (idx_images_created 사용)
    const range = localDateRange(filter.date)
    if (range) {
      where.push('created_at >= ? AND created_at < ?')
      values.push(range[0], range[1])
    }
  }
  if (filter?.unfiledOnly) {
    where.push('library_folder_id IS NULL')
  } else if (filter?.virtualFolderId != null) {
    where.push('library_folder_id = ?')
    values.push(filter.virtualFolderId)
  }
  const clause = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''
  const total = (
    db.prepare(`SELECT COUNT(*) AS c FROM images${clause}`).get(...values) as {
      c: number
    }
  ).c
  // 창(since)과 이어 읽기(beforeId)는 번호 범위로만 건다 — 번호 순서가 만든 순서다
  if (filter?.since) {
    const range = localDateRange(filter.since)
    if (range) {
      // MIN(id)로 쓰면 번호 순으로 줄을 읽으며 created_at을 확인해 한 번에 4초가 걸린다.
      // +id로 그 지름길을 막아 created_at 인덱스만 읽게 한다
      const first = db
        .prepare('SELECT MIN(+id) AS m FROM images WHERE created_at >= ?')
        .get(range[0]) as { m: number | null }
      if (first.m == null) return { total, items: [] }
      where.push('id >= ?')
      values.push(first.m)
    }
  }
  const cursor = filter?.beforeId != null && Number.isInteger(filter.beforeId)
  if (cursor) {
    where.push('id < ?')
    values.push(filter!.beforeId!)
  }
  const ids = db
    .prepare(`SELECT id FROM images WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .pluck()
    .all(...values, limit, cursor ? 0 : offset) as number[]
  if (ids.length === 0) return { total, items: [] }
  const rows = db
    .prepare(
      `SELECT i.id, i.file_path, b.thumbnail, i.kind, i.seed, i.created_at, i.library_folder_id
       FROM images i LEFT JOIN image_blobs b ON b.image_id = i.id
       WHERE i.id IN (${ids.join(',')}) ORDER BY i.id DESC`
    )
    .all() as {
    id: number
    file_path: string
    thumbnail: Buffer | null
    kind: string
    seed: number | null
    created_at: string
    library_folder_id: number | null
  }[]

  return {
    total,
    items: rows.map((r) => ({
      id: r.id,
      filePath: r.file_path,
      thumbnail: r.thumbnail ? r.thumbnail.toString('base64') : '',
      kind: r.kind,
      seed: r.seed,
      createdAt: r.created_at,
      virtualFolderId: r.library_folder_id
    }))
  }
}

export function getImagePayload(id: number): string | null {
  const row = getDb().prepare('SELECT payload_json FROM image_blobs WHERE image_id = ?').get(id) as
    { payload_json: string } | undefined
  return row?.payload_json ?? null
}

/**
 * 흰칠 편집 결과를 기존 파일에 저장한다.
 * 앱 DB에 등록된 파일만 허용하며, 새 히스토리 행이나 API 요청은 만들지 않는다.
 */
export async function overwriteCensoredImage(
  filePath: string,
  png: Buffer,
  allowExternal = false
): Promise<{
  thumbnail: string
  sceneId: number | null
  revision: number
  backupAvailable: boolean
}> {
  const db = getDb()
  const row = db.prepare('SELECT scene_id FROM images WHERE file_path = ?').get(filePath) as
    { scene_id: number | null } | undefined
  if (!row && !allowExternal) throw new Error('앱에 등록된 이미지 파일이 아닙니다')
  ensureCensorBackup(filePath)

  const image = sharp(png)
  const extension = extname(filePath).toLowerCase()
  let output: Buffer
  if (extension === '.webp') output = await image.webp({ quality: 95 }).toBuffer()
  else if (extension === '.jpg' || extension === '.jpeg') {
    output = await image.flatten({ background: '#ffffff' }).jpeg({ quality: 95 }).toBuffer()
  } else output = await image.png({ compressionLevel: 6 }).toBuffer()

  const thumbnail = await writeCensoredFile(filePath, output)

  return {
    thumbnail: thumbnail.toString('base64'),
    sceneId: row?.scene_id ?? null,
    revision: Date.now(),
    backupAvailable: true
  }
}

function censorBackupPath(filePath: string): string {
  const key = createHash('sha256').update(resolve(filePath).toLowerCase()).digest('hex')
  return join(app.getPath('userData'), 'censor-backups', `${key}.original`)
}

function ensureCensorBackup(filePath: string): void {
  const backupPath = censorBackupPath(filePath)
  if (existsSync(backupPath)) return
  mkdirSync(join(app.getPath('userData'), 'censor-backups'), { recursive: true })
  writeFileSync(backupPath, readFileSync(filePath))
}

export function hasCensorBackup(filePath: string): boolean {
  return existsSync(censorBackupPath(filePath))
}

async function writeCensoredFile(filePath: string, output: Buffer): Promise<Buffer> {
  const thumbnail = await sharp(output)
    .resize(512, 512, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 82 })
    .toBuffer()
  writeFileSync(filePath, output)
  const db = getDb()
  const update = db.transaction(() => {
    db.prepare(
      'UPDATE image_blobs SET thumbnail = ? WHERE image_id = (SELECT id FROM images WHERE file_path = ?)'
    ).run(thumbnail, filePath)
    db.prepare('UPDATE library_images SET thumbnail = ? WHERE file_path = ?').run(
      thumbnail,
      filePath
    )
  })
  update()
  return thumbnail
}

/** 최초 흰칠 전 보관본을 그대로 되돌린다. 백업은 이후 재복원을 위해 유지한다. */
export async function restoreCensoredImage(
  filePath: string,
  allowExternal = false
): Promise<{ thumbnail: string; sceneId: number | null; revision: number }> {
  const db = getDb()
  const row = db.prepare('SELECT scene_id FROM images WHERE file_path = ?').get(filePath) as
    { scene_id: number | null } | undefined
  if (!row && !allowExternal) throw new Error('앱에 등록된 이미지 파일이 아닙니다')
  const backupPath = censorBackupPath(filePath)
  if (!existsSync(backupPath)) throw new Error('복원할 최초 원본이 없습니다')
  const original = readFileSync(backupPath)
  const thumbnail = await writeCensoredFile(filePath, original)
  return {
    thumbnail: thumbnail.toString('base64'),
    sceneId: row?.scene_id ?? null,
    revision: Date.now()
  }
}
