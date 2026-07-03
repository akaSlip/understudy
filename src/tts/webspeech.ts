// Free, universal, zero-setup voice: the browser's built-in SpeechSynthesis.
// Quality varies by OS/browser and it can't be captured to a blob, so it's
// spoken live. Two well-known quirks are handled: long utterances are chunked
// (many engines cut off past ~200 chars) and a watchdog resumes if the engine
// stalls.

import type { LineSegment } from '../types'
import { clampProsody, directionToProsody, segmentGapMs } from '../lib/directions'

export interface TTSVoice {
  id: string
  label: string
  lang?: string
}

let voicesCache: SpeechSynthesisVoice[] = []

export function synthesisSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window
}

/** Locale preference for listing and auto-casting: UK first, then AU/NZ, then
 *  US, then other English, then everything else. Stable within each band. */
export function localeRank(lang?: string): number {
  const l = (lang ?? '').toLowerCase()
  if (l.startsWith('en-gb')) return 0
  if (l.startsWith('en-au') || l.startsWith('en-nz')) return 1
  if (l.startsWith('en-us')) return 2
  if (l.startsWith('en')) return 3
  return 4
}

export function sortVoicesByLocale<T extends { lang?: string }>(voices: T[]): T[] {
  return [...voices].sort((a, b) => localeRank(a.lang) - localeRank(b.lang))
}

export function listWebSpeechVoices(): Promise<TTSVoice[]> {
  if (!synthesisSupported()) return Promise.resolve([])
  return new Promise((resolve) => {
    const collect = () => {
      voicesCache = window.speechSynthesis.getVoices()
      resolve(
        sortVoicesByLocale(voicesCache.map((v) => ({ id: v.name, label: `${v.name} (${v.lang})`, lang: v.lang }))),
      )
    }
    const now = window.speechSynthesis.getVoices()
    if (now.length) {
      voicesCache = now
      collect()
    } else {
      // Voices load asynchronously on first call.
      window.speechSynthesis.addEventListener('voiceschanged', collect, { once: true })
      setTimeout(collect, 250)
    }
  })
}

function pickVoice(voiceId?: string): SpeechSynthesisVoice | undefined {
  if (!voicesCache.length) voicesCache = window.speechSynthesis.getVoices()
  if (voiceId) {
    const exact = voicesCache.find((v) => v.name === voiceId)
    if (exact) return exact
  }
  // Prefer a natural-sounding UK voice, then any UK, then natural English, then any English.
  return (
    voicesCache.find((v) => /en[-_]gb/i.test(v.lang) && /natural|google|premium|enhanced/i.test(v.name)) ||
    voicesCache.find((v) => /en[-_]gb/i.test(v.lang)) ||
    voicesCache.find((v) => /en[-_]/i.test(v.lang) && /natural|google|premium|enhanced/i.test(v.name)) ||
    voicesCache.find((v) => /en[-_]/i.test(v.lang)) ||
    voicesCache[0]
  )
}

/** Split into speakable chunks at sentence boundaries, then by length. */
function chunk(text: string, max = 180): string[] {
  const sentences = text.match(/[^.!?]+[.!?]*\s*/g) ?? [text]
  const out: string[] = []
  let buf = ''
  for (const s of sentences) {
    if ((buf + s).length > max && buf) {
      out.push(buf.trim())
      buf = ''
    }
    if (s.length > max) {
      // Very long sentence: hard-split on spaces.
      const words = s.split(/\s+/)
      for (const w of words) {
        if ((buf + ' ' + w).length > max && buf) {
          out.push(buf.trim())
          buf = ''
        }
        buf += (buf ? ' ' : '') + w
      }
    } else {
      buf += s
    }
  }
  if (buf.trim()) out.push(buf.trim())
  return out
}

export interface WebSpeechOptions {
  voiceId?: string
  rate?: number
  pitch?: number
  signal?: AbortSignal
  onStart?: () => void
}

/** One queued utterance: text plus its prosody and a pause to precede it. */
interface Utterance {
  text: string
  rate: number
  pitch: number
  gapBefore: number
}

