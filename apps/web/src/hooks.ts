import { useEffect, useState } from 'react'

export function useDocumentTitle(title: string): void {
  useEffect(() => {
    document.title = `${title} · PrickleScope`
    return () => {
      document.title = 'PrickleScope'
    }
  }, [title])
}

export type Theme = 'light' | 'dark'

function preferredTheme(): Theme {
  const stored = localStorage.getItem('pricklescope-theme')
  if (stored === 'light' || stored === 'dark') return stored
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

// Reads the theme that useTheme writes to the document, so components outside the
// shell follow a toggle without owning their own copy of the state.
export function useDocumentTheme(): Theme {
  const [theme, setTheme] = useState<Theme>(preferredTheme)
  useEffect(() => {
    const root = document.documentElement
    const sync = () => setTheme(root.dataset.theme === 'dark' ? 'dark' : 'light')
    sync()
    const observer = new MutationObserver(sync)
    observer.observe(root, { attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])
  return theme
}

export function useTheme(): { theme: Theme; toggleTheme: () => void } {
  const [theme, setTheme] = useState<Theme>(preferredTheme)
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('pricklescope-theme', theme)
  }, [theme])
  return {
    theme,
    toggleTheme: () => setTheme((current) => (current === 'dark' ? 'light' : 'dark')),
  }
}
