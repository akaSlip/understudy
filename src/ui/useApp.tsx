import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Play } from '../types'
import { getAllPlays, seedIfFirstRun } from '../store/playsRepo'
import { DEFAULT_SETTINGS, loadSettings, saveSettings, type AppSettings } from '../store/settings'

interface AppData {
  ready: boolean
  settings: AppSettings
  updateSettings: (patch: Partial<AppSettings>) => Promise<void>
  plays: Play[]
  reloadPlays: () => Promise<void>
}

const Ctx = createContext<AppData | null>(null)

export function AppProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false)
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS)
  const [plays, setPlays] = useState<Play[]>([])

  const reloadPlays = useCallback(async () => {
    setPlays(await getAllPlays())
  }, [])

  useEffect(() => {
    ;(async () => {
      await seedIfFirstRun()
      setSettings(await loadSettings())
      await reloadPlays()
      setReady(true)
    })()
  }, [reloadPlays])

  const updateSettings = useCallback(
    async (patch: Partial<AppSettings>) => {
      setSettings((prev) => {
        const next = { ...prev, ...patch }
        void saveSettings(next)
        return next
      })
    },
    [],
  )

  const value = useMemo<AppData>(
    () => ({ ready, settings, updateSettings, plays, reloadPlays }),
    [ready, settings, updateSettings, plays, reloadPlays],
  )

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useApp(): AppData {
  const v = useContext(Ctx)
  if (!v) throw new Error('useApp must be used within AppProvider')
  return v
}
