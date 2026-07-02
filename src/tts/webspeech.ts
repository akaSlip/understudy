// Free, universal, zero-setup voice: the browser's built-in SpeechSynthesis.
// Quality varies by OS/browser and it can't be captured to a blob, so it's
// spoken live. Two well-known quirks are handled: long utterances are chunked
// (many engines cut off past ~200 chars) and a watchdog resumes if the engine
// stalls.

export interface TTSVoice {
  id: string
  label: string
  lang?: string
}

let voicesCache: SpeechSynthesisVoice[] = []

export function synthesisSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window
}

export function listWebSpeechVoices(): Promise<TTSVoice[]> {
  if (!synthesisSupported()) return Promise.resolve([])
  return new Promise((resolve) => {
    const collect = () => {
      voicesCache = window.speechSynthesis.getVoices()
      resolve(
        voicesCache.map((v) => ({ id: v.name, label: `${v.name} (${v.lang})`, lang: v.lang })),
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
  // Prefer a natural-sounding English voice.
  return (
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

export function speakWebSpeech(text: string, opts: WebSpeechOptions = {}): Promise<void> {
  if (!synthesisSupported()) return Promise.reject(new Error('SpeechSynthesis not supported'))
  const synth = window.speechSynthesis
  synth.cancel() // clear anything stuck in the queue

  const voice = pickVoice(opts.voiceId)
  const parts = chunk(text)
  let started = false

  return new Promise<void>((resolve, reject) => {
    if (opts.signal?.aborted) return reject(new DOMException('aborted', 'AbortError'))

    let idx = 0
    let cancelled = false
    let current: SpeechSynthesisUtterance | null = null
    let watchdog: ReturnType<typeof setInterval> | undefined

    const cleanup = () => {
      cancelled = true
      if (watchdog) clearInterval(watchdog)
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
      if (idx >= parts.length) {
        cleanup()
        resolve()
        return
      }
      const u = new SpeechSynthesisUtterance(parts[idx++])
      current = u
      if (voice) u.voice = voice
      u.rate = opts.rate ?? 1
      u.pitch = opts.pitch ?? 1
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

    // Chrome pauses synthesis when it thinks it's idle; nudge it.
    watchdog = setInterval(() => {
      if (synth.speaking && !synth.paused) synth.resume()
    }, 5000)

    speakNext()
  })
}

export function cancelWebSpeech(): void {
  if (synthesisSupported()) window.speechSynthesis.cancel()
}
