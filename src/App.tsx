import { useEffect, useState } from 'react'
import { applyTheme, type Theme } from './lib/theme'
import { Library } from './ui/Library'
import { Editor } from './ui/Editor'
import { Rehearsal } from './ui/Rehearsal'
import { Settings } from './ui/Settings'
import { Help } from './ui/Help'
import { UpdatePrompt } from './ui/UpdatePrompt'
import { useApp } from './ui/useApp'

export type Route =
  | { view: 'library' }
  | { view: 'edit'; playId?: string }
  | { view: 'rehearse'; playId: string }
  | { view: 'settings' }
  | { view: 'help' }

const THEME_ORDER: Theme[] = ['system', 'light', 'dark']
const THEME_ICON: Record<Theme, string> = { system: '◐', light: '☀', dark: '☾' }

export function App() {
  const { ready, settings, updateSettings } = useApp()
  const [route, setRoute] = useState<Route>({ view: 'library' })

  // Apply the theme and follow the OS preference live when set to 'system'.
  useEffect(() => {
    applyTheme(settings.theme)
    if (settings.theme !== 'system' || typeof window === 'undefined' || !window.matchMedia) return
    const mq = window.matchMedia('(prefers-color-scheme: light)')
    const onChange = () => applyTheme('system')
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [settings.theme])

  const cycleTheme = () =>
    updateSettings({ theme: THEME_ORDER[(THEME_ORDER.indexOf(settings.theme) + 1) % THEME_ORDER.length] })

  if (!ready) {
    return (
      <div className="app-loading">
        <div className="logo-mark">◐</div>
        <p>Loading Understudy…</p>
      </div>
    )
  }

  return (
    <div className="app">
      <header className="topbar">
        <button className="brand" onClick={() => setRoute({ view: 'library' })}>
          <span className="logo-mark">◐</span> Understudy
        </button>
        <nav>
          <button className={route.view === 'library' ? 'active' : ''} onClick={() => setRoute({ view: 'library' })}>
            Library
          </button>
          <button className={route.view === 'settings' ? 'active' : ''} onClick={() => setRoute({ view: 'settings' })}>
            Settings
          </button>
          <button
            className={`icon-btn ${route.view === 'help' ? 'active' : ''}`}
            onClick={() => setRoute({ view: 'help' })}
            aria-label="Help"
            title="Help"
          >
            ?
          </button>
          <button
            className="theme-toggle"
            onClick={cycleTheme}
            title={`Theme: ${settings.theme} — click to change`}
            aria-label={`Theme: ${settings.theme}`}
          >
            {THEME_ICON[settings.theme]}
          </button>
        </nav>
      </header>

      <main className="content">
        {route.view === 'library' && <Library go={setRoute} />}
        {route.view === 'edit' && <Editor playId={route.playId} go={setRoute} />}
        {route.view === 'rehearse' && <Rehearsal playId={route.playId} go={setRoute} />}
        {route.view === 'settings' && <Settings />}
        {route.view === 'help' && <Help />}
      </main>

      <UpdatePrompt />
    </div>
  )
}
