import { cva, type VariantProps } from 'class-variance-authority'
import type { ComponentProps } from 'react'
import { cn } from '../../lib/utils'

const buttonVariants = cva(
  'inline-flex select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-[13px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/40 disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        // 보조 동작: 회색 채움 (토스 weak, 애플 secondary)
        default:
          'border border-transparent bg-surface-2 text-ink hover:brightness-[0.97] dark:hover:brightness-110',
        // 핵심 동작: 한 화면에 하나만
        accent: 'bg-accent font-semibold text-white hover:opacity-90 dark:text-paper',
        // 두 번째로 중요한 동작: 연한 강조색 채움
        tint: 'bg-accent-soft font-semibold text-accent hover:opacity-85',
        // 테두리만 (입력칸 옆 같은 흰 바탕 위)
        outline: 'border border-line bg-surface text-ink hover:bg-surface-2',
        // 투명 테두리를 미리 깔아 ghost→default 전환 시 border-color가 currentColor(검정/흰)에서
        // 시작해 반짝이는 것 방지 (transition-colors가 transparent→border-line만 애니메이션)
        ghost: 'border border-transparent text-muted hover:bg-surface-2 hover:text-ink',
        // 삭제·되돌릴 수 없는 동작: 빨간 글씨, 누르면 연한 빨강
        danger: 'border border-transparent text-danger hover:bg-danger/10',
        // 확인 대화창의 최종 삭제 버튼만 빨간 채움
        'danger-fill': 'bg-danger font-semibold text-white hover:opacity-90'
      },
      size: {
        sm: 'h-7 px-2.5',
        md: 'h-8 px-3',
        lg: 'h-10 px-4 text-[14px]',
        icon: 'size-8',
        'icon-sm': 'size-7'
      }
    },
    defaultVariants: { variant: 'default', size: 'md' }
  }
)

export function Button({
  className,
  variant,
  size,
  loading,
  children,
  ...props
}: ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    /** 기다리는 중: 글자 자리에 점 세 개. 너비는 그대로, 누를 수 없음 (토스 Button loading) */
    loading?: boolean
  }): React.JSX.Element {
  return (
    <button
      {...props}
      className={cn(buttonVariants({ variant, size }), loading && 'relative', className)}
      aria-busy={loading || undefined}
      disabled={props.disabled || loading}
    >
      {loading ? (
        <>
          <span className="contents opacity-0" aria-hidden>
            {children}
          </span>
          <span
            className="absolute inset-0 flex items-center justify-center gap-1"
            aria-label="진행 중"
          >
            {[0, 1, 2].map((i) => (
              <i
                key={i}
                className="size-1.5 animate-bounce rounded-full bg-current motion-reduce:animate-pulse"
                style={{ animationDelay: `${i * 0.15}s`, animationDuration: '0.9s' }}
              />
            ))}
          </span>
        </>
      ) : (
        children
      )}
    </button>
  )
}
