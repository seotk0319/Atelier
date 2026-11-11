import { ImagePlus, Type } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { droppedImagePaths, hasImageDrop } from '../lib/image-drag'
import { cn } from '../lib/utils'
import { sendToCover } from '../stores/cover-store'
import { useLayoutStore, type CenterMode } from '../stores/layout-store'

type Page = CenterMode

const PAGES: { id: Page; label: string }[] = [
  { id: 'main', label: '생성' },
  { id: 'scene', label: '씬' },
  { id: 'curation', label: '선별' },
  { id: 'director', label: '디렉터' },
  { id: 'library', label: '라이브러리' },
  { id: 'gpt', label: 'GPT 이미지' },
  { id: 'cover', label: '표지' },
  { id: 'inbox', label: '알림' }
]

/**
 * 머리줄 탭. 글자 탭이고, 지금 탭 아래에 2px 밑줄을 긋는다.
 * 이미지를 끌고 탭 위에 잠깐 머물면 그 탭이 열린다.
 */
export function PageNav(): React.JSX.Element {
  const centerMode = useLayoutStore((s) => s.centerMode)
  const setCenterMode = useLayoutStore((s) => s.setCenterMode)
  const hiddenPages = useLayoutStore((s) => s.hiddenPages)
  const [profile, setProfile] = useState(0)
  useEffect(() => {
    void window.nais.invoke('app:profile', undefined).then((v) => setProfile(v.profile))
  }, [])
  const visible = PAGES.filter(
    (p) => (p.id !== 'inbox' || profile === 1) && (p.id === 'main' || !hiddenPages.includes(p.id))
  )
  const activePage: Page = centerMode
  // 이미지를 끌고 탭 위에 잠깐 머물면 그 탭이 열린다 (라이브러리 → 표지·GPT 로 끌어 넣기)
  const springTimer = useRef(0)
  const [springPage, setSpringPage] = useState<Page | null>(null)
  const cancelSpring = (): void => {
    window.clearTimeout(springTimer.current)
    setSpringPage(null)
  }
  const startSpring = (e: React.DragEvent, page: Page): void => {
    if (!hasImageDrop(e) || page === activePage || springPage === page) return
    // 표지는 탭을 넘기지 않고 바로 아래에 놓을 자리를 펼친다
    // (끄는 도중 원래 화면을 숨기면 실제 끌기가 끊긴다)
    if (page === 'cover') {
      openCoverDrop(e.currentTarget as HTMLElement)
      return
    }
    window.clearTimeout(springTimer.current)
    setSpringPage(page)
    springTimer.current = window.setTimeout(() => {
      setSpringPage(null)
      setCenterMode(page)
    }, 450)
  }
  useEffect(() => () => window.clearTimeout(springTimer.current), [])

  const [coverDrop, setCoverDrop] = useState<{ x: number; y: number } | null>(null)
  const closeTimer = useRef(0)
  const openCoverDrop = (el: HTMLElement): void => {
    window.clearTimeout(closeTimer.current)
    if (coverDrop) return
    const r = el.getBoundingClientRect()
    setCoverDrop({ x: r.left + r.width / 2, y: r.bottom + 6 })
  }
  const closeCoverDropSoon = (): void => {
    window.clearTimeout(closeTimer.current)
    closeTimer.current = window.setTimeout(() => setCoverDrop(null), 200)
  }
  useEffect(() => {
    if (!coverDrop) return
    const end = (): void => setCoverDrop(null)
    window.addEventListener('dragend', end)
    window.addEventListener('drop', end)
    return () => {
      window.removeEventListener('dragend', end)
      window.removeEventListener('drop', end)
      window.clearTimeout(closeTimer.current)
    }
  }, [coverDrop])

  return (
    <>
      <nav className="no-drag flex h-full min-w-0 items-stretch overflow-x-auto no-scrollbar">
        {visible.map((page) => {
          const active = activePage === page.id
          const springing = springPage === page.id || (page.id === 'cover' && coverDrop)
          return (
            <button
              key={page.id}
              data-page={page.id}
              aria-current={active ? 'page' : undefined}
              onClick={() => setCenterMode(page.id)}
              onDragEnter={(e) => startSpring(e, page.id)}
              onDragOver={(e) => startSpring(e, page.id)}
              onDragLeave={() => {
                cancelSpring()
                if (page.id === 'cover') closeCoverDropSoon()
              }}
              onDrop={cancelSpring}
              className={cn(
                'relative shrink-0 whitespace-nowrap px-3 text-[14px] font-semibold outline-none transition-colors focus-visible:bg-surface-2',
                active ? 'text-ink' : 'text-muted hover:text-ink',
                springing && 'bg-accent-soft text-accent'
              )}
            >
              {page.label}
              {active && (
                <span
                  aria-hidden
                  className="pointer-events-none absolute inset-x-3 bottom-0 h-0.5 bg-mark"
                />
              )}
            </button>
          )
        })}
      </nav>
      {coverDrop &&
        createPortal(
          <div
            className="fixed z-[60] flex -translate-x-1/2 gap-2 rounded-xl border border-line bg-surface p-2 shadow-xl"
            style={{ left: coverDrop.x, top: coverDrop.y }}
            onDragEnter={() => window.clearTimeout(closeTimer.current)}
            onDragOver={(e) => {
              window.clearTimeout(closeTimer.current)
              e.preventDefault()
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) closeCoverDropSoon()
            }}
          >
            <CoverDropZone kind="backgrounds" onDone={() => setCoverDrop(null)} />
            <CoverDropZone kind="typos" onDone={() => setCoverDrop(null)} />
          </div>,
          document.body
        )}
    </>
  )
}

/** 표지 탭 아래에 펼쳐지는 놓을 자리. 놓으면 표지에 넣고 표지 탭을 연다 */
function CoverDropZone({
  kind,
  onDone
}: {
  kind: 'backgrounds' | 'typos'
  onDone: () => void
}): React.JSX.Element {
  const [over, setOver] = useState(false)
  const Icon = kind === 'backgrounds' ? ImagePlus : Type
  return (
    <div
      className={cn(
        'flex h-[76px] w-[132px] flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed text-[12px] font-semibold transition-colors',
        over ? 'border-accent bg-accent-soft text-accent' : 'border-line text-muted'
      )}
      onDragOver={(e) => {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        e.stopPropagation()
        const paths = droppedImagePaths(e)
        onDone()
        if (paths.length) void sendToCover(paths, kind)
      }}
    >
      <Icon size={18} />
      {kind === 'backgrounds' ? '표지 배경으로' : '표지 타이포로'}
    </div>
  )
}
