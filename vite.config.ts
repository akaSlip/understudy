import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// Understudy is a fully client-side, offline-first PWA.
// - The Whisper recognizer and the optional Kokoro neural voice are heavy and
//   loaded lazily inside a Web Worker / dynamic import, so they are excluded
//   from Vite's dep pre-bundling.
// - The service worker precaches the app shell; large ML models are cached at
//   runtime by the browser (IndexedDB via transformers.js) rather than precached.
// A build stamp so the running app can show which build it is — handy for
// confirming a fresh load vs. a stale cached service worker.
const BUILD_STAMP = new Date().toISOString().slice(0, 16).replace('T', ' ')

export default defineConfig({
  define: {
    __BUILD_STAMP__: JSON.stringify(BUILD_STAMP),
  },
  plugins: [
    react(),
    VitePWA({
      // 'prompt' so users are asked before reloading to a new version, rather
      // than the page silently swapping under them mid-rehearsal.
      registerType: 'prompt',
      includeAssets: ['favicon.svg', 'icon-192.png', 'icon-512.png'],
      manifest: {
        name: 'Understudy — Line Rehearsal',
        short_name: 'Understudy',
        description:
          'A TTS scene partner that performs the other characters, waits for your lines, and scores them in real time — fully offline.',
        theme_color: '#0e0f13',
        background_color: '#0e0f13',
        display: 'standalone',
        orientation: 'any',
        start_url: '/',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          { src: 'favicon.svg', sizes: 'any', type: 'image/svg+xml' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{css,html,svg,png,woff2}', 'assets/index-*.js', 'assets/workbox-*.js'],
        // Precache the app shell only. Big optional chunks (Kokoro ~2 MB) and
        // the ONNX WASM (~20 MB) are cached at runtime on first use instead of
        // bloating the install.
        maximumFileSizeToCacheInBytes: 1024 * 1024,
        navigateFallbackDenylist: [/^\/api/],
        runtimeCaching: [
          {
            // ONNX runtime WASM — makes on-device Whisper work offline after 1st run.
            urlPattern: ({ sameOrigin, url }) => sameOrigin && url.pathname.endsWith('.wasm'),
            handler: 'CacheFirst',
            options: { cacheName: 'onnx-wasm', expiration: { maxEntries: 8 } },
          },
          {
            // Lazy app chunks (hashed → safe to CacheFirst): worker, Kokoro, etc.
            urlPattern: ({ sameOrigin, request }) => sameOrigin && request.destination === 'script',
            handler: 'CacheFirst',
            options: { cacheName: 'app-scripts', expiration: { maxEntries: 24 } },
          },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
  worker: {
    format: 'es',
  },
  optimizeDeps: {
    // These pull large WASM/ONNX runtimes; let them resolve lazily.
    exclude: ['@huggingface/transformers', 'kokoro-js', 'pdfjs-dist', 'tesseract.js'],
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2000,
  },
})
