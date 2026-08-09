import type { ReactNode } from 'react'

import { cn } from './cn.js'

export function StatusPill({
  tone,
  children,
  className,
}: {
  tone: 'positive' | 'warning' | 'negative' | 'neutral'
  children: ReactNode
  className?: string
}) {
  return <span className={cn('status-pill', `status-pill--${tone}`, className)}>{children}</span>
}
