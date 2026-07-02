// Alternative recognizer: the browser Web Speech API. Streams interim words for
// live feedback, but is cloud-backed (Chrome/Edge/Safari), absent in Firefox,
// and its continuous mode self-terminates — so we auto-restart it. Kept behind
// the same Recognizer interface as an opt-in.

import type { LoadProgress, Recognizer, RecognizerHandlers } from './recognizer'

// Minimal typings for the non-standardised Web Speech API.
interface SpeechRecognitionAlternativeLike {
  transcript: string
}
interface SpeechRecognitionResultLike {
  isFinal: boolean
  0: SpeechRecognitionAlternativeLike
  length: number
}
interface SpeechRecognitionEventLike {
  resultIndex: number
  results: { length: number; [i: number]: SpeechRecognitionResultLike }
}
interface SpeechRecognitionLike {
  lang: string
  continuous: boolean
  interimResults: boolean
  maxAlternatives: number
  start(): void
  stop(): void
  abort(): void
  onresult: ((e: SpeechRecognitionEventLike) => void) | null
  onerror: ((e: { error: string }) => void) | null
  onend: (() => void) | null
  onspeechstart: (() => void) | null
  onspeechend: (() => void) | null
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike

function getCtor(): SpeechRecognitionCtor | null {
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor
    webkitSpeechRecognition?: SpeechRecognitionCtor
  }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

export function webSpeechSupported(): boolean {
  return typeof window !== 'undefined' && getCtor() != null
}

export class WebSpeechRecognizer implements Recognizer {
  readonly kind = 'webspeech' as const
  private rec: SpeechRecognitionLike | null = null
  private active = false
  /** Gates delivery of results to the actor's listening window. */
  private listen = false

  init(_onProgress?: (p: LoadProgress) => void): Promise<void> {
    if (!webSpeechSupported()) return Promise.reject(new Error('Web Speech API not supported in this browser'))
    return Promise.resolve()
  }

  start(handlers: RecognizerHandlers): Promise<void> {
    const Ctor = getCtor()
    if (!Ctor) return Promise.reject(new Error('Web Speech API not supported'))
    this.active = true
    const rec = new Ctor()
    rec.lang = 'en-US'
    rec.continuous = true
    rec.interimResults = true
    rec.maxAlternatives = 1
    rec.onspeechstart = () => handlers.onSpeechStart?.()
    rec.onspeechend = () => handlers.onSpeechEnd?.()
    rec.onresult = (e) => {
      if (!this.listen) return // disarmed — ignore partner-TTS bleed / stray results
      let interim = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i]
        const text = r[0].transcript
        if (r.isFinal) handlers.onFinal(text.trim())
        else interim += text
      }
      if (interim) handlers.onPartial?.(interim.trim())
    }
    rec.onerror = (e) => {
      if (e.error !== 'no-speech' && e.error !== 'aborted') {
        handlers.onError?.(new Error(`Speech recognition error: ${e.error}`))
      }
    }
    rec.onend = () => {
      // Continuous mode drops out periodically; restart while active.
      if (this.active) {
        try {
          rec.start()
        } catch {
          /* already started */
        }
      }
    }
    this.rec = rec
    try {
      rec.start()
    } catch (e) {
      return Promise.reject(e)
    }
    return Promise.resolve()
  }

  setActive(active: boolean): void {
    this.listen = active
  }

  stop(): Promise<void> {
    this.active = false
    this.listen = false
    if (this.rec) {
      this.rec.onend = null
      try {
        this.rec.abort()
      } catch {
        /* ignore */
      }
      this.rec = null
    }
    return Promise.resolve()
  }

  dispose(): void {
    void this.stop()
  }
}
