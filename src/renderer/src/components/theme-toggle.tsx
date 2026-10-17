import { Monitor, Moon, Sun } from 'lucide-react'
import { useThemeStore, type Theme } from '../stores/theme-store'
import { Segmented, SegmentedItem } from './ui/segmented'

const MODES: { mode: Theme; Icon: typeof Sun; label: string }[] = [
  { mode: 'light', Icon: Sun, label: '라이트' },
  { mode: 'dark', Icon: Moon, label: '다크' },
  { mode: 'system', Icon: Monitor, label: '시스템 설정 따름' }
]

export function ThemeToggle(): React.JSX.Element {
  const theme = useThemeStore((s) => s.theme)
  const setTheme = useThemeStore((s) => s.setTheme)

  return (
    <Segmented
      size="sm"
      value={theme}
      onValueChange={(v) => {
        if (v) setTheme(v as Theme)
      }}
      aria-label="색상 모드"
    >
      {MODES.map(({ mode, Icon, label }) => (
        <SegmentedItem key={mode} value={mode} title={label} className="w-7 px-0">
          <Icon size={14} />
        </SegmentedItem>
      ))}
    </Segmented>
  )
}
