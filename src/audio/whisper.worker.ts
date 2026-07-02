/// <reference lib="webworker" />
// Whisper ASR in a Web Worker so transcription never blocks the UI. Tries
// WebGPU first (fast) and falls back to WASM (universal — the path most Linux
// stable browsers take). Loads an English-only model for speed since the app is
// English-focused; the known-target alignment covers the accuracy gap.

import { pipeline, type ProgressCallback } from '@huggingface/transformers'

type InMsg =
  | { type: 'load'; model: 'tiny' | 'base' }
  | { type: 'transcribe'; id: number; audio: Float32Array }

type OutMsg =
  | { type: 'progress'; status: string; progress?: number; file?: string }
  | { type: 'ready'; device: string }
  | { type: 'result'; id: number; text: string }
  | { type: 'error'; id?: number; message: string }

// onnx-community repos ship WASM-compatible ONNX; the older Xenova .en repos
// have a merged decoder that fails to create a session on ORT-web (WASM) with a
// "MatMulNBits Missing required scale" error, regardless of the requested dtype.
const MODEL_IDS: Record<'tiny' | 'base', string> = {
  tiny: 'onnx-community/whisper-tiny.en',
  base: 'onnx-community/whisper-base.en',
}

/* eslint-disable @typescript-eslint/no-explicit-any */
let transcriber: any = null
let loading: Promise<void> | null = null

const post = (m: OutMsg) => (self as unknown as Worker).postMessage(m)

async function load(model: 'tiny' | 'base'): Promise<void> {
  if (transcriber) return
  if (loading) return loading
  loading = (async () => {
    const modelId = MODEL_IDS[model]
    const progress_callback: ProgressCallback = (p: any) => {
      post({ type: 'progress', status: p.status, progress: p.progress ? p.progress / 100 : undefined, file: p.file })
    }
    // Use fp32 everywhere: quantized (q8/q4) Whisper decoders trigger a
    // "MatMulNBits Missing required scale" session-creation failure on ORT-web
    // WASM (Firefox and any no-WebGPU browser). fp32 is verified to load and
    // run on WASM. WebGPU (Chrome/Edge) also runs fp32 on the GPU.
    const hasWebGPU = typeof navigator !== 'undefined' && 'gpu' in navigator
    const attempts: Array<{ device: string; dtype: string }> = hasWebGPU
      ? [
          { device: 'webgpu', dtype: 'fp32' },
          { device: 'wasm', dtype: 'fp32' },
        ]
      : [{ device: 'wasm', dtype: 'fp32' }]
    let lastErr: unknown
    for (const a of attempts) {
      try {
        transcriber = await pipeline('automatic-speech-recognition', modelId, {
          device: a.device as any,
          dtype: a.dtype as any,
          progress_callback,
        })
        post({ type: 'ready', device: a.device })
        return
      } catch (e) {
        lastErr = e
      }
    }
    throw lastErr
  })()
  return loading
}

async function transcribe(id: number, audio: Float32Array): Promise<void> {
  if (!transcriber) {
    post({ type: 'error', id, message: 'Recognizer not loaded' })
    return
  }
  try {
    // English-only (.en) models reject `language`/`task` — omit them.
    const out: any = await transcriber(audio)
    const text = (Array.isArray(out) ? out.map((o: any) => o.text).join(' ') : out?.text ?? '').trim()
    post({ type: 'result', id, text })
  } catch (e) {
    post({ type: 'error', id, message: e instanceof Error ? e.message : String(e) })
  }
}

self.addEventListener('message', (ev: MessageEvent<InMsg>) => {
  const msg = ev.data
  if (msg.type === 'load') {
    load(msg.model).catch((e) => post({ type: 'error', message: e instanceof Error ? e.message : String(e) }))
  } else if (msg.type === 'transcribe') {
    void transcribe(msg.id, msg.audio)
  }
})
