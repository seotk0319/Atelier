import {
  getCoverCanvas,
  moveInList,
  type CoverCanvasId,
  type CoverItem,
  type CoverKind,
  type CoverProject
} from '@shared/cover'

/**
 * 표지 저장 계층 (렌더러). 원본 cover-batch state.js 의 IndexedDB 부분을 main IPC 로 바꿨다.
 * 프로젝트 객체는 제자리에서 고친다. 저장(cover:save)은 호출자(cover-store)가 한다.
 */

function sniffType(b: Uint8Array): string {
  if (b[0] === 0x89 && b[1] === 0x50) return 'image/png'
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg'
  if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45) return 'image/webp'
  if (b[0] === 0x47 && b[1] === 0x49) return 'image/gif'
  if (b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp'
  return 'application/octet-stream'
}

/** blob 키 → Blob. 없으면 null */
export async function getBlob(key: string): Promise<Blob | null> {
  const { bytes } = await window.nais.invoke('cover:getBlob', { key })
  if (!bytes) return null
  return new Blob([bytes as Uint8Array<ArrayBuffer>], { type: sniffType(bytes) })
}

async function measure(blob: Blob): Promise<{ width: number; height: number } | null> {
  try {
    const bmp = await createImageBitmap(blob)
    const size = { width: bmp.width, height: bmp.height }
    bmp.close()
    return size.width > 0 && size.height > 0 ? size : null
  } catch {
    return null
  }
}

export async function putBlob(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  const res = await window.nais.invoke('cover:putBlob', { bytes })
  if ('error' in res) throw new Error(res.error)
  return res.key
}

/**
 * 프로젝트에서 빠진 blob 은 바로 지우지 않고, 그 상태가 저장된 뒤에 지운다.
 * (저장 전에 앱이 꺼져도 저장된 작품이 가리키는 파일이 남아 있게)
 */
const pendingDeletes = new Set<string>()

export function deleteBlobs(keys: (string | null | undefined)[]): void {
  for (const k of keys) if (k) pendingDeletes.add(k)
}

/** cover-store 가 저장 성공 직후 부른다 */
export function flushBlobDeletes(project: CoverProject | null): void {
  if (!pendingDeletes.size) return
  const used = new Set<string>()
  if (project) {
    for (const b of project.backgrounds) {
      used.add(b.blobKey)
      if (b.maskKey) used.add(b.maskKey)
    }
    for (const t of project.typos) used.add(t.blobKey)
    for (const f of Object.values(project.frameImages)) if (f) used.add(f.blobKey)
  }
  const keys = [...pendingDeletes].filter((k) => !used.has(k))
  pendingDeletes.clear()
  if (keys.length) void window.nais.invoke('cover:deleteBlobs', { keys })
}

const baseName = (n: string): string => {
  const dot = n.lastIndexOf('.')
  return dot > 0 ? n.slice(0, dot) : n
}

async function itemFromKey(key: string, name: string): Promise<CoverItem | null> {
  const blob = await getBlob(key)
  const size = blob ? await measure(blob) : null
  if (!size) {
    void window.nais.invoke('cover:deleteBlobs', { keys: [key] })
    return null
  }
  return { id: crypto.randomUUID(), name, blobKey: key, ...size }
}

function push(project: CoverProject, kind: CoverKind, item: CoverItem): void {
  if (kind === 'backgrounds') item.maskKey = null
  project[kind].push(item)
}

/** 탐색기·붙여넣기 파일. 해석할 수 없는 이미지는 건너뛴다 */
export async function addImageFiles(
  project: CoverProject,
  kind: CoverKind,
  files: File[]
): Promise<{ added: CoverItem[]; failed: number }> {
  const added: CoverItem[] = []
  let failed = 0
  for (const f of files) {
    if (!f.type.startsWith('image/')) {
      failed++
      continue
    }
    const size = await measure(f)
    if (!size) {
      failed++
      continue
    }
    const key = await putBlob(f)
    const item: CoverItem = {
      id: crypto.randomUUID(),
      name: baseName(f.name),
      blobKey: key,
      ...size
    }
    push(project, kind, item)
    added.push(item)
  }
  return { added, failed }
}

