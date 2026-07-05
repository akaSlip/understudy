// Alternative recognizer: the browser Web Speech API. Streams interim words for
// live feedback, but is cloud-backed (Chrome/Edge/Safari), absent in Firefox,
// and its continuous mode self-terminates — so we auto-restart it. Kept behind
// the same Recognizer interface as an opt-in.

import type { LoadProgress, Recognizer, RecognizerHandlers } from './recognizer'
import { MicVAD } from './vad'

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
  /** Gates capture to the actor's listening window. */
  private listen = false
  /** Whether the recognition session is currently running. */
  private running = false
  /** Set on unrecoverable errors (permission revoked) — stops the restart loop. */
  private fatal = false
  /** Consecutive 'network' failures — Chrome's speech service is cloud-backed
   *  and unreachable behind some VPNs/firewalls; give up after a few. */
  private networkErrors = 0
  /** Local level meter. The Web Speech API exposes no audio levels, so the mic
   *  meter and projection coaching were dead on this engine — a MicVAD runs
   *  purely for its onLevel frames (utterances discarded; audio never leaves
   *  the device from this stream). */
  private meter: MicVAD | null = null

  init(_onProgress?: (p: LoadProgress) => void): Promise<void> {
    if (!webSpeechSupported()) return Promise.reject(new Error('Web Speech API not supported in this browser'))
    return Promise.resolve()
  }

  async start(handlers: RecognizerHandlers): Promise<void> {
    const Ctor = getCtor()
    if (!Ctor) throw new Error('Web Speech API not supported')
    // Chrome allows only ONE live SpeechRecognition per page. start() can be
    // called again on the same instance (sound check → rehearsal reuses the
    // recognizer), and without tearing the old session down first the new one
    // is killed with a silent 'aborted' — "doesn't register at all".
    this.teardownSession()
    this.meter?.stop()
    // The level meter doubles as the mic-permission prompt at the setup gate
    // ("Requesting microphone…"). Its frames are gated by setActive, so
    // nothing is even measured while the scene partner speaks.
    const meter = new MicVAD({
      onLevel: (l) => handlers.onLevel?.(l),
      onUtterance: () => {}, // levels only — recognition is the cloud engine's job
    })
    try {
      await meter.start()
    } catch {
      throw new Error('Microphone access was denied — allow it in the browser and try again.')
    }
    this.meter = meter
    this.active = true
    this.fatal = false
    this.networkErrors = 0
    const rec = new Ctor()
    rec.lang = 'en-GB'
    rec.continuous = true
    rec.interimResults = true
    rec.maxAlternatives = 1
    rec.onspeechstart = () => handlers.onSpeechStart?.()
    rec.onspeechend = () => handlers.onSpeechEnd?.()
    rec.onresult = (e) => {
      this.networkErrors = 0 // the service is reachable after all
      if (!this.listen) return // disarmed — ignore stray results
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
      // Unrecoverable: don't spin retrying a mic we'll never get.
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        this.fatal = true
        handlers.onError?.(new Error('Microphone access was denied — allow it in the browser and try again.'))
        return
      }
      // 'network': Chrome could not reach Google's speech servers (Web Speech
      // is cloud-backed). Retry once — transient blips happen — then stop and
      // point at the on-device engine instead of flashing errors forever.
      if (e.error === 'network') {
        this.networkErrors++
        if (this.networkErrors >= 2) {
          this.fatal = true
          handlers.onError?.(
            new Error(
              "Chrome can't reach its speech service (Web Speech needs Google's servers — VPNs and firewalls often block it). " +
                'Switch to Whisper (on-device) in Settings → Scoring, which works offline.',
            ),
          )
        }
        return
      }
      if (e.error !== 'no-speech' && e.error !== 'aborted') {
        handlers.onError?.(new Error(`Speech recognition error: ${e.error}`))
      }
    }
    rec.onend = () => {
      this.running = false
      // Continuous mode drops out periodically; restart only while the actor's
      // line is armed (never while the scene partner speaks — the mic must be
      // genuinely off then, not just muted) and only if recoverable.
      if (this.active && this.listen && !this.fatal) this.startSession()
    }
    this.rec = rec
    // Capture sessions start when a line arms (privacy: nothing streams to the
    // cloud engine during partner speech). Trade-off: rec.start() has engine
    // warm-up latency, so `setActive(false)` below uses the graceful stop()
    // path and arming reuses a still-open session where possible.
  }

  private startSession(): void {
    if (!this.rec || this.running || this.fatal) return
    try {
      this.rec.start()
      this.running = true
    } catch {
      /* already started */
    }
  }

  /** Arm/disarm capture. The session itself is started/stopped — not just
   *  muted — so audio never streams to the cloud engine while disarmed. Disarm
   *  uses stop() (graceful) rather than abort(): if the actor's next line arms
   *  before the session has fully wound down, the still-open session is reused
   *  (running stays true until onend), avoiding a cold-start that could clip
   *  the line's first syllable. */
  setActive(active: boolean): void {
    this.listen = active
    this.meter?.setEnabled(active)
    if (active) {
      this.startSession()
    } else if (this.rec && this.running) {
      try {
        this.rec.stop()
      } catch {
        /* ignore */
      }
      // Don't flip `running` here — onend does, and if we re-arm before then,
      // the onend handler restarts the session for us (listen is re-checked).
    }
  }

  private teardownSession(): void {
    this.running = false
    if (this.rec) {
      this.rec.onend = null
      this.rec.onresult = null
      this.rec.onerror = null
      try {
        this.rec.abort()
      } catch {
        /* ignore */
      }
      this.rec = null
    }
  }

  stop(): Promise<void> {
    this.active = false
    this.listen = false
    this.teardownSession()
    this.meter?.stop()
    this.meter = null
    return Promise.resolve()
  }

  dispose(): void {
    void this.stop()
  }
}
