import type { CoverCanvasId, CoverProject } from '@shared/cover'

/** 편집기 모드: 타이포 배치 / 배경 위치 / 검열 붓 */
export type CoverMode = 'typo' | 'pan' | 'censor'

/** 화면에서 고르는 붓 설정 (저장되는 값) */
export interface CoverBrushPrefs {
  /** 지름, 출력 픽셀 기준 5~400 */
  size: number
  /** 부드러움 0~100 (hardness = 1 - softness/100) */
  softness: number
  /** 불투명도 10~100 (%) */
  opacity: number
  color: string
  erase: boolean
}

/** 편집기·검열 모듈이 받는 붓 설정 */
export interface EditorBrush {
  /** 출력 픽셀 기준 지름 */
  size: number
  /** 0~1, 1 = 딱딱 */
  hardness: number
  /** 0~1 */
  opacity: number
  color: string
  erase: boolean
}

export function toEditorBrush(b: CoverBrushPrefs): EditorBrush {
  return {
    size: b.size,
    hardness: 1 - b.softness / 100,
    opacity: b.opacity / 100,
    color: b.color,
    erase: b.erase
  }
}

export interface CoverTarget {
  canvasId: CoverCanvasId
  bgId: string | null
  typoId: string | null
}

export type CoverChangeKind = 'placement' | 'pan' | 'mask'

export interface CoverHistoryState {
  canUndo: boolean
  canRedo: boolean
}

/** engine/editor.ts 가 돌려주는 객체 */
export interface CoverEditorApi {
  show(target: CoverTarget): Promise<void>
  setMode(mode: CoverMode): void
  setBrush(brush: EditorBrush): void
  undo(): Promise<boolean>
  redo(): Promise<boolean>
  clearMask(): Promise<boolean>
  /** 프로젝트 내용(액자, 이미지 목록, 배치 숫자 등)이 바뀌었을 때 다시 그림 */
  refresh(): Promise<void>
  destroy(): void
}

export interface CoverEditorOptions {
  getProject: () => CoverProject | null
  /** 드래그가 끝날 때·방향키·붓 획 확정 때 한 번 */
  onChange: (kind: CoverChangeKind) => void
  /** 검열 되돌리기 가능 여부가 바뀔 때 */
  onHistory?: (state: CoverHistoryState) => void
}
