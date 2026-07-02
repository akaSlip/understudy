// Unified TTS facade used by the rehearsal engine. Routes each line to the
// right engine, caches blob-producing engines, and gives clean stop/abort.

import type { VoiceAssignment } from '../types'
import { getCachedAudio, putCachedAudio } from '../store/audioCache'
import { generateKokoro } from './kokoro'
import { generatePremium, type PremiumConfig } from './premium'
import { cancelWebSpeech, speakWebSpeech } from './webspeech'

export interface SpeakerConfig {
  /** Fallback rate when a voice doesn't set its own. */
  rate: number
  premium?: PremiumConfig | null
}

function djb2(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = (h * 33) ^ s.charCodeAt(i)
  return (h >>> 0).toString(36)
}

function cacheKey(voice: VoiceAssignment, text: string): string {
  return [voice.engine, voice.voiceId ?? 'default', voice.rate ?? 1, voice.direction ?? '', djb2(text)].join('|')
}

export class Speaker {
  private currentAudio: HTMLAudioElement | null = null
  private abort: AbortController | null = null
  /** In-flight generations keyed by cache key, so a line being pre-generated
   *  and then reached isn't synthesised twice. */
  private inflight = new Map<string, Promise<Blob>>()

  constructor(private cfg: SpeakerConfig) {}

  setConfig(cfg: SpeakerConfig): void {
    this.cfg = cfg
  }

  /** Speak `text` with `voice`; resolves when finished, rejects AbortError if stopped. */
  async speak(text: string, voice: VoiceAssignment, onStart?: () => void): Promise<void> {
    this.stop()
    const controller = new AbortController()
    this.abort = controller
    const signal = controller.signal
    const rate = voice.rate ?? this.cfg.rate

    if (voice.engine === 'webspeech') {
      return speakWebSpeech(text, {
        voiceId: voice.voiceId,
        rate,
        pitch: voice.pitch,
        signal,
        onStart,
      })
    }

    // Blob-producing engines (kokoro / premium): cache → generate → play.
    const key = cacheKey(voice, text)
    const cached = await getCachedAudio(key)
    const blob = cached ?? (await this.generate(key, voice, text))
    if (signal.aborted) throw new DOMException('aborted', 'AbortError')
    return this.playBlob(blob, rate, signal, onStart)
  }

  /** Generate + cache without playing (pre-warms an upcoming line). */
  async pregenerate(text: string, voice: VoiceAssignment): Promise<void> {
    if (voice.engine === 'webspeech') return // spoken live, nothing to cache
    const key = cacheKey(voice, text)
    if (await getCachedAudio(key)) return
    await this.generate(key, voice, text)
  }

  /** Synthesise + cache a blob, sharing one job per key across concurrent callers. */
  private generate(key: string, voice: VoiceAssignment, text: string): Promise<Blob> {
    const existing = this.inflight.get(key)
    if (existing) return existing
    const job = (
      voice.engine === 'kokoro'
        ? generateKokoro(text, voice.voiceId)
        : generatePremium(text, voice, this.cfg.premium ?? null)
    )
      .then(async (blob) => {
        await putCachedAudio(key, blob)
        return blob
      })
      .finally(() => this.inflight.delete(key))
    this.inflight.set(key, job)
    return job
  }

  private playBlob(blob: Blob, rate: number, signal: AbortSignal, onStart?: () => void): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const url = URL.createObjectURL(blob)
      const audio = new Audio(url)
      audio.playbackRate = rate
      this.currentAudio = audio

      const cleanup = () => {
        URL.revokeObjectURL(url)
        signal.removeEventListener('abort', onAbort)
        if (this.currentAudio === audio) this.currentAudio = null
      }
      const onAbort = () => {
        audio.pause()
        cleanup()
        reject(new DOMException('aborted', 'AbortError'))
      }
      if (signal.aborted) return onAbort()
      signal.addEventListener('abort', onAbort)

      audio.onplay = () => onStart?.()
      audio.onended = () => {
        cleanup()
        resolve()
      }
      audio.onerror = () => {
        cleanup()
        reject(new Error('Audio playback failed'))
      }
      void audio.play().catch((e) => {
        cleanup()
        reject(e)
      })
    })
  }

  stop(): void {
    if (this.abort) {
      this.abort.abort()
      this.abort = null
    }
    cancelWebSpeech()
    if (this.currentAudio) {
      this.currentAudio.pause()
      this.currentAudio = null
    }
  }
}
