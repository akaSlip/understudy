/// <reference lib="webworker" />
// Kokoro TTS in a Web Worker so on-device neural synthesis NEVER blocks the UI.
// WASM inference takes seconds per line; on the main thread that froze every
// button click during a play's first run-through. Mirrors whisper.worker.ts:
// WebGPU first, WASM fallback.

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
      const attempts: Array<{ dtype: string; device: string }> = [
        { dtype: 'fp32', device: 'webgpu' },
        { dtype: 'q8', device: 'wasm' },
      ]
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

/** Minimal 16-bit PCM WAV encoder for the case where RawAudio.toBlob is absent. */
function floatToWavBlob(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)
  const writeString = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i))
  }
  writeString(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  writeString(8, 'WAVE')
  writeString(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  writeString(36, 'data')
  view.setUint32(40, samples.length * 2, true)
  let off = 44
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true)
    off += 2
  }
  return new Blob([buffer], { type: 'audio/wav' })
}
