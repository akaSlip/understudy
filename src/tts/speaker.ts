// Unified TTS facade used by the rehearsal engine. Routes each line to the
// right engine, caches blob-producing engines, and gives clean stop/abort.

import type { LineSegment, VoiceAssignment } from '../types'
import { getCachedAudio, hasCachedAudio, putCachedAudio } from '../store/audioCache'
import { generateKokoro } from './kokoro'
import { generatePremium, isPremiumEngine, plainText, type PremiumConfig } from './premium'
import { cancelWebSpeech, speakWebSpeechSegments } from './webspeech'

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

const asSegments = (text: string): LineSegment[] => [{ text }]

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

  /** Cache key for a (possibly multi-segment) line under this voice/engine.
   *  Playback rate is deliberately NOT in the key: the generated audio is
   *  rate-independent (rate is applied at playback), so changing the speed
   *  slider must not regenerate identical audio (a real cost on cloud engines).
   *  The model only matters for premium engines. */
  private keyFor(voice: VoiceAssignment, segments: LineSegment[]): string {
    const sig = segments.map((s) => `${s.direction ?? ''}:${s.text}`).join('¦')
    const model = isPremiumEngine(voice.engine) ? (this.cfg.premium?.model ?? '') : ''
    return [voice.engine, voice.voiceId ?? 'default', model, djb2(sig)].join('|')
  }

  /** Speak `text` with `voice`; resolves when finished, rejects AbortError if stopped. */
  speak(text: string, voice: VoiceAssignment, onStart?: () => void): Promise<void> {
    return this.speakSegments(asSegments(text), voice, onStart)
  }

  /** Speak a line, honouring inline emotion shifts. Web Speech varies pitch/rate
   *  per segment; blob engines (Kokoro / cloud) synthesise + cache the audio. */
  async speakSegments(segments: LineSegment[], voice: VoiceAssignment, onStart?: () => void): Promise<void> {
    this.stop()
    const controller = new AbortController()
    this.abort = controller
    const signal = controller.signal
    const rate = voice.rate ?? this.cfg.rate

    if (voice.engine === 'webspeech') {
      return speakWebSpeechSegments(segments, { voiceId: voice.voiceId, rate, pitch: voice.pitch, signal, onStart })
    }

    const key = this.keyFor(voice, segments)
    const cached = await getCachedAudio(key)
    const blob = cached ?? (await this.generate(key, voice, segments))
    if (signal.aborted) throw new DOMException('aborted', 'AbortError')
    return this.playBlob(blob, rate, signal, onStart)
  }

  /** Generate + cache without playing (pre-warms an upcoming line). */
  pregenerate(text: string, voice: VoiceAssignment): Promise<void> {
    return this.pregenerateSegments(asSegments(text), voice)
  }

  /** Pre-warm a segmented line (blob engines only). Uses the no-touch existence
   *  probe so prefetching upcoming lines doesn't outrank PLAYED audio in the
   *  cache's LRU order. */
  async pregenerateSegments(segments: LineSegment[], voice: VoiceAssignment): Promise<void> {
    if (voice.engine === 'webspeech') return // spoken live, nothing to cache
    const key = this.keyFor(voice, segments)
    if (await hasCachedAudio(key)) return
    await this.generate(key, voice, segments)
  }

  /** Synthesise + cache a blob, sharing one job per key across concurrent callers. */
  private generate(key: string, voice: VoiceAssignment, segments: LineSegment[]): Promise<Blob> {
    const existing = this.inflight.get(key)
    if (existing) return existing
    const job = (
      voice.engine === 'kokoro'
        ? generateKokoro(plainText(segments), voice.voiceId)
        : generatePremium(segments, voice, this.cfg.premium ?? null)
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
