// Optional free neural voice: Kokoro-82M, running fully in-browser (WebGPU
// where available, WASM fallback). Synthesis happens in a Web Worker
// (kokoro.worker.ts) so the seconds-per-line WASM inference never blocks the
// UI — generating a play's voices on first run must not freeze button clicks.
// Cached per line after first generation (see Speaker/audioCache).

import type { TTSVoice } from './webspeech'

// Kokoro v1.0 voices with gender hints for casting. UK voices FIRST — they are
// the auto-cast default and lead the pickers (the user's plays are UK-English);
// Kokoro ships no AU voices, so US follows directly. Order matters: the
// auto-caster consumes this list top-down per gender.
export const KOKORO_VOICES: (TTSVoice & { gender: 'f' | 'm' })[] = [
  // UK
  { id: 'bf_emma', label: 'Emma — female (UK)', gender: 'f' },
  { id: 'bf_alice', label: 'Alice — female (UK)', gender: 'f' },
  { id: 'bf_isabella', label: 'Isabella — female (UK)', gender: 'f' },
  { id: 'bf_lily', label: 'Lily — female (UK)', gender: 'f' },
  { id: 'bm_george', label: 'George — male (UK)', gender: 'm' },
  { id: 'bm_lewis', label: 'Lewis — male (UK)', gender: 'm' },
  { id: 'bm_daniel', label: 'Daniel — male (UK)', gender: 'm' },
  { id: 'bm_fable', label: 'Fable — male (UK)', gender: 'm' },
  // US
  { id: 'af_heart', label: 'Heart — warm female (US)', gender: 'f' },
  { id: 'af_bella', label: 'Bella — bright female (US)', gender: 'f' },
  { id: 'af_nicole', label: 'Nicole — soft female (US)', gender: 'f' },
  { id: 'af_sarah', label: 'Sarah — measured female (US)', gender: 'f' },
  { id: 'am_michael', label: 'Michael — steady male (US)', gender: 'm' },
  { id: 'am_fenrir', label: 'Fenrir — deep male (US)', gender: 'm' },
  { id: 'am_puck', label: 'Puck — lively male (US)', gender: 'm' },
  { id: 'am_adam', label: 'Adam — plain male (US)', gender: 'm' },
]

interface WorkerResult {
  type: 'ready' | 'result' | 'error'
  id?: number
  blob?: Blob
  message?: string
}

let worker: Worker | null = null
let readyPromise: Promise<void> | null = null
let readyResolve: (() => void) | null = null
let readyReject: ((e: Error) => void) | null = null
let reqId = 0
const pending = new Map<number, { resolve: (b: Blob) => void; reject: (e: Error) => void }>()

function ensureWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./kokoro.worker.ts', import.meta.url), { type: 'module' })
    worker.addEventListener('message', (ev: MessageEvent<WorkerResult>) => {
      const m = ev.data
      if (m.type === 'ready') {
        readyResolve?.()
      } else if (m.type === 'result' && m.id != null) {
        pending.get(m.id)?.resolve(m.blob!)
        pending.delete(m.id)
      } else if (m.type === 'error') {
        const err = new Error(m.message ?? 'Voice generation failed')
        if (m.id != null) {
          pending.get(m.id)?.reject(err)
          pending.delete(m.id)
        } else {
          readyReject?.(err)
          readyPromise = null // allow a retry after a failed load
        }
      }
    })
  }
  return worker
}

function ensureReady(): Promise<void> {
  if (!readyPromise) {
    readyPromise = new Promise<void>((resolve, reject) => {
      readyResolve = resolve
      readyReject = reject
      ensureWorker().postMessage({ type: 'load' })
    })
  }
  return readyPromise
}

/** Pre-load the model (in the worker) so the first line isn't slow. */
export async function warmupKokoro(): Promise<void> {
  await ensureReady()
}

export async function generateKokoro(text: string, voiceId = 'af_heart'): Promise<Blob> {
  await ensureReady()
  const id = ++reqId
  return new Promise<Blob>((resolve, reject) => {
    pending.set(id, { resolve, reject })
    ensureWorker().postMessage({ type: 'generate', id, text, voice: voiceId })
  })
}
