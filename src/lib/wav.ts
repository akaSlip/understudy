// Minimal 16-bit PCM WAV container writing, shared by the Kokoro worker
// (Float32 samples) and the Gemini decoder (raw PCM bytes) — one place to get
// the 44-byte RIFF header right.

function writeHeader(view: DataView, dataLen: number, sampleRate: number, channels = 1, bits = 16): void {
  const writeString = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i))
  }
  const blockAlign = (channels * bits) / 8
  writeString(0, 'RIFF')
  view.setUint32(4, 36 + dataLen, true)
  writeString(8, 'WAVE')
  writeString(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, channels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * blockAlign, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, bits, true)
  writeString(36, 'data')
  view.setUint32(40, dataLen, true)
}

/** Wrap raw 16-bit little-endian PCM bytes in a WAV container. */
export function pcmBytesToWavBlob(bytes: Uint8Array, sampleRate: number, channels = 1): Blob {
  const buffer = new ArrayBuffer(44 + bytes.length)
  writeHeader(new DataView(buffer), bytes.length, sampleRate, channels)
  new Uint8Array(buffer).set(bytes, 44)
  return new Blob([buffer], { type: 'audio/wav' })
}

/** Encode Float32 samples ([-1, 1]) as a 16-bit PCM WAV blob. */
export function floatToWavBlob(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)
  writeHeader(view, samples.length * 2, sampleRate)
  let off = 44
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true)
    off += 2
  }
  return new Blob([buffer], { type: 'audio/wav' })
}
