// Recognizer abstraction. The rehearsal engine depends only on this shape, so
// Whisper (on-device, default), Web Speech, or a future streaming cloud engine
// are interchangeable without touching scoring or flow logic.

export interface RecognizerHandlers {
  /** Interim hypothesis (Web Speech only). */
  onPartial?: (text: string) => void
  /** A finalised utterance transcript. */
  onFinal: (text: string) => void
  onSpeechStart?: () => void
  onSpeechEnd?: () => void
  /** Normalised input loudness 0..1 while armed, for a live listening meter.
   *  Only emitted by recognizers that process raw audio (Whisper/VAD). */
  onLevel?: (level: number) => void
  onError?: (e: Error) => void
}

export interface LoadProgress {
  status: string
  /** 0..1 when known. */
  progress?: number
  file?: string
}

export interface Recognizer {
  readonly kind: 'whisper' | 'webspeech'
  /** Load models / warm up. Safe to call more than once. */
  init(onProgress?: (p: LoadProgress) => void): Promise<void>
  /** Begin listening; utterances stream to the handlers until stop(). */
  start(handlers: RecognizerHandlers): Promise<void>
  /** Arm/disarm scoring capture. When inactive, no finals are delivered — used
   *  to gate out the scene partner's TTS and stale cross-line transcriptions.
   *  Arming (true) starts a fresh capture session. */
  setActive(active: boolean): void
  /** Stop listening (releases the mic) but keep models loaded for reuse. */
  stop(): Promise<void>
  /** Tear down completely. */
  dispose(): void
}
