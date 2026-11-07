import type { ListFolder } from '@shared/types'
import { DIVIDER_KEY } from './folder-list'

/**
 * 씬 프리셋 폴더 2단계 (작품 폴더 아래 캐릭터 폴더).
 * 폴더 배열은 늘 "맨 위 폴더, 그 하위 폴더들, 다음 맨 위 폴더, ..." 순서로 둔다.
 * 그러면 공용 folder-list(canonicalize·moveRow·toOrderEntries)를 그대로 써도
 * 프리셋 소속이 "직전 폴더 행"으로 맞게 정해진다.
 */

interface Item {
  id: number
  folderId: number | null
}

export type PresetTreeRow<T extends Item> =
  | { type: 'folder'; folder: ListFolder; depth: 0 | 1 }
  | { type: 'item'; item: T; depth: 0 | 1 | 2 }
  | { type: 'divider' }

const parentOf = (f: ListFolder): number | null => f.parentId ?? null

/** 맨 위 폴더 뒤에 그 하위 폴더를 붙인 순서. 상위가 없어진 폴더는 맨 위로 본다 */
export function orderFolders(folders: ListFolder[]): ListFolder[] {
  const ids = new Set(folders.map((f) => f.id))
  const norm = folders.map((f) =>
    f.parentId != null && !ids.has(f.parentId) ? { ...f, parentId: null } : f
  )
  const out: ListFolder[] = []
  for (const top of norm.filter((f) => parentOf(f) == null)) {
    out.push(top)
    for (const kid of norm) if (kid.parentId === top.id) out.push(kid)
  }
  return out
}

/** "오프파코 › sm1" */
export function folderPath(folders: ListFolder[], id: number | null | undefined): string {
  if (id == null) return ''
  const f = folders.find((x) => x.id === id)
  if (!f) return ''
  const parent = f.parentId != null ? folders.find((x) => x.id === f.parentId) : undefined
  return parent ? parent.name + ' › ' + f.name : f.name
}

/** 폴더별 프리셋 수. 맨 위 폴더는 하위 폴더까지 합친다 */
export function folderCounts(folders: ListFolder[], items: Item[]): Map<number, number> {
  const own = new Map<number, number>()
  for (const it of items)
    if (it.folderId != null) own.set(it.folderId, (own.get(it.folderId) ?? 0) + 1)
  const total = new Map(own)
  for (const f of folders)
    if (f.parentId != null)
      total.set(f.parentId, (total.get(f.parentId) ?? 0) + (own.get(f.id) ?? 0))
  return total
}

/** 보이는 행만 만든다. 맨 위 폴더를 접으면 하위 폴더와 그 안의 프리셋도 숨는다 */
export function buildPresetRows<T extends Item>(
  folders: ListFolder[],
  items: T[],
  isCollapsed: (f: ListFolder) => boolean
): PresetTreeRow<T>[] {
  const ordered = orderFolders(folders)
  const rows: PresetTreeRow<T>[] = []
  for (const top of ordered.filter((f) => parentOf(f) == null)) {
    rows.push({ type: 'folder', folder: top, depth: 0 })
    if (isCollapsed(top)) continue
    for (const item of items)
      if (item.folderId === top.id) rows.push({ type: 'item', item, depth: 1 })
    for (const kid of ordered.filter((f) => f.parentId === top.id)) {
      rows.push({ type: 'folder', folder: kid, depth: 1 })
      if (isCollapsed(kid)) continue
      for (const item of items)
        if (item.folderId === kid.id) rows.push({ type: 'item', item, depth: 2 })
    }
  }
  if (ordered.length) rows.push({ type: 'divider' })
  for (const item of items) if (item.folderId == null) rows.push({ type: 'item', item, depth: 0 })
  return rows
}

/**
 * 폴더 끌기: 같은 단계(같은 상위) 안에서만 순서를 바꾼다. 상위를 바꾸는 일은 "폴더로 이동" 메뉴로.
 * 맨 위 폴더를 하위 폴더나 그 안 프리셋 위에 놓으면 그 상위 폴더 자리로 본다.
 * 바뀌는 게 없으면 null.
 */
export function moveFolderRow(
  folders: ListFolder[],
  items: Item[],
  activeKey: string,
  overKey: string
): ListFolder[] | null {
  if (!activeKey.startsWith('f-') || activeKey === overKey) return null
  const ordered = orderFolders(folders)
  const active = ordered.find((f) => f.id === Number(activeKey.slice(2)))
  if (!active) return null
  const parent = parentOf(active)

  let over: ListFolder | 'end' | undefined
  if (overKey === DIVIDER_KEY) over = 'end'
  else if (overKey.startsWith('f-')) over = ordered.find((f) => f.id === Number(overKey.slice(2)))
  else {
    const item = items.find((i) => i.id === Number(overKey.slice(2)))
    over = item?.folderId == null ? 'end' : ordered.find((f) => f.id === item.folderId)
  }
  if (!over) return null

  let target: ListFolder | null = null // null = 끝으로
  if (over !== 'end') {
    if (parentOf(over) === parent) target = over
    else if (parent == null && over.parentId != null)
      target = ordered.find((f) => f.id === over.parentId) ?? null
    else return null
  } else if (parent != null) return null
  if (target?.id === active.id) return null

  const siblings = ordered.filter((f) => parentOf(f) === parent)
  const from = siblings.findIndex((f) => f.id === active.id)
  const rest = siblings.filter((f) => f.id !== active.id)
  let to = rest.length
  if (target) {
    to = rest.findIndex((f) => f.id === target.id)
    if (siblings.findIndex((f) => f.id === target.id) > from) to += 1
  }
  rest.splice(to, 0, active)

  const tops = parent == null ? rest : ordered.filter((f) => parentOf(f) == null)
  const out: ListFolder[] = []
  for (const top of tops) {
    out.push(top)
    const kids = parent === top.id ? rest : ordered.filter((f) => f.parentId === top.id)
    out.push(...kids)
  }
  return out.map((f) => f.id).join() === ordered.map((f) => f.id).join() ? null : out
}
