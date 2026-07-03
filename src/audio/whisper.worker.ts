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
let currentModel: 'tiny' | 'base' = 'tiny'
let currentDevice = 'wasm'
let retriedOnWasm = false

const post = (m: OutMsg) => (self as unknown as Worker).postMessage(m)

async function load(model: 'tiny' | 'base', forceWasm = false): Promise<void> {
  if (transcriber) return
  if (loading) return loading
  currentModel = model
  loading = (async () => {
    const modelId = MODEL_IDS[model]
    const progress_callback: ProgressCallback = (p: any) => {
      post({ type: 'progress', status: p.status, progress: p.progress ? p.progress / 100 : undefined, file: p.file })
    }
    // Use fp32 everywhere: quantized (q8/q4) Whisper decoders trigger a
    // "MatMulNBits Missing required scale" session-creation failure on ORT-web
    // WASM (Firefox and any no-WebGPU browser). fp32 is verified to load and
    // run on WASM. WebGPU (Chrome/Edge) also runs fp32 on the GPU.
    // Probe for a REAL adapter, not just the API: navigator.gpu can exist with
    // no usable adapter, and a failed WebGPU session can poison the ORT
    // backend registry so the wasm fallback fails too.
    const hasWebGPU =
      !forceWasm &&
      typeof navigator !== 'undefined' &&
      'gpu' in navigator &&
      /* eslint-disable-next-line @typescript-eslint/no-explicit-any */
      !!(await (navigator as any).gpu.requestAdapter().catch(() => null))
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
        currentDevice = a.device
        // Warm-up inference on half a second of silence: the first real call
        // otherwise pays one-time kernel compilation (seconds on WASM), which
        // made the actor's FIRST line slow to score. Runs behind the loading
        // screen, so line 1 is as fast as line 10.
        post({ type: 'progress', status: 'warming up', file: undefined })
        try {
          await transcriber(new Float32Array(8000))
        } catch {
          /* warm-up is best-effort */
        }
        post({ type: 'ready', device: a.device })
        return
      } catch (e) {
        lastErr = e
      }
    }
    throw lastErr
  })()
  try {
    return await loading
  } finally {
    loading = null // allow a later forced-WASM rebuild
  }
}

async function run(audio: Float32Array): Promise<string> {
  // English-only (.en) models reject `language`/`task` — omit them.
  const out: any = await transcriber(audio)
  return (Array.isArray(out) ? out.map((o: any) => o.text).join(' ') : out?.text ?? '').trim()
}

async function transcribe(id: number, audio: Float32Array): Promise<void> {
  // A (re)load may be in flight — e.g. the one-time WebGPU→WASM rebuild below.
  // Wait for it rather than dropping the actor's utterance with an error.
  if (!transcriber && loading) {
    try {
      await loading
    } catch {
      /* fall through to the guard */
    }
  }
  if (!transcriber) {
    post({ type: 'error', id, message: 'Recognizer not loaded' })
    return
  }
  try {
    post({ type: 'result', id, text: await run(audio) })
  } catch (e) {
    // WebGPU can load fine and still fail at inference time (driver quirks).
    // Rebuild once on WASM and retry, so one bad device doesn't fail every line.
    if (currentDevice === 'webgpu' && !retriedOnWasm) {
      retriedOnWasm = true
      try {
        transcriber = null
        await load(currentModel, true)
        post({ type: 'result', id, text: await run(audio) })
        return
      } catch (e2) {
        post({ type: 'error', id, message: e2 instanceof Error ? e2.message : String(e2) })
        return
      }
    }
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
