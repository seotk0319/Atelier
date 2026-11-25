import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { getDb } from '../db'
import { getSetting, setSetting } from '../db/settings'
import { imagesRoot } from '../images/storage'

/**
 * NAIS3 데이터 내보내기/가져오기 (백업/이전).
 * 라이브러리(캐릭터·조각·바이브·캐릭레퍼·폴더)·씬·프롬프트 프리셋·현재 프롬프트를 JSON으로.
 * BLOB(썸네일)은 base64로, 바이브/캐릭레퍼의 실제 이미지 파일은 __image(base64)로 인라인해 이식성 확보.
 */

// 내보낼 테이블 (히스토리 images·anlas_log·settings는 제외 — 기기별/대용량)
const TABLES = [
  'character_folders',
  'character_prompts',
  'fragment_folders',
  'fragments',
  'vibe_folders',
  'vibe_images',
  'charref_folders',
  'charref_images',
  'scene_preset_folders',
  'scene_presets',
  'gen_scenes',
  'prompt_presets'
] as const

// file_path의 실제 이미지를 인라인해야 하는 테이블
const IMAGE_TABLES = new Set(['vibe_images', 'charref_images'])

type Row = Record<string, unknown>

function encodeValue(v: unknown): unknown {
  if (Buffer.isBuffer(v)) return { __blob: v.toString('base64') }
  return v
}
function decodeValue(v: unknown): unknown {
  if (v && typeof v === 'object' && '__blob' in (v as object)) {
    return Buffer.from((v as { __blob: string }).__blob, 'base64')
  }
  return v
}

export function exportAll(): Record<string, unknown> {
  const db = getDb()
  const tables: Record<string, Row[]> = {}
  for (const t of TABLES) {
    const rows = db.prepare(`SELECT * FROM ${t}`).all() as Row[]
    tables[t] = rows.map((r) => {
      const out: Row = {}
      for (const [k, v] of Object.entries(r)) out[k] = encodeValue(v)
      // 바이브/캐릭레퍼 이미지 파일 인라인 (이식성)
      if (IMAGE_TABLES.has(t) && typeof r.file_path === 'string') {
        try {
          out.__image = readFileSync(r.file_path).toString('base64')
        } catch {
          out.__image = null // 파일 없으면 스킵
        }
      }
      return out
    })
  }
  return {
    _app: 'NAIS3',
    _version: 1,
    mainParams: getSetting('main_params') || null,
    tables
  }
}

/**
 * 가져오기 — 백업에 든 표만 지우고 백업 내용으로 바꾼다(복원). 백업에 없는 표(예전 백업에는 없던 씬 프리셋
 * 폴더 등)는 그대로 둔다.
 *
 * 히스토리(images)는 백업하지 않지만 images.scene_id는 gen_scenes를 ON DELETE SET NULL로 가리킨다 —
 * 씬 표를 비우면 씬 그림 연결이 모두 풀린다. 번호와 만든 시각이 같은 씬(같은 씬)은 다시 잇는다
 * (upstream NAIS3 60b39db·d47ac3d). replacedSceneIds: 복원으로 사라지거나 다른 씬이 된 씬 번호 —
 * 그 씬으로 가던 생성은 호출한 쪽이 취소한다.
 */
export function importAll(data: Record<string, unknown>): {
  imported: number
  replacedSceneIds: number[]
} {
  const tables = (data.tables ?? {}) as Record<string, Row[]>
  const present = TABLES.filter((t) => Array.isArray(tables[t]))
  // 줄이 하나도 없는 백업으로 지금 데이터를 비우지 않는다
  if (present.every((t) => tables[t].length === 0)) throw new Error('백업에 가져올 항목이 없어요')
  const db = getDb()
  // 다른 판의 백업이면 열이 다를 수 있다 — 지금 표에 있는 열만 넣는다 (없는 열은 기본값)
  const columnsOf = new Map(
    present.map((t) => [
      t,
      new Set(
        (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name)
      )
    ])
  )
  const libDir = join(imagesRoot(), '_imported')
  mkdirSync(libDir, { recursive: true })

  let imported = 0
  let replacedSceneIds: number[] = []
  const tx = db.transaction(() => {
    const replacingScenes = present.includes('gen_scenes')
    const sceneStamps = (): Map<number, string> =>
      new Map(
        (
          db.prepare('SELECT id, created_at FROM gen_scenes').all() as {
            id: number
            created_at: string
          }[]
        ).map((r) => [r.id, r.created_at])
      )
    const before = replacingScenes ? sceneStamps() : new Map<number, string>()
    const links = replacingScenes
      ? (db.prepare('SELECT id, scene_id FROM images WHERE scene_id IS NOT NULL').all() as {
          id: number
          scene_id: number
        }[])
      : []

    // 자식→부모 순서 무관하게, 백업에 든 표만 교체: 먼저 비우고(역순) 다시 삽입
    for (const t of [...present].reverse()) db.prepare(`DELETE FROM ${t}`).run()

    for (const t of present) {
      const rows = tables[t]
      for (const raw of rows) {
        const row: Row = {}
        const known = columnsOf.get(t)!
        for (const [k, v] of Object.entries(raw)) {
          if (k === '__image' || !known.has(k)) continue
          row[k] = decodeValue(v)
        }
        // 이미지 파일 복원 → 새 경로로 재기록
        if (IMAGE_TABLES.has(t) && typeof raw.__image === 'string') {
          const ext = String(row.file_path ?? '').endsWith('.webp') ? 'webp' : 'png'
          const fp = join(libDir, `${t}_${row.id}_${Date.now()}.${ext}`)
          writeFileSync(fp, Buffer.from(raw.__image, 'base64'))
          row.file_path = fp
        }
        const cols = Object.keys(row)
        const placeholders = cols.map(() => '?').join(', ')
        db.prepare(`INSERT INTO ${t} (${cols.join(', ')}) VALUES (${placeholders})`).run(
          ...cols.map((c) => row[c] as never)
        )
        imported++
      }
    }

    if (replacingScenes) {
      const after = sceneStamps()
      const kept = new Set(
        [...before].filter(([id, createdAt]) => after.get(id) === createdAt).map(([id]) => id)
      )
      const relink = db.prepare('UPDATE images SET scene_id = ? WHERE id = ?')
      for (const link of links) if (kept.has(link.scene_id)) relink.run(link.scene_id, link.id)
      replacedSceneIds = [...before.keys()].filter((id) => !kept.has(id))
    }
    if (typeof data.mainParams === 'string') setSetting('main_params', data.mainParams)
  })
  tx()
  return { imported, replacedSceneIds }
}
