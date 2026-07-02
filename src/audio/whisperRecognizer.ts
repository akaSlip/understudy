// On-device recognizer: MicVAD segments the actor's speech; each utterance is
// transcribed by the Whisper worker and delivered as a final transcript. No
// interim words (Whisper is chunk-based), so scoring is line-grained — it lands
// the instant the actor finishes speaking a line.

import type { WhisperSize } from '../store/settings'
import type { LoadProgress, Recognizer, RecognizerHandlers } from './recognizer'
import { MicVAD } from './vad'

interface WorkerResult {
  type: 'progress' | 'ready' | 'result' | 'error'
  id?: number
  text?: string
  message?: string
  status?: string
  progress?: number
  file?: string
  device?: string
}

export class WhisperRecognizer implements Recognizer {
  readonly kind = 'whisper' as const
  private worker: Worker | null = null
  private vad: MicVAD | null = null
  private ready = false
  private reqId = 0
  private pending = new Map<number, (text: string) => void>()
  private handlers: RecognizerHandlers | null = null
  /** Monotonic capture-session id; bumped on each arm so a transcription that
   *  resolves after the actor moved on is dropped instead of mis-scored. */
  private session = 0
  private active = false
  private disposed = false
  device = 'wasm'

  constructor(
    private model: WhisperSize,
    private opts: { endSilenceMs?: number } = {},
  ) {}

  private ensureWorker(): Worker {
    if (!this.worker) {
      this.worker = new Worker(new URL('./whisper.worker.ts', import.meta.url), { type: 'module' })
      this.worker.addEventListener('message', (ev: MessageEvent<WorkerResult>) => {
        const m = ev.data
        if (m.type === 'result' && m.id != null) {
          const resolve = this.pending.get(m.id)
          this.pending.delete(m.id)
          resolve?.(m.text ?? '')
        } else if (m.type === 'error') {
          if (m.id != null) {
            this.pending.get(m.id)?.('')
            this.pending.delete(m.id)
          }
          this.handlers?.onError?.(new Error(m.message ?? 'Recognizer error'))
        }
      })
    }
    return this.worker
  }

  init(onProgress?: (p: LoadProgress) => void): Promise<void> {
    if (this.ready) return Promise.resolve()
    const worker = this.ensureWorker()
    return new Promise<void>((resolve, reject) => {
      const onMsg = (ev: MessageEvent<WorkerResult>) => {
        const m = ev.data
        if (m.type === 'progress') {
          onProgress?.({ status: m.status ?? 'loading', progress: m.progress, file: m.file })
        } else if (m.type === 'ready') {
          this.ready = true
          this.device = m.device ?? 'wasm'
          worker.removeEventListener('message', onMsg)
          resolve()
        } else if (m.type === 'error' && m.id == null) {
          worker.removeEventListener('message', onMsg)
          reject(new Error(m.message ?? 'Failed to load recognizer'))
        }
      }
      worker.addEventListener('message', onMsg)
      worker.postMessage({ type: 'load', model: this.model })
    })
  }

  private transcribe(audio: Float32Array): Promise<string> {
    const worker = this.ensureWorker()
    const id = ++this.reqId
    return new Promise<string>((resolve) => {
      this.pending.set(id, resolve)
      // Transfer the audio buffer for zero-copy.
      worker.postMessage({ type: 'transcribe', id, audio }, [audio.buffer])
    })
  }

  async start(handlers: RecognizerHandlers): Promise<void> {
    this.handlers = handlers
    await this.init()
    this.vad = new MicVAD({
      silenceMs: this.opts.endSilenceMs,
      onSpeechStart: () => handlers.onSpeechStart?.(),
      onSpeechEnd: () => handlers.onSpeechEnd?.(),
      onLevel: (l) => handlers.onLevel?.(l),
      onUtterance: (audio) => {
        const session = this.session // captured at endpoint time
        this.transcribe(audio)
          .then((text) => {
            // Drop results from a superseded line or after teardown.
            if (this.disposed || session !== this.session) return
            if (text) handlers.onFinal(text)
          })
          .catch((e) => handlers.onError?.(e instanceof Error ? e : new Error(String(e))))
      },
    })
    this.vad.setEnabled(this.active)
    await this.vad.start()
    if (this.disposed) {
      this.vad?.stop()
      this.vad = null
    }
  }

  setActive(active: boolean): void {
    this.active = active
    if (active) this.session++
    this.vad?.setEnabled(active)
  }

  stop(): Promise<void> {
    this.active = false
    this.vad?.stop()
    this.vad = null
    this.handlers = null
    return Promise.resolve()
  }

  dispose(): void {
    this.disposed = true
    void this.stop()
    this.worker?.terminate()
    this.worker = null
    this.ready = false
    this.pending.clear()
  }
}