/** 라이브러리·GPT·히스토리에서 끌어온 파일 경로 */
export async function addImagePaths(
  project: CoverProject,
  kind: CoverKind,
  paths: string[]
): Promise<{ added: CoverItem[]; failed: number }> {
  const res = await window.nais.invoke('cover:importPaths', { paths })
  const added: CoverItem[] = []
  let failed = res.failed
  for (const { key, name } of res.items) {
    const item = await itemFromKey(key, name)
    if (!item) {
      failed++
      continue
    }
    push(project, kind, item)
    added.push(item)
  }
  return { added, failed }
}

/** 목록에서 빼고 관련 배치·팬·WEBP 프레임·선택·blob 을 함께 정리 */
export function removeItem(project: CoverProject, kind: CoverKind, id: string): CoverItem | null {
  const arr = project[kind]
  const idx = arr.findIndex((it) => it.id === id)
  if (idx < 0) return null
  const [item] = arr.splice(idx, 1)
  const map = kind === 'typos' ? project.placements : project.pans
  for (const key of Object.keys(map)) if (key.startsWith(id + '@')) delete map[key]
  if (kind === 'backgrounds') {
    project.webp.frames = project.webp.frames.filter((f) => f.bgId !== id)
    if (project.selection.bgId === id) project.selection.bgId = project.backgrounds[0]?.id ?? null
  } else if (project.selection.typoId === id) {
    project.selection.typoId = project.typos[0]?.id ?? null
  }
  deleteBlobs([item.blobKey, item.maskKey])
  return item
}

export function moveItem(
  project: CoverProject,
  kind: CoverKind,
  id: string,
  delta: number
): boolean {
  return moveInList(project[kind], id, delta)
}

/** 끌어서 순서 바꾸기: id 를 toIndex 자리로 */
export function reorderItem(
  project: CoverProject,
  kind: CoverKind,
  id: string,
  toIndex: number
): boolean {
  const arr = project[kind]
  const from = arr.findIndex((it) => it.id === id)
  const to = Math.max(0, Math.min(arr.length - 1, toIndex))
  if (from < 0 || from === to) return false
  const [it] = arr.splice(from, 1)
  arr.splice(to, 0, it)
  return true
}

/** PNG 액자 (캔버스별). 옛 blob 키를 돌려준다 (호출자가 render.forgetBitmap) */
export async function setFrameImage(
  project: CoverProject,
  canvasId: CoverCanvasId,
  source: File | string
): Promise<{ item: CoverItem; oldKey: string | null } | null> {
  if (!getCoverCanvas(canvasId)) return null
  let item: CoverItem | null = null
  if (typeof source === 'string') {
    const res = await window.nais.invoke('cover:importPaths', { paths: [source] })
    const got = res.items[0]
    if (got) item = await itemFromKey(got.key, got.name)
  } else if (source.type.startsWith('image/')) {
    const size = await measure(source)
    if (size)
      item = {
        id: crypto.randomUUID(),
        name: baseName(source.name),
        blobKey: await putBlob(source),
        ...size
      }
  }
  if (!item) return null
  const old = project.frameImages[canvasId]
  project.frameImages[canvasId] = item
  if (old) deleteBlobs([old.blobKey])
  return { item, oldKey: old?.blobKey ?? null }
}

export function removeFrameImage(project: CoverProject, canvasId: CoverCanvasId): string | null {
  const old = project.frameImages[canvasId]
  if (!old) return null
  delete project.frameImages[canvasId]
  deleteBlobs([old.blobKey])
  return old.blobKey
}

/** 검열 마스크 교체. blob 이 null 이면 마스크 삭제 */
export async function setMaskBlob(
  project: CoverProject,
  bgId: string,
  blob: Blob | null
): Promise<{ oldKey: string | null; newKey: string | null }> {
  const bg = project.backgrounds.find((b) => b.id === bgId)
  if (!bg) return { oldKey: null, newKey: null }
  const oldKey = bg.maskKey ?? null
  const newKey = blob ? await putBlob(blob) : null
  bg.maskKey = newKey
  if (oldKey) deleteBlobs([oldKey])
  return { oldKey, newKey }
}
