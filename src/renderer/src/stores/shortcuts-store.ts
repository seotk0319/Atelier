import { create } from 'zustand'
import { useCharactersStore } from './characters-store'
import { useFragmentsStore } from './fragments-store'
import { useGenerationStore } from './generation-store'
import { useLayoutStore } from './layout-store'
import { useCharRefsStore, useVibesStore } from './refs-store'
import { useScenesStore } from './scenes-store'
import { toast } from './toast-store'

export type ShortcutAction =
  | 'generate'
  | 'toggleLeft'
  | 'toggleRight'
  | 'openSettings'
  | 'modeMain'
  | 'modeScene'
  | 'modeDirector'
  | 'openCharacter'
  | 'openFragment'
  | 'openVibe'
  | 'openCharRef'
  | 'openParams'
  | 'resetFragmentCounters'
  | 'curationFavorite'
  | 'refreshWork'

export const SHORTCUT_LABELS: Record<ShortcutAction, string> = {
  generate: '생성 / 씬 생성',
  toggleLeft: '프롬프트 패널 토글',
  toggleRight: '히스토리 패널 토글',
  openSettings: '설정 열기',
  modeMain: '메인 모드',
  modeScene: '씬 모드',
  modeDirector: '디렉터 모드',
  openCharacter: '캐릭터 열기',
  openFragment: '조각 열기',
  openVibe: '바이브 열기',
  openCharRef: '레퍼런스 열기',
  openParams: '생성 파라미터 열기',
  resetFragmentCounters: '조각 순차 카운터 리셋',
  curationFavorite: '선별 토글 (선별 작업)',
  refreshWork: '작업 새로고침 / 큐 초기화'
}

const DEFAULTS: Record<ShortcutAction, string> = {
  generate: 'Mod+Enter',
  toggleLeft: 'Mod+[',
  toggleRight: 'Mod+]',
  openSettings: 'Mod+,',
  modeMain: 'Mod+1',
  modeScene: 'Mod+2',
  modeDirector: 'Mod+3',
  openCharacter: 'Mod+D',
  openFragment: 'Mod+F',
  openVibe: 'Mod+I',
  openCharRef: 'Mod+Shift+I',
  openParams: 'Mod+P',
  resetFragmentCounters: 'Mod+Shift+R',
  curationFavorite: 'F',
  refreshWork: 'F5'
}

const isMac = typeof navigator !== 'undefined' && navigator.platform.toLowerCase().includes('mac')

/** KeyboardEvent → 정규화 콤보 문자열 (예: "Mod+Enter") */
export function comboFromEvent(e: KeyboardEvent): string | null {
  const mod = ['Meta', 'Control', 'Shift', 'Alt']
  if (mod.includes(e.key)) return null // 수정자만 눌린 상태는 무시
  const parts: string[] = []
  if (e.metaKey || e.ctrlKey) parts.push('Mod')
  if (e.shiftKey) parts.push('Shift')
  if (e.altKey) parts.push('Alt')
  parts.push(e.key.length === 1 ? e.key.toUpperCase() : e.key)
  return parts.join('+')
}

/** 표시용 (⌘/Ctrl, ↵ 등) */
export function formatCombo(combo: string): string {
  return combo
    .replace('Mod', isMac ? '⌘' : 'Ctrl')
    .replace('Enter', '↵')
    .replace('Shift', '⇧')
    .replace('Alt', isMac ? '⌥' : 'Alt')
    .split('+')
    .join(' ')
}

interface ShortcutsState {
  bindings: Record<ShortcutAction, string>
  recording: ShortcutAction | null
  setRecording: (a: ShortcutAction | null) => void
  setBinding: (a: ShortcutAction, combo: string) => void
  resetDefaults: () => void
  hydrate: () => Promise<void>
}

export async function refreshWork(): Promise<void> {
  await window.nais.invoke('queue:reset', undefined)
  await useScenesStore.getState().clearReserveAll(true)
  window.location.reload()
}

