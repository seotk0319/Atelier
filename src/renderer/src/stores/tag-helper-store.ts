import { create } from 'zustand'
import type { TagHelperPart } from '@shared/tag-helper'

export interface TagHelperImage {
  /** data: 접두사 없는 base64 */
  base64: string
  mime: string
}

export interface TagHelperOpenOptions {
  /** 그림에서 뽑을 것의 기본값. 연 곳에 맞춰 준다 (기본 외형+의상) */
  parts?: TagHelperPart[]
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
  parts: TagHelperPart[]
  image: TagHelperImage | null
  text: string
  onApply: TagHelperOpenOptions['onApply']
  targetLabel: string | null
  open: (options?: TagHelperOpenOptions) => void
  close: () => void
}

const DEFAULT_PARTS: TagHelperPart[] = ['look', 'outfit']

export const useTagHelperStore = create<TagHelperState>((set) => ({
  isOpen: false,
  seq: 0,
  parts: DEFAULT_PARTS,
  image: null,
  text: '',
  onApply: undefined,
  targetLabel: null,
  open: (options) =>
    set((state) => ({
      isOpen: true,
      seq: state.seq + 1,
      parts: options?.parts?.length ? options.parts : DEFAULT_PARTS,
      image: options?.image ?? null,
      text: options?.text ?? '',
      onApply: options?.onApply,
      targetLabel: options?.targetLabel ?? null
    })),
  close: () => set({ isOpen: false, onApply: undefined, targetLabel: null })
}))
