import * as SwitchPrimitive from '@radix-ui/react-switch'
import type { ComponentProps } from 'react'
import { cn } from '../../lib/utils'

export function Switch({ className, ...props }: ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        'inline-flex h-5 w-[34px] shrink-0 cursor-pointer items-center rounded-full bg-muted/35 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/40 disabled:cursor-default disabled:opacity-50 data-[state=checked]:bg-accent',
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb className="block size-4 translate-x-0.5 rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,0.25)] transition-transform data-[state=checked]:translate-x-4" />
    </SwitchPrimitive.Root>
  )
}
