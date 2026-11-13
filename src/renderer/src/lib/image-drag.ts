export const IMAGE_PATHS_MIME = 'application/x-nais3-image-paths'
export const LIBRARY_ENTRY_MIME = 'application/x-nais3-library-entry'
export const LIBRARY_FOLDER_MIME = 'application/x-nais3-library-folder'

export type LibraryDragEntry = { type: 'image' | 'stack'; id: number }

/**
 * 지금 끌고 있는 그림. 진짜 파일 끌기에는 앱 전용 데이터를 실을 수 없어서 여기 적어 두고,
 * 놓인 파일의 경로가 이것과 같을 때만 앱 안에서 끈 것으로 본다.
 */
let pending: { path: string; entry: LibraryDragEntry | null } | null = null

const samePath = (a: string, b: string): boolean =>
  a.replace(/\//g, '\\').toLowerCase() === b.replace(/\//g, '\\').toLowerCase()

/** 놓인 파일이 방금 앱 안에서 끈 그 그림이면 pending을 돌려준다 */
function pendingFor(e: React.DragEvent): typeof pending {
  if (!pending) return null
  const file = e.dataTransfer.files?.[0]
  const path = file ? window.nais.pathForFile(file) : ''
  return path && samePath(path, pending.path) ? pending : null
}

/**
 * 그림을 진짜 파일로 끈다. 탐색기·메신저 같은 다른 앱에도 파일로 떨어진다.
 * 앱 안의 놓는 곳은 FileList(droppedImagePaths)나 droppedInternalPath·readLibraryEntry로 받는다.
 */
export function setImagePathDrag(
  e: React.DragEvent,
  filePath: string,
  entry?: LibraryDragEntry
): void {
  e.preventDefault()
  pending = { path: filePath, entry: entry ?? null }
  void window.nais.invoke('images:startDrag', { filePath })
}

/** 앱 안에서 끈 그림이 놓였으면 그 경로, 아니면 빈 문자열 */
export function droppedInternalPath(e: React.DragEvent): string {
  return pendingFor(e)?.path ?? ''
}

export function droppedImagePaths(e: React.DragEvent): string[] {
  const paths: string[] = []
  const encoded = e.dataTransfer.getData(IMAGE_PATHS_MIME)
  if (encoded) {
    try {
      const values = JSON.parse(encoded) as unknown
      if (Array.isArray(values)) {
        paths.push(...values.filter((value): value is string => typeof value === 'string'))
      }
    } catch {
      // 다른 앱이 같은 MIME을 썼다면 무시하고 FileList를 확인한다.
    }
  }
  for (const file of Array.from(e.dataTransfer.files)) {
    const path = window.nais.pathForFile(file)
    if (path) paths.push(path)
  }
  return [...new Set(paths.filter(Boolean))]
}

export function hasImageDrop(e: React.DragEvent): boolean {
  return e.dataTransfer.types.includes(IMAGE_PATHS_MIME) || e.dataTransfer.types.includes('Files')
}

export function setLibraryEntryDrag(e: React.DragEvent, entry: LibraryDragEntry): void {
  e.dataTransfer.effectAllowed = 'copyMove'
  e.dataTransfer.setData(LIBRARY_ENTRY_MIME, JSON.stringify(entry))
}

/** 라이브러리 그림·스택을 끄는 중인지 (끄는 중에는 파일 경로를 볼 수 없어 종류만 본다) */
export function hasLibraryEntryDrag(e: React.DragEvent): boolean {
  return (
    e.dataTransfer.types.includes(LIBRARY_ENTRY_MIME) ||
    (pending?.entry != null && e.dataTransfer.types.includes('Files'))
  )
}

export function readLibraryEntry(e: React.DragEvent): LibraryDragEntry | null {
  const fromFile = pendingFor(e)?.entry
  if (fromFile) return fromFile
  try {
    const value = JSON.parse(e.dataTransfer.getData(LIBRARY_ENTRY_MIME)) as LibraryDragEntry
    if ((value.type === 'image' || value.type === 'stack') && Number.isInteger(value.id))
      return value
  } catch {
    // 라이브러리 항목 드롭이 아니면 null
  }
  return null
}
