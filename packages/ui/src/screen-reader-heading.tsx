import type { ReactNode } from 'react'

export function ScreenReaderHeading({ children }: { children: ReactNode }) {
  return <h1 className="sr-only">{children}</h1>
}
