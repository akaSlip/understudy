// Microphone capture with simple energy-based voice-activity detection. It
// buffers audio while you speak and fires `onUtterance` once you go quiet — the
// endpoint that tells the rehearsal engine "the actor finished this line, score
// it now." Output is mono Float32 resampled to 16 kHz for Whisper.

export interface VADOptions {
  onSpeechStart?: () => void
  onSpeechEnd?: () => void
  /** Per-frame normalised loudness 0..1 (fires while armed, even during pauses). */
  onLevel?: (level: number) => void
  onUtterance: (audio16k: Float32Array) => void
  /** Trailing silence that ends an utterance. */
  silenceMs?: number
  /** Minimum voiced duration to count as speech (ignores coughs/clicks). */
  minSpeechMs?: number
  /** Audio kept before speech is detected, so onsets aren't clipped. */
  preRollMs?: number
}

const TARGET_RATE = 16000

export class MicVAD {
  private ctx: AudioContext | null = null
  private stream: MediaStream | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private processor: ScriptProcessorNode | null = null
  private sink: GainNode | null = null

  private speaking = false
  private noiseFloor = 0.005
  private voicedFrames = 0
  private silenceRun = 0 // seconds of trailing silence
  private buf: Float32Array[] = []
  private preRoll: Float32Array[] = []
  private preRollLen = 0
  /** Capture is gated: it stays off until the engine arms the actor's line, so
   *  the scene partner's TTS is never recorded. */
  private enabled = false
  private stopped = false

  constructor(private opts: VADOptions) {}

