import { describe, expect, it } from 'vitest'
import type { ListFolder } from '../src/shared/types'
import { toOrderEntries } from '../src/renderer/src/lib/folder-list'
import {
  buildPresetRows,
  folderCounts,
  folderPath,
  moveFolderRow,
  orderFolders
} from '../src/renderer/src/lib/preset-tree'

const f = (
  id: number,
  name: string,
  parentId: number | null = null,
  collapsed = false
): ListFolder => ({
  id,
  name,
  collapsed,
  color: null,
  parentId
})
// DB 순서(sort_order)대로 와도 하위 폴더가 뒤섞여 있을 수 있다
const folders = [f(1, '오프파코'), f(5, '공주님'), f(2, 'sm1', 1), f(3, 'na1', 1), f(6, 'ch1', 5)]
const items = [
  { id: 10, folderId: 2 },
  { id: 11, folderId: 3 },
  { id: 12, folderId: 1 },
  { id: 13, folderId: null },
  { id: 14, folderId: 6 }
]

describe('scene preset folder tree', () => {
  it('puts each subfolder right under its parent and keeps the rest in order', () => {
    expect(orderFolders(folders).map((x) => x.id)).toEqual([1, 2, 3, 5, 6])
    // 상위가 사라진 폴더는 맨 위로
    expect(orderFolders([f(7, 'x', 99)]).map((x) => x.parentId)).toEqual([null])
  })

  it('names folders with their parent and counts subfolders into the parent', () => {
    expect(folderPath(folders, 2)).toBe('오프파코 › sm1')
    expect(folderPath(folders, 1)).toBe('오프파코')
    const c = folderCounts(folders, items)
    expect(c.get(1)).toBe(3)
    expect(c.get(2)).toBe(1)
  })

  it('hides a whole work when the top folder is collapsed', () => {
    const rows = buildPresetRows(folders, items, (x) => x.id === 1)
    const keys = rows.map((r) =>
      r.type === 'folder' ? 'f' + r.folder.id : r.type === 'item' ? 'i' + r.item.id : '-'
    )
    expect(keys).toEqual(['f1', 'f5', 'f6', 'i14', '-', 'i13'])
    const open = buildPresetRows(folders, items, () => false)
    expect(open.find((r) => r.type === 'item' && r.item.id === 10)).toMatchObject({ depth: 2 })
  })

  it('reorders folders only among siblings and keeps children attached', () => {
    // 공주님을 오프파코 위로: 오프파코의 하위 폴더도 같이 따라간다
    expect(moveFolderRow(folders, items, 'f-5', 'f-1')?.map((x) => x.id)).toEqual([5, 6, 1, 2, 3])
    // 맨 위 폴더를 다른 작품의 하위 폴더 위에 놓으면 그 작품 자리로
    expect(moveFolderRow(folders, items, 'f-1', 'f-6')?.map((x) => x.id)).toEqual([5, 6, 1, 2, 3])
    // 하위 폴더끼리 순서 바꾸기
    expect(moveFolderRow(folders, items, 'f-3', 'f-2')?.map((x) => x.id)).toEqual([1, 3, 2, 5, 6])
    // 다른 작품으로 끌어도 상위는 안 바뀐다 (메뉴로만)
    expect(moveFolderRow(folders, items, 'f-2', 'f-6')).toBeNull()
  })

  it('saves subfolder presets under the subfolder, not the parent', () => {
    const order = toOrderEntries(orderFolders(folders), items)
    // 저장 규약: 직전 폴더 행이 소속. sm1(2) 다음에 10이 와야 한다
    const at = (type: string, id: number): number =>
      order.findIndex((e) => e.type === type && e.id === id)
    expect(at('char', 10)).toBe(at('folder', 2) + 1)
    expect(at('char', 12)).toBe(at('folder', 1) + 1)
  })
})
