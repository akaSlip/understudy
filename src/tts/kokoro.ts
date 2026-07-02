// Optional free neural voice: Kokoro-82M, running fully in-browser via
// kokoro-js (WebGPU where available, WASM fallback — important on Linux, where
// stable-browser WebGPU is spotty). Heavier than Web Speech but noticeably less
// robotic, offline, and cached per line after first generation.

import type { TTSVoice } from './webspeech'

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX'

// Curated subset of Kokoro v1.0 voices with gender hints for casting.
export const KOKORO_VOICES: (TTSVoice & { gender: 'f' | 'm' })[] = [
  { id: 'af_heart', label: 'Heart — warm female (US)', gender: 'f' },
  { id: 'af_bella', label: 'Bella — bright female (US)', gender: 'f' },
  { id: 'af_nicole', label: 'Nicole — soft female (US)', gender: 'f' },
  { id: 'af_sarah', label: 'Sarah — measured female (US)', gender: 'f' },
  { id: 'am_michael', label: 'Michael — steady male (US)', gender: 'm' },
  { id: 'am_fenrir', label: 'Fenrir — deep male (US)', gender: 'm' },
  { id: 'am_puck', label: 'Puck — lively male (US)', gender: 'm' },
  { id: 'am_adam', label: 'Adam — plain male (US)', gender: 'm' },
  { id: 'bf_emma', label: 'Emma — female (UK)', gender: 'f' },
  { id: 'bf_alice', label: 'Alice — female (UK)', gender: 'f' },
  { id: 'bm_george', label: 'George — male (UK)', gender: 'm' },
  { id: 'bm_lewis', label: 'Lewis — male (UK)', gender: 'm' },
]

/* eslint-disable @typescript-eslint/no-explicit-any */
let ttsPromise: Promise<any> | null = null

async function getTTS(): Promise<any> {
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

/** Pre-load the model so the first line isn't slow. */
export async function warmupKokoro(): Promise<void> {
  await getTTS()
}

export async function generateKokoro(text: string, voiceId = 'af_heart'): Promise<Blob> {
  const tts = await getTTS()
  const audio: any = await tts.generate(text, { voice: voiceId })
  if (typeof audio.toBlob === 'function') return audio.toBlob()
  return floatToWavBlob(audio.audio as Float32Array, audio.sampling_rate as number)
}

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
