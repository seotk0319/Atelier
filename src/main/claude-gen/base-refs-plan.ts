import type { BaseRef, ListFolder } from '../../shared/types'
import { normalizeBaseRefs } from '../../shared/base-refs'

/**
 * 클로 생성 창구 POST /base-refs — 이미 있는 프리셋·씬에 기준 레퍼를 넣거나 지운다.
 * 받은 항목을 모두 확인한 뒤에만 바꾼다 (하나라도 틀리면 아무것도 바꾸지 않는다).
 *
 * 항목: { presetId? | preset?(이름), folder?(프리셋 이름이 겹칠 때 폴더 이름), sceneId? | scene?(이름), refs }
 * - scene·sceneId가 없으면 프리셋 기준 레퍼, 있으면 그 씬의 기준 레퍼.
 * - refs가 null·빈 배열이면 지운다. 항목마다 종류 기본 character, 강도 기본 2.5.
 */

export const BASE_REFS_MAX_ITEMS = 2000

export interface PlanPreset {
  id: number
  name: string
  folderId: number | null
}

export interface PlanScene {
  id: number
  presetId: number
  name: string
}

export interface PlanSource {
  presets: PlanPreset[]
  folders: ListFolder[]
  scenesOf: (presetId: number) => PlanScene[]
  fileExists: (path: string) => boolean
}

export interface BaseRefChange {
  target: 'preset' | 'scene'
  id: number
  presetId: number
  label: string
  refs: BaseRef[] | null
}

export type BaseRefPlan = { ok: true; changes: BaseRefChange[] } | { ok: false; errors: string[] }

function folderMatches(folders: ListFolder[], folderId: number | null, name: string): boolean {
  // 프리셋이 든 폴더나 그 위 폴더 이름이 맞으면 된다 (작품 폴더 > 캐릭터 폴더 2단계)
  let id = folderId
  for (let depth = 0; id != null && depth < 4; depth++) {
    const folder = folders.find((f) => f.id === id)
    if (!folder) return false
    if (folder.name === name) return true
    id = folder.parentId ?? null
  }
  return false
}

export function planBaseRefs(items: unknown, source: PlanSource): BaseRefPlan {
  if (!Array.isArray(items) || items.length === 0)
    return { ok: false, errors: ['items가 비었어요'] }
  if (items.length > BASE_REFS_MAX_ITEMS)
    return { ok: false, errors: [`한 번에 ${BASE_REFS_MAX_ITEMS}개까지예요`] }
  const errors: string[] = []
  const changes: BaseRefChange[] = []
  const seen = new Set<string>()
  const scenesCache = new Map<number, PlanScene[]>()
  const scenesOf = (presetId: number): PlanScene[] => {
    let list = scenesCache.get(presetId)
    if (!list) {
      list = source.scenesOf(presetId)
      scenesCache.set(presetId, list)
    }
    return list
  }

  items.forEach((raw: unknown, index) => {
    const at = `#${index + 1}`
    if (!raw || typeof raw !== 'object') {
      errors.push(`${at}: 잘못된 항목`)
      return
    }
    const item = raw as Record<string, unknown>
    // 프리셋 찾기
    let preset: PlanPreset | undefined
    if (item.presetId !== undefined) {
      preset = source.presets.find((p) => p.id === item.presetId)
      if (!preset) {
        errors.push(`${at}: presetId ${String(item.presetId)}가 없어요`)
        return
      }
    } else if (typeof item.preset === 'string' && item.preset.trim()) {
      const name = item.preset.trim()
      const folder = typeof item.folder === 'string' ? item.folder.trim() : ''
      const found = source.presets.filter(
        (p) => p.name === name && (!folder || folderMatches(source.folders, p.folderId, folder))
      )
      if (found.length === 0) {
        errors.push(`${at}: 프리셋 「${name}」${folder ? `(폴더 「${folder}」)` : ''}이 없어요`)
        return
      }
      if (found.length > 1) {
        errors.push(
          `${at}: 프리셋 「${name}」이 ${found.length}개예요 — folder나 presetId를 주세요`
        )
        return
      }
      preset = found[0]
    } else {
      errors.push(`${at}: preset(이름)이나 presetId가 있어야 해요`)
      return
    }
    // 레퍼 확인
    const checked = normalizeBaseRefs(item.refs)
    if (!checked.ok) {
      errors.push(`${at}: ${checked.error}`)
      return
    }
    const missing = (checked.refs ?? []).filter((r) => !source.fileExists(r.filePath))
    if (missing.length) {
      errors.push(`${at}: 그림 파일이 없어요: ${missing.map((r) => r.filePath).join(', ')}`)
      return
    }
    // 씬이면 씬 찾기
    if (item.sceneId !== undefined || item.scene !== undefined) {
      const scenes = scenesOf(preset.id)
      let scene: PlanScene | undefined
      if (item.sceneId !== undefined) {
        scene = scenes.find((s) => s.id === item.sceneId)
        if (!scene) {
          errors.push(`${at}: 프리셋 「${preset.name}」에 sceneId ${String(item.sceneId)}가 없어요`)
          return
        }
      } else {
        const name = typeof item.scene === 'string' ? item.scene.trim() : ''
        const found = scenes.filter((s) => s.name === name)
        if (!name || found.length === 0) {
          errors.push(`${at}: 프리셋 「${preset.name}」에 씬 「${name}」이 없어요`)
          return
        }
        if (found.length > 1) {
          errors.push(
            `${at}: 프리셋 「${preset.name}」에 씬 「${name}」이 ${found.length}개예요 — sceneId를 주세요`
          )
          return
        }
        scene = found[0]
      }
      const key = `s${scene.id}`
      if (seen.has(key)) {
        errors.push(`${at}: 씬 「${scene.name}」이 두 번 있어요`)
        return
      }
      seen.add(key)
      changes.push({
        target: 'scene',
        id: scene.id,
        presetId: preset.id,
        label: `${preset.name} / ${scene.name}`,
        refs: checked.refs
      })
      return
    }
    const key = `p${preset.id}`
    if (seen.has(key)) {
      errors.push(`${at}: 프리셋 「${preset.name}」이 두 번 있어요`)
      return
    }
    seen.add(key)
    changes.push({
      target: 'preset',
      id: preset.id,
      presetId: preset.id,
      label: preset.name,
      refs: checked.refs
    })
  })
  return errors.length ? { ok: false, errors } : { ok: true, changes }
}
