import {
  Bell,
  BookImage,
  Image,
  ImagePlus,
  Images,
  LayoutGrid,
  Sparkles,
  Type,
  Wand2,
  type LucideIcon
} from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { droppedImagePaths, hasImageDrop } from '../lib/image-drag'
import { cn } from '../lib/utils'
import { sendToCover } from '../stores/cover-store'
import { useLayoutStore, type CenterMode } from '../stores/layout-store'

type Page = CenterMode

const PAGES: { id: Page; label: string; icon: LucideIcon }[] = [
  { id: 'main', label: '메인', icon: Image },
  { id: 'scene', label: '씬', icon: LayoutGrid },
  { id: 'director', label: '디렉터', icon: Wand2 },
  { id: 'library', label: '라이브러리', icon: Images },
  { id: 'gpt', label: 'GPT 이미지', icon: Sparkles },
  { id: 'cover', label: '표지', icon: BookImage },
  { id: 'inbox', label: '알림', icon: Bell }
]

/**
 * 상단 중앙 페이지 네비게이션 (NAIS2 AnimatedNavBar 이식).
 * 활성 탭 표시(pill)는 버튼 위치를 미리 재 두고 transform으로만 옮긴다.
 * (layoutId 방식은 탭을 바꿀 때마다 화면 배치를 강제로 다시 계산해 전환이 끊겼다)
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
  const navRef = useRef<HTMLElement>(null)
  const [boxes, setBoxes] = useState<Record<string, { x: number; w: number }>>({})
  const [animate, setAnimate] = useState(false)
  const visibleKey = visible.map((p) => p.id).join(',')
  // 버튼 위치는 목록이 바뀌거나 크기가 바뀔 때만 잰다 (탭 전환 때는 재지 않음)
  useLayoutEffect(() => {
    const nav = navRef.current
    if (!nav) return
    const measure = (): void => {
      const next: Record<string, { x: number; w: number }> = {}
      nav.querySelectorAll<HTMLButtonElement>('button[data-page]').forEach((b) => {
        next[b.dataset.page!] = { x: b.offsetLeft, w: b.offsetWidth }
      })
      setBoxes(next)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(nav)
    // 글꼴이 늦게 로드되면 폭이 바뀐다
    void document.fonts?.ready.then(measure)
    return () => ro.disconnect()
  }, [visibleKey])
  // 첫 위치는 애니메이션 없이, 그다음부터 미끄러지게
  useEffect(() => {
    const t = window.setTimeout(() => setAnimate(true), 50)
    return () => window.clearTimeout(t)
  }, [])
  const activePage: Page = centerMode
  const pill = boxes[activePage]
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
      <nav
        ref={navRef}
        className="no-drag pointer-events-auto relative flex items-center gap-0.5 rounded-xl bg-surface-2 p-[3px]"
      >
        {pill && (
          <div
            aria-hidden
            className={cn(
              'pointer-events-none absolute left-0 top-[3px] h-[34px] rounded-lg bg-surface shadow-[0_1px_3px_rgba(0,0,0,0.08),0_1px_1px_rgba(0,0,0,0.04)] motion-reduce:transition-none',
              animate &&
                'transition-[transform,width] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]'
            )}
            style={{ width: pill.w, transform: `translateX(${pill.x}px)` }}
          />
        )}
        {visible.map((page) => {
          const active = activePage === page.id
          return (
            <button
              key={page.id}
              data-page={page.id}
              onClick={() => setCenterMode(page.id)}
              onDragEnter={(e) => startSpring(e, page.id)}
              onDragOver={(e) => startSpring(e, page.id)}
              onDragLeave={() => {
                cancelSpring()
                if (page.id === 'cover') closeCoverDropSoon()
              }}
              onDrop={cancelSpring}
              className={cn(
                'relative h-[34px] whitespace-nowrap rounded-lg px-4 text-[13px] font-semibold transition-colors',
                active ? 'text-ink' : 'text-muted hover:text-ink',
                (springPage === page.id || (page.id === 'cover' && coverDrop)) &&
                  'bg-accent-soft text-accent'
              )}
            >
              <span className="pointer-events-none relative z-10 flex items-center gap-2">
                <page.icon className={cn('size-4', active && 'text-accent')} />
                {page.label}
              </span>
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