function runAction(action: ShortcutAction): void {
  const layout = useLayoutStore.getState()
  switch (action) {
    case 'generate': {
      if (layout.centerMode === 'scene') {
        // 모든 프리셋의 예약을 넣는다 (「예약 N장 생성」 단추와 같은 동작)
        if (useScenesStore.getState().reservedTotal > 0)
          void useScenesStore.getState().generateAllReserved()
      } else {
        void useGenerationStore.getState().generate()
      }
      break
    }
    case 'toggleLeft':
      layout.toggleLeft()
      break
    case 'toggleRight':
      layout.toggleRight()
      break
    case 'openSettings':
      layout.setSettingsOpen(true)
      break
    case 'modeMain':
      layout.setCenterMode('main')
      break
    case 'modeScene':
      layout.setCenterMode('scene')
      break
    case 'modeDirector':
      layout.setCenterMode('director')
      break
    case 'openCharacter':
      toggleOverlay('char')
      break
    case 'openFragment':
      toggleOverlay('frag')
      break
    case 'openVibe':
      toggleOverlay('vibe')
      break
    case 'openCharRef':
      toggleOverlay('cref')
      break
    case 'openParams':
      window.dispatchEvent(new CustomEvent('shortcut:openParams'))
      break
    case 'resetFragmentCounters':
      void useFragmentsStore
        .getState()
        .resetSequential()
        .then(() => toast('조각 순차 카운터를 처음으로 되돌렸어요', 'success'))
      break
    case 'curationFavorite':
      window.dispatchEvent(new CustomEvent('nais:curation-favorite'))
      break
    case 'refreshWork':
      void refreshWork()
      break
  }
}

function toggleOverlay(target: 'char' | 'frag' | 'vibe' | 'cref'): void {
  const layout = useLayoutStore.getState()
  if (!layout.leftOpen) layout.toggleLeft()
  const chars = useCharactersStore.getState()
  const frags = useFragmentsStore.getState()
  const vibes = useVibesStore.getState()
  const crefs = useCharRefsStore.getState()
  const open = {
    char: chars.overlayOpen,
    frag: frags.overlayOpen,
    vibe: vibes.overlayOpen,
    cref: crefs.overlayOpen
  }
  const willOpen = !open[target]
  chars.setOverlayOpen(false)
  frags.setOverlayOpen(false)
  vibes.setOverlayOpen(false)
  crefs.setOverlayOpen(false)
  if (!willOpen) return
  if (target === 'char') chars.setOverlayOpen(true)
  else if (target === 'frag') frags.setOverlayOpen(true)
  else if (target === 'vibe') vibes.setOverlayOpen(true)
  else crefs.setOverlayOpen(true)
}

export const useShortcutsStore = create<ShortcutsState>((set, get) => ({
  bindings: { ...DEFAULTS },
  recording: null,
  setRecording: (recording) => set({ recording }),
  setBinding: (a, combo) => {
    const bindings = { ...get().bindings, [a]: combo }
    set({ bindings, recording: null })
    void window.nais.invoke('settings:set', { key: 'shortcuts', value: JSON.stringify(bindings) })
  },
  resetDefaults: () => {
    set({ bindings: { ...DEFAULTS } })
    void window.nais.invoke('settings:set', {
      key: 'shortcuts',
      value: JSON.stringify(DEFAULTS)
    })
  },
  hydrate: async () => {
    const { value } = await window.nais.invoke('settings:get', { key: 'shortcuts' })
    if (value) {
      try {
        set({ bindings: { ...DEFAULTS, ...JSON.parse(value) } })
      } catch {
        /* 무시 */
      }
    }
  }
}))

/** 전역 키다운 핸들러 — App에서 1회 바인딩 */
export function bindShortcuts(): () => void {
  const handler = (e: KeyboardEvent): void => {
    const st = useShortcutsStore.getState()
    // 단축키 녹화 중이면 여기서 처리하지 않음 (설정 UI가 직접 캡처)
    if (st.recording) return
    const combo = comboFromEvent(e)
    if (!combo) return
    const entry = (Object.entries(st.bindings) as [ShortcutAction, string][]).find(
      ([, c]) => c === combo
    )
    if (!entry) return
    // 텍스트 입력 중엔 Enter 단독 등은 방해하지 않되, Mod 조합 단축키는 허용
    const target = e.target as HTMLElement | null
    const typing =
      target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable
    if (typing && !e.metaKey && !e.ctrlKey && entry[0] !== 'refreshWork') return
    // 모달 창(마스크·모자이크 편집, 설정, 일괄 주입 등) 위에서는 뒤 화면 단축키를 쓰지 않는다 —
    // 인페인트 마스크 창에서 Ctrl+Enter가 메인 생성을, Ctrl+F가 뒤의 조각 창을 열던 문제.
    // 생성 파라미터 창만 생성·창 닫기(Ctrl+P)를 그대로 받는다.
    const modal = document.querySelector('[data-modal-dialog]')
    if (
      modal &&
      !(
        modal.hasAttribute('data-allow-shortcuts') &&
        (entry[0] === 'generate' || entry[0] === 'openParams')
      )
    )
      return
    e.preventDefault()
    runAction(entry[0])
  }
  window.addEventListener('keydown', handler)
  return () => window.removeEventListener('keydown', handler)
}
