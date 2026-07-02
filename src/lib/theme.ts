// Light/dark theming. The chosen mode is persisted in settings (IndexedDB) and
// mirrored to localStorage so an inline boot script can apply it before first
// paint (no flash). 'system' follows the OS preference live.

export type Theme = 'system' | 'light' | 'dark'

const LS_KEY = 'understudy-theme'

export function resolveTheme(theme: Theme): 'light' | 'dark' {
  if (theme === 'light' || theme === 'dark') return theme
  return typeof window !== 'undefined' &&
    window.matchMedia &&
    window.matchMedia('(prefers-color-scheme: light)').matches
    ? 'light'
    : 'dark'
}

export function applyTheme(theme: Theme): void {
  if (typeof document === 'undefined') return
  const resolved = resolveTheme(theme)
  document.documentElement.dataset.theme = resolved
  document.documentElement.style.colorScheme = resolved
  try {
    localStorage.setItem(LS_KEY, theme)
  } catch {
    /* ignore */
  }
}
