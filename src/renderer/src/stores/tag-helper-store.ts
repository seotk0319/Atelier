import { create } from 'zustand'
import type { TagHelperMode } from '@shared/tag-helper'

export interface TagHelperImage {
  /** data: 접두사 없는 base64 */
  base64: string
  mime: string
}

export interface TagHelperOpenOptions {
  /** 기본값 character */
  mode?: TagHelperMode
  image?: TagHelperImage
  text?: string
  /** 결과를 받을 곳. 없으면 복사만 할 수 있다. */
  onApply?: (tags: string, how: 'replace' | 'append') => void
  /** "가변 프롬프트"처럼 결과가 들어갈 자리 이름 */
  targetLabel?: string
}

interface TagHelperState {
  isOpen: boolean
  /** 열 때마다 1씩 — 같은 옵션으로 다시 열어도 안쪽 입력 상태를 새로 시작한다 */
  seq: number
  mode: TagHelperMode
  image: TagHelperImage | null
  text: string
  onApply: TagHelperOpenOptions['onApply']
  targetLabel: string | null
  open: (options?: TagHelperOpenOptions) => void
  close: () => void
}

export const useTagHelperStore = create<TagHelperState>((set) => ({
  isOpen: false,
  seq: 0,
  mode: 'character',
  image: null,
  text: '',
  onApply: undefined,
  targetLabel: null,
  open: (options) =>
    set((state) => ({
      isOpen: true,
      seq: state.seq + 1,
      mode: options?.mode ?? 'character',
      image: options?.image ?? null,
      text: options?.text ?? '',
      onApply: options?.onApply,
      targetLabel: options?.targetLabel ?? null
    })),
  close: () => set({ isOpen: false, onApply: undefined, targetLabel: null })
}))
