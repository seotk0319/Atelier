import * as ToggleGroupPrimitive from '@radix-ui/react-toggle-group'
import type { ToggleGroupSingleProps } from '@radix-ui/react-toggle-group'
import type { ComponentProps } from 'react'
import { cn } from '../../lib/utils'

/**
 * 여럿 중 하나를 고르는 칸. 상단 탭과 같은 "흰 알약" 모양 하나로 통일한다.
 * (토스 Segmented Control / 애플 segmented picker)
 * - 고른 칸: 흰 바탕 + 진한 글씨 + 얇은 그림자
 * - 나머지: 회색 글씨, 마우스 올리면 진한 글씨
 */
export function Segmented({
  className,
  size = 'md',
  ...props
}: Omit<ToggleGroupSingleProps, 'type'> & {
  size?: 'sm' | 'md'
}): React.JSX.Element {
  return (
    <ToggleGroupPrimitive.Root
      type="single"
      data-size={size}
      className={cn(
        'group/seg inline-flex shrink-0 items-center gap-0.5 rounded-lg bg-surface-2 p-0.5',
        className
      )}
      {...props}
    />
  )
}

export function SegmentedItem({
  className,
  ...props
}: ComponentProps<typeof ToggleGroupPrimitive.Item>): React.JSX.Element {
  return (
    <ToggleGroupPrimitive.Item
      className={cn(
        'group inline-flex h-7 min-w-7 select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-2.5 text-[12px] font-medium text-muted outline-none transition-colors',
        'group-data-[size=sm]/seg:h-6 group-data-[size=sm]/seg:min-w-6 group-data-[size=sm]/seg:px-2 group-data-[size=sm]/seg:text-[11px]',
        'hover:text-ink focus-visible:ring-2 focus-visible:ring-accent/40 disabled:pointer-events-none disabled:opacity-40',
        'data-[state=on]:bg-surface data-[state=on]:font-semibold data-[state=on]:text-ink data-[state=on]:shadow-[0_1px_2px_rgba(0,0,0,0.10),0_0_0_0.5px_rgba(0,0,0,0.05)]',
        className
      )}
      {...props}
    />
  )
}

/** 개수 같은 보조 숫자. 고른 칸에서는 조금 더 진하게. */
export function SegmentedCount({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <span className="text-[11px] font-medium tabular-nums text-faint group-data-[state=on]:text-muted">
      {children}
    </span>
  )
}
