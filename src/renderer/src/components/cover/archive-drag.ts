import { IMAGE_PATHS_MIME } from '../../lib/image-drag'

/** 표지 기록에서 끌어 온 항목. 경로도 함께 실어서 다른 이미지 놓기 자리도 받게 한다 */
export const ARCHIVE_MIME = 'application/x-nais3-cover-archive'

export function setArchiveDrag(e: React.DragEvent, id: string, path: string): void {
  e.dataTransfer.effectAllowed = 'copy'
  e.dataTransfer.setData(ARCHIVE_MIME, id)
  e.dataTransfer.setData(IMAGE_PATHS_MIME, JSON.stringify([path]))
}

export function readArchiveDrag(e: React.DragEvent): string | null {
  const id = e.dataTransfer.getData(ARCHIVE_MIME)
  return /^[0-9a-f]{40}-(bg|typo)$/.test(id) ? id : null
}
