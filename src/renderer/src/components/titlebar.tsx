import { Download, Loader2, Minus, PanelLeft, PanelRight, Settings, Square, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { cn } from '../lib/utils'
import { useLayoutStore } from '../stores/layout-store'
import { useUpdateStore } from '../stores/update-store'
import { PageNav } from './page-nav'
import { ThemeToggle } from './theme-toggle'

const isMac = typeof navigator !== 'undefined' && navigator.platform.toLowerCase().includes('mac')

function ctrl(action: 'minimize' | 'maximize' | 'close'): void {
  void window.nais.invoke('window:control', { action })
}

/** 업데이트 발견 시 나타나는 다운로드 버튼 (신호등·패널토글 옆). 클릭 시 자동 업데이트 진행 */
function UpdateButton(): React.JSX.Element | null {
  const status = useUpdateStore((s) => s.status)
  const percent = useUpdateStore((s) => s.percent)
  const version = useUpdateStore((s) => s.version)
  const start = useUpdateStore((s) => s.start)
  const install = useUpdateStore((s) => s.install)

  if (status === 'available') {
    return (
      <BarButton
        onClick={start}
        className="text-accent hover:text-accent"
        title={`업데이트 ${version ?? ''} 다운로드 후 자동 설치`}
      >
        <Download size={15} />
      </BarButton>
    )
  }
  if (status === 'downloading') {
    return (
      <BarButton className="text-accent" title={`업데이트 다운로드 중 ${percent}%`} disabled>
        <Loader2 size={15} className="animate-spin" />
      </BarButton>
    )
  }
  if (status === 'downloaded') {
    return (
      <BarButton
        onClick={install}
        className="text-accent hover:text-accent"
        title={`업데이트 ${version ?? ''} 설치 준비됨 — 누르면 재시작해서 설치`}
      >
        <Download size={15} />
      </BarButton>
    )
  }
  return null
}

function BarButton({
  className,
  active,
  ...props
}: React.ComponentProps<'button'> & { active?: boolean }): React.JSX.Element {
  return (
    <button
      className={cn(
        'no-drag grid h-8 w-8 place-items-center rounded-md text-muted outline-none transition-colors hover:bg-surface-2 hover:text-ink focus-visible:ring-2 focus-visible:ring-accent/40 disabled:pointer-events-none',
        active && 'text-ink',
        className
      )}
      {...props}
    />
  )
}

export function Titlebar(): React.JSX.Element {
  const leftOpen = useLayoutStore((s) => s.leftOpen)
  const rightOpen = useLayoutStore((s) => s.rightOpen)
  const toggleLeft = useLayoutStore((s) => s.toggleLeft)
  const toggleRight = useLayoutStore((s) => s.toggleRight)
  const setSettingsOpen = useLayoutStore((s) => s.setSettingsOpen)
  const [profileTitle, setProfileTitle] = useState<string | null>(null)

  useEffect(() => {
    void window.nais.invoke('app:profile', undefined).then(({ profile, title }) => {
      if (profile > 0) {
        setProfileTitle(title)
        document.title = title
      }
    })
  }, [])

  return (
    <header
      className="drag relative flex h-14 shrink-0 select-none items-stretch gap-1.5 bg-surface pl-4 pr-2"
      style={{ paddingLeft: isMac ? 90 : undefined }}
    >
      {/* 왼쪽: 로고 · 이름 · 탭. 탭 사이 빈 곳과 오른쪽 빈 곳은 창을 끄는 자리 */}
      <span className="mr-3 flex shrink-0 items-center gap-2 whitespace-nowrap text-[15px] font-extrabold tracking-tight text-ink">
        <i aria-hidden className="block size-3.5 rotate-45 rounded-[2px] bg-mark" />
        {profileTitle ?? 'Atelier'}
      </span>
      <PageNav />
      <div className="min-w-4 flex-1" />

      {/* 오른쪽: 업데이트 · 테마 · 패널 · 설정 · 창 컨트롤 */}
      <div className="flex shrink-0 items-center gap-1">
        <UpdateButton />
        <div className="no-drag mx-0.5 shrink-0">
          <ThemeToggle />
        </div>
        <BarButton
          onClick={toggleLeft}
          active={leftOpen}
          title="생성 패널 접기/펴기"
          aria-label="생성 패널 접기/펴기"
          aria-pressed={leftOpen}
        >
          <PanelLeft size={16} />
        </BarButton>
        <BarButton
          onClick={toggleRight}
          active={rightOpen}
          title="히스토리 패널 접기/펴기"
          aria-label="히스토리 패널 접기/펴기"
          aria-pressed={rightOpen}
        >
          <PanelRight size={16} />
        </BarButton>
        <BarButton onClick={() => setSettingsOpen(true)} title="설정" aria-label="설정">
          <Settings size={16} />
        </BarButton>
        {!isMac && (
          <div className="no-drag ml-1 flex shrink-0 items-center">
            <BarButton className="w-10" onClick={() => ctrl('minimize')} aria-label="최소화">
              <Minus size={15} />
            </BarButton>
            <BarButton className="w-10" onClick={() => ctrl('maximize')} aria-label="최대화">
              <Square size={12} />
            </BarButton>
            <BarButton
              className="w-10 hover:bg-bad-fill hover:text-white"
              onClick={() => ctrl('close')}
              aria-label="닫기"
            >
              <X size={15} />
            </BarButton>
          </div>
        )}
      </div>
    </header>
  )
}