/** Speak a prepared list of utterances in order, honouring abort, the Chrome
 *  idle-stall watchdog, and per-item pauses. Shared by the plain and the
 *  segment (per-emotion) speak paths. */
function runUtterances(items: Utterance[], opts: WebSpeechOptions): Promise<void> {
  if (!synthesisSupported()) return Promise.reject(new Error('SpeechSynthesis not supported'))
  const synth = window.speechSynthesis
  synth.cancel() // clear anything stuck in the queue

  const voice = pickVoice(opts.voiceId)
  let started = false

  return new Promise<void>((resolve, reject) => {
    if (opts.signal?.aborted) return reject(new DOMException('aborted', 'AbortError'))
    if (!items.length) return resolve()

    let idx = 0
    let cancelled = false
    let current: SpeechSynthesisUtterance | null = null
    let watchdog: ReturnType<typeof setInterval> | undefined
    let gapTimer: ReturnType<typeof setTimeout> | undefined

    const cleanup = () => {
      cancelled = true
      if (watchdog) clearInterval(watchdog)
      if (gapTimer) clearTimeout(gapTimer)
      opts.signal?.removeEventListener('abort', onAbort)
      // Disarm the in-flight utterance so a late 'end' (Chrome fires 'end', not
      // 'error', for a cancel()) can't re-enter the chain and speak stale chunks.
      if (current) {
        current.onend = null
        current.onstart = null
        current.onerror = null
        current = null
      }
    }
    const onAbort = () => {
      cleanup()
      synth.cancel()
      reject(new DOMException('aborted', 'AbortError'))
    }
    opts.signal?.addEventListener('abort', onAbort)

    const speakNext = () => {
      if (cancelled) return
      if (idx >= items.length) {
        cleanup()
        resolve()
        return
      }
      const item = items[idx++]
      const go = () => {
        if (cancelled) return
        const u = new SpeechSynthesisUtterance(item.text)
        current = u
        if (voice) u.voice = voice
        u.rate = item.rate
        u.pitch = item.pitch
        u.onstart = () => {
          if (!started) {
            started = true
            opts.onStart?.()
          }
        }
        u.onend = () => {
          if (cancelled) return
          speakNext()
        }
        u.onerror = (e) => {
          if (cancelled) return
          cleanup()
          // 'interrupted'/'canceled' are expected when we stop; treat as abort.
          if (e.error === 'interrupted' || e.error === 'canceled') {
            reject(new DOMException('aborted', 'AbortError'))
          } else {
            reject(new Error(`SpeechSynthesis error: ${e.error}`))
          }
        }
        synth.speak(u)
      }
      if (item.gapBefore > 0) gapTimer = setTimeout(go, item.gapBefore)
      else go()
    }

    // Chrome pauses synthesis when it thinks it's idle; nudge it.
    watchdog = setInterval(() => {
      if (synth.speaking && !synth.paused) synth.resume()
    }, 5000)

    speakNext()
  })
}

/** Speak a line whose emotion shifts partway through: each segment gets its own
 *  pitch/rate (approximating its direction) and a short pause before it. */
export function speakWebSpeechSegments(segments: LineSegment[], opts: WebSpeechOptions = {}): Promise<void> {
  const baseRate = opts.rate ?? 1
  const basePitch = opts.pitch ?? 1
  const items: Utterance[] = []
  segments.forEach((seg, si) => {
    const p = directionToProsody(seg.direction)
    const rate = clampProsody(baseRate * p.rate, 0.5, 2)
    const pitch = clampProsody(basePitch * p.pitch, 0, 2)
    chunk(seg.text).forEach((t, pi) => {
      items.push({ text: t, rate, pitch, gapBefore: si > 0 && pi === 0 ? segmentGapMs(seg.direction) : 0 })
    })
  })
  return runUtterances(items, opts)
}

export function cancelWebSpeech(): void {
  if (synthesisSupported()) window.speechSynthesis.cancel()
}
