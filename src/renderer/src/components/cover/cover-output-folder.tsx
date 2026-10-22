import { FolderOpen } from 'lucide-react'
import { useEffect } from 'react'
import { useCoverStore } from '../../stores/cover-store'
import { Button } from '../ui/button'

/** 가운데를 줄여 경로의 앞뒤를 함께 보여 준다 */
function middleEllipsis(value: string, max = 58): string {
  if (value.length <= max) return value
  const head = Math.ceil(max * 0.4)
  const tail = max - head - 1
  return value.slice(0, head) + '…' + value.slice(value.length - tail)
}

/** 출력 폴더 한 줄. 고른 폴더가 없으면 먼저 고르게 한다. */
export function CoverOutputFolder(): React.JSX.Element {
  const outputDir = useCoverStore((s) => s.outputDir)
  const refreshOutputDir = useCoverStore((s) => s.refreshOutputDir)
  const pickOutputDir = useCoverStore((s) => s.pickOutputDir)

  useEffect(() => {
    void refreshOutputDir()
  }, [refreshOutputDir])

  if (!outputDir) {
    return (
      <div className="flex min-w-0 items-center gap-2 rounded-lg bg-surface-2 px-2.5 py-1.5">
        <FolderOpen size={15} className="shrink-0 text-faint" />
        <span className="min-w-0 flex-1 truncate text-[12px] text-muted">
          저장할 폴더를 골라 주세요
        </span>
        <Button type="button" variant="tint" size="sm" onClick={() => void pickOutputDir()}>
          폴더 고르기
        </Button>
      </div>
    )
  }

  return (
    <div className="flex min-w-0 items-center gap-2 rounded-lg bg-surface-2 px-2.5 py-1.5">
      <FolderOpen size={15} className="shrink-0 text-muted" />
      <span className="min-w-0 flex-1 truncate text-[12px] text-muted" title={outputDir}>
        {middleEllipsis(outputDir)}
      </span>
      <Button type="button" variant="outline" size="sm" onClick={() => void pickOutputDir()}>
        바꾸기
      </Button>
    </div>
  )
}
