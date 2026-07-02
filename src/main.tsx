import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import { App } from './App'
import { AppProvider } from './ui/useApp'
import './styles.css'

// Register the service worker. When a new version is waiting, surface an
// in-app prompt (see UpdatePrompt) instead of reloading silently. updateSW is
// stashed so the prompt's "Reload" can trigger skipWaiting + reload.
const updateSW = registerSW({
  immediate: true,
  onNeedRefresh() {
    window.dispatchEvent(new CustomEvent('pwa:need-refresh'))
  },
  onOfflineReady() {
    window.dispatchEvent(new CustomEvent('pwa:offline-ready'))
  },
})
;(window as unknown as { __updateSW?: (reload?: boolean) => Promise<void> }).__updateSW = updateSW

const root = document.getElementById('root')
if (!root) throw new Error('#root not found')

createRoot(root).render(
  <AppProvider>
    <App />
  </AppProvider>,
)
