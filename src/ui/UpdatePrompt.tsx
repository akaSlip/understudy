import { useEffect, useState } from 'react'

// User-facing PWA update notice. When a new version of the app has been
// downloaded by the service worker, we ask before reloading (a silent reload
// mid-rehearsal would be jarring). Also shows a one-off "ready offline" note.

export function UpdatePrompt() {
  const [needRefresh, setNeedRefresh] = useState(false)
  const [offlineReady, setOfflineReady] = useState(false)

  useEffect(() => {
    const onNeed = () => setNeedRefresh(true)
    const onOffline = () => setOfflineReady(true)
    window.addEventListener('pwa:need-refresh', onNeed)
    window.addEventListener('pwa:offline-ready', onOffline)
    return () => {
      window.removeEventListener('pwa:need-refresh', onNeed)
      window.removeEventListener('pwa:offline-ready', onOffline)
    }
  }, [])

  if (needRefresh) {
    return (
      <div className="pwa-toast" role="alert">
        <span>A new version of Understudy is ready.</span>
        <div className="pwa-toast-actions">
          <button
            className="primary small"
            onClick={() => {
              const fn = (window as unknown as { __updateSW?: (reload?: boolean) => Promise<void> }).__updateSW
              // updateSW(true) normally skip-waits + reloads, but some service
              // worker states leave it a no-op — reload regardless so the
              // button always visibly acts.
              setTimeout(() => window.location.reload(), 1200)
              void fn?.(true)
            }}
          >
            Reload
          </button>
          <button className="ghost small" onClick={() => setNeedRefresh(false)}>
            Later
          </button>
        </div>
      </div>
    )
  }

  if (offlineReady) {
    return (
      <div className="pwa-toast" role="status">
        <span>Ready to rehearse offline.</span>
        <div className="pwa-toast-actions">
          <button className="ghost small" onClick={() => setOfflineReady(false)}>
            Dismiss
          </button>
        </div>
      </div>
    )
  }

  return null
}