  /** Arm/disarm capture and reset detector state so no audio straddles beats. */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled
    this.speaking = false
    this.buf = []
    this.preRoll = []
    this.preRollLen = 0
    this.silenceRun = 0
  }

  async start(): Promise<void> {
    this.stopped = false
    const stream = await navigator.mediaDevices.getUserMedia({
      // AGC would continuously normalise loudness — flattening exactly the
      // signal projection coaching measures — so it's off. Echo cancellation
      // stays on so the scene partner's TTS doesn't bleed into capture.
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false },
    })
    // If we were stopped/disposed while awaiting the mic permission, release it.
    if (this.stopped) {
      stream.getTracks().forEach((t) => t.stop())
      return
    }
    this.stream = stream
    const Ctor: typeof AudioContext =
      window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    // Requesting 16 kHz avoids resampling on browsers that honour it.
    this.ctx = new Ctor({ sampleRate: TARGET_RATE })
    if (this.ctx.state === 'suspended') await this.ctx.resume()

    this.source = this.ctx.createMediaStreamSource(this.stream)
    // Aim for ~64 ms frames regardless of the ACTUAL sample rate (browsers may
    // ignore the 16 kHz request) so endpointing granularity and the mic-meter
    // refresh don't silently change per device. Must be a power of two.
    const wanted = this.ctx.sampleRate * 0.064
    let bufferSize = 256
    while (bufferSize < wanted && bufferSize < 16384) bufferSize *= 2
    this.processor = this.ctx.createScriptProcessor(bufferSize, 1, 1)
    this.sink = this.ctx.createGain()
    this.sink.gain.value = 0 // silent — we only want the processing callback

    const rate = this.ctx.sampleRate
    const silenceSec = (this.opts.silenceMs ?? 850) / 1000
    const minSpeechSec = (this.opts.minSpeechMs ?? 300) / 1000
    const preRollFrames = Math.ceil(((this.opts.preRollMs ?? 300) / 1000) * rate)

    this.processor.onaudioprocess = (e) => {
      if (!this.enabled) return // disarmed — ignore partner-TTS bleed entirely
      const input = e.inputBuffer.getChannelData(0)
      const frame = new Float32Array(input) // copy; the buffer is reused
      const rms = rmsOf(frame)
      const frameSec = frame.length / rate
      // Live meter: subtract a little floor so silence reads ~0, scale to 0..1.
      this.opts.onLevel?.(Math.min(1, Math.max(0, rms - 0.004) * 7))

      // Maintain a rolling pre-roll ring while not speaking.
      if (!this.speaking) {
        this.preRoll.push(frame)
        this.preRollLen += frame.length
        while (this.preRollLen > preRollFrames && this.preRoll.length > 1) {
          this.preRollLen -= this.preRoll.shift()!.length
        }
        // Adapt the noise floor slowly during silence.
        this.noiseFloor = this.noiseFloor * 0.95 + rms * 0.05
      }

      // With AGC off (needed for honest projection measurement) quiet mics get
      // no hardware boost, so the absolute floor must be low; the adaptive
      // noiseFloor×3 term still rejects ambient noise in louder rooms.
      const threshold = Math.max(0.006, this.noiseFloor * 3)
      const voiced = rms > threshold

      if (voiced) {
        if (!this.speaking) {
          this.speaking = true
          this.voicedFrames = 0
          this.silenceRun = 0
          this.buf = [...this.preRoll]
          this.opts.onSpeechStart?.()
        }
        this.buf.push(frame)
        this.voicedFrames += frameSec
        this.silenceRun = 0
      } else if (this.speaking) {
        this.buf.push(frame)
        this.silenceRun += frameSec
        if (this.silenceRun >= silenceSec) {
          this.endUtterance(minSpeechSec, rate)
        }
      }
    }

    this.source.connect(this.processor)
    this.processor.connect(this.sink)
    this.sink.connect(this.ctx.destination)
  }

  private endUtterance(minSpeechSec: number, rate: number): void {
    const voiced = this.voicedFrames
    const frames = this.buf
    this.speaking = false
    this.buf = []
    this.preRoll = []
    this.preRollLen = 0
    this.opts.onSpeechEnd?.()
    if (voiced < minSpeechSec) return // too short — discard blip
    const merged = mergeFrames(frames)
    const audio = rate === TARGET_RATE ? merged : resampleLinear(merged, rate, TARGET_RATE)
    // Peak-normalise so a quiet mic (no AGC) still gives Whisper a healthy
    // signal — recognition quality shouldn't depend on hardware gain.
    this.opts.onUtterance(normalizePeak(audio))
  }

  stop(): void {
    this.stopped = true
    this.enabled = false
    if (this.processor) {
      this.processor.onaudioprocess = null
      this.processor.disconnect()
    }
    this.source?.disconnect()
    this.sink?.disconnect()
    this.stream?.getTracks().forEach((t) => t.stop())
    if (this.ctx && this.ctx.state !== 'closed') void this.ctx.close()
    this.ctx = null
    this.stream = null
    this.source = null
    this.processor = null
    this.sink = null
    this.speaking = false
    this.buf = []
    this.preRoll = []
    this.preRollLen = 0
  }
}

function rmsOf(frame: Float32Array): number {
  let sum = 0
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i]
  return Math.sqrt(sum / frame.length)
}

function mergeFrames(frames: Float32Array[]): Float32Array {
  let len = 0
  for (const f of frames) len += f.length
  const out = new Float32Array(len)
  let off = 0
  for (const f of frames) {
    out.set(f, off)
    off += f.length
  }
  return out
}

/** Scale audio so its peak sits near `target` (gain-limited so silence/noise
 *  isn't blown up). In-place; returns the same array. */
function normalizePeak(a: Float32Array, target = 0.9, maxGain = 20): Float32Array {
  let peak = 0
  for (let i = 0; i < a.length; i++) {
    const v = Math.abs(a[i])
    if (v > peak) peak = v
  }
  if (peak === 0 || peak >= target) return a
  const gain = Math.min(maxGain, target / peak)
  if (gain <= 1.05) return a // not worth touching
  for (let i = 0; i < a.length; i++) a[i] *= gain
  return a
}

function resampleLinear(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return input
  const ratio = to / from
  const outLen = Math.round(input.length * ratio)
  const out = new Float32Array(outLen)
  for (let i = 0; i < outLen; i++) {
    const srcPos = i / ratio
    const i0 = Math.floor(srcPos)
    const i1 = Math.min(i0 + 1, input.length - 1)
    const frac = srcPos - i0
    out[i] = input[i0] * (1 - frac) + input[i1] * frac
  }
  return out
}
