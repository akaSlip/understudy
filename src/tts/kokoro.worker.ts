/// <reference lib="webworker" />
// Kokoro TTS in a Web Worker so on-device neural synthesis NEVER blocks the UI.
// WASM inference takes seconds per line; on the main thread that froze every
// button click during a play's first run-through. Mirrors whisper.worker.ts:
// WebGPU first, WASM fallback.

import { floatToWavBlob } from '../lib/wav'

type InMsg = { type: 'load' } | { type: 'generate'; id: number; text: string; voice: string }

type OutMsg =
  | { type: 'ready' }
  | { type: 'result'; id: number; blob: Blob }
  | { type: 'error'; id?: number; message: string }

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX'

/* eslint-disable @typescript-eslint/no-explicit-any */
let ttsPromise: Promise<any> | null = null

const post = (m: OutMsg) => (self as unknown as Worker).postMessage(m)

function getTTS(): Promise<any> {
  if (!ttsPromise) {
    ttsPromise = (async () => {
      const mod: any = await import('kokoro-js')
      const KokoroTTS = mod.KokoroTTS
      // Probe for a REAL adapter before attempting WebGPU: navigator.gpu can
      // exist with no usable adapter (headless, many Linux setups), and a
      // failed WebGPU session poisons the ORT backend registry so the wasm
      // fallback then fails too ("no available backend found").
      const hasWebGPU =
        typeof navigator !== 'undefined' &&
        'gpu' in navigator &&
        !!(await (navigator as any).gpu.requestAdapter().catch(() => null))
      const attempts: Array<{ dtype: string; device: string }> = hasWebGPU
        ? [
            { dtype: 'fp32', device: 'webgpu' },
            { dtype: 'q8', device: 'wasm' },
          ]
        : [{ dtype: 'q8', device: 'wasm' }]
      let lastErr: unknown
      for (const a of attempts) {
        try {
          return await KokoroTTS.from_pretrained(MODEL_ID, a)
        } catch (e) {
          lastErr = e
        }
      }
      throw lastErr
    })()
  }
  return ttsPromise
}

async function generate(id: number, text: string, voice: string): Promise<void> {
  try {
    const tts = await getTTS()
    const audio: any = await tts.generate(text, { voice })
    const blob: Blob =
      typeof audio.toBlob === 'function'
        ? audio.toBlob()
        : floatToWavBlob(audio.audio as Float32Array, audio.sampling_rate as number)
    post({ type: 'result', id, blob })
  } catch (e) {
    post({ type: 'error', id, message: e instanceof Error ? e.message : String(e) })
  }
}

self.addEventListener('message', (ev: MessageEvent<InMsg>) => {
  const msg = ev.data
  if (msg.type === 'load') {
    getTTS().then(
      () => post({ type: 'ready' }),
      (e) => post({ type: 'error', message: e instanceof Error ? e.message : String(e) }),
    )
  } else if (msg.type === 'generate') {
    void generate(msg.id, msg.text, msg.voice)
  }
})

