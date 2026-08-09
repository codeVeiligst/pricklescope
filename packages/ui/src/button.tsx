import type { ButtonHTMLAttributes, ReactNode } from 'react'

import { cn } from './cn.js'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  size?: 'small' | 'medium'
  icon?: ReactNode
}

export function Button({
  className,
  variant = 'primary',
  size = 'medium',
  icon,
  children,
  type = 'button',
  ...props
}: ButtonProps) {
  return (
    <button
      className={cn('button', `button--${variant}`, `button--${size}`, className)}
      type={type}
      {...props}
    >
      {icon ? <span className="button__icon">{icon}</span> : null}
      {children}
    </button>
  )
}
