// ---------------------------------------------------------------------------
// Cloud (expressive) TTS engines.
// ---------------------------------------------------------------------------
// Each engine is called DIRECTLY from the browser with the user's own API key
// (stored only in this browser's IndexedDB). OpenAI, Google Gemini and Azure
// (via its browser SDK) all allow direct client calls — no server/relay needed.
// ElevenLabs may be CORS-blocked in some browsers; it's called directly too,
// with an optional `proxyUrl` fallback for that one case.
//
// Delivery directions from the line's segments are mapped to each engine's
// native mechanism: ElevenLabs inline [tags], OpenAI `instructions`, Azure
// <mstts:express-as> styles, and a natural-language preamble for Gemini.

import type { LineSegment, PremiumEngine, VoiceAssignment } from '../types'
import { segmentsToTaggedText } from '../lib/directions'

export interface PremiumConfig {
  engine: PremiumEngine
  apiKey?: string
  region?: string
  voiceId?: string
  model?: string
  proxyUrl?: string
}

export class PremiumNotConfiguredError extends Error {
  constructor(engine: string) {
    super(`The ${engine} voice needs an API key. Add one in Settings → Scene-partner voice.`)
    this.name = 'PremiumNotConfiguredError'
  }
}

const PREMIUM_ENGINES: PremiumEngine[] = ['elevenlabs', 'openai', 'azure', 'gemini']
export function isPremiumEngine(engine: string): engine is PremiumEngine {
  return (PREMIUM_ENGINES as string[]).includes(engine)
}

// --- shared helpers (pure, unit-tested) ------------------------------------

export function plainText(segments: LineSegment[]): string {
  return segments.map((s) => s.text).join(' ').replace(/\s+/g, ' ').trim()
}

const uniqueDirections = (segments: LineSegment[]): string[] => {
  const out: string[] = []
  for (const s of segments) if (s.direction && !out.includes(s.direction)) out.push(s.direction)
  return out
}

/** A natural-language delivery note for instruction-steerable engines. */
export function directionsInstruction(segments: LineSegment[]): string | undefined {
  const dirs = uniqueDirections(segments)
  if (dirs.length === 0) return undefined
  if (dirs.length === 1) return `Speak in a ${dirs[0]} tone.`
  return `Perform with shifting emotion — ${dirs.join(', then ')}.`
}

/** Gemini takes the whole thing as a prompt; a leading instruction is spoken as
 *  delivery guidance, not read aloud. */
export function geminiPrompt(segments: LineSegment[]): string {
  const instruction = directionsInstruction(segments)
  const text = plainText(segments)
  return instruction ? `${instruction}\n${text}` : text
}

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!)
}

// Map a free-text direction to a supported Azure style, or undefined.
const AZURE_STYLES: Array<[RegExp, string]> = [
  [/\bang|furi|rage|irate/i, 'angry'],
  [/\bshout|yell/i, 'shouting'],
  [/\bwhisper|hush/i, 'whispering'],
  [/\bsad|depress|defeat|despair|grief|mourn|dejec/i, 'sad'],
  [/\bafraid|fear|terrif|scared|panic/i, 'terrified'],
  [/\banxi|nervous|worried/i, 'fearful'],
  [/\bexcit|thrill|elat/i, 'excited'],
  [/\bhapp|joy|cheer|glee|merry|delight/i, 'cheerful'],
  [/\bhope/i, 'hopeful'],
  [/\bwarm|tender|affection|lov/i, 'affectionate'],
  [/\bgentl|calm|soft|serene/i, 'gentle'],
  [/\bcold|bitter|scorn|sneer|conte|unfriendly/i, 'unfriendly'],
  [/\bfriendly|kind/i, 'friendly'],
  [/\bserious|stern|grave/i, 'serious'],
  [/\bembarrass|shy|sheepish/i, 'embarrassed'],
]
export function azureStyle(direction?: string): string | undefined {
  if (!direction) return undefined
  for (const [re, style] of AZURE_STYLES) if (re.test(direction)) return style
  return undefined
}

/** Build SSML with a per-segment <mstts:express-as> style for mid-line shifts. */
export function buildAzureSSML(segments: LineSegment[], voiceName: string): string {
  const body = segments
    .map((s) => {
      const style = azureStyle(s.direction)
      const text = escapeXml(s.text)
      return style ? `<mstts:express-as style="${style}" styledegree="1.5">${text}</mstts:express-as>` : text
    })
    .join(' ')
  return (
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" ` +
    `xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="en-US">` +
    `<voice name="${voiceName}">${body}</voice></speak>`
  )
}

/** Decode base64 PCM (16-bit LE mono) into a playable WAV blob (Gemini output). */
export function pcmToWav(pcmBase64: string, sampleRate = 24000, channels = 1, bits = 16): Blob {
  const bin = atob(pcmBase64)
  const len = bin.length
  const blockAlign = (channels * bits) / 8
  const byteRate = sampleRate * blockAlign
  const buffer = new ArrayBuffer(44 + len)
  const view = new DataView(buffer)
  const writeStr = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i))
  }
  writeStr(0, 'RIFF')
  view.setUint32(4, 36 + len, true)
  writeStr(8, 'WAVE')
  writeStr(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, channels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, byteRate, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, bits, true)
  writeStr(36, 'data')
  view.setUint32(40, len, true)
  const out = new Uint8Array(buffer)
  for (let i = 0; i < len; i++) out[44 + i] = bin.charCodeAt(i)
  return new Blob([buffer], { type: 'audio/wav' })
}

// --- dispatch --------------------------------------------------------------

export async function generatePremium(
  segments: LineSegment[],
  voice: VoiceAssignment,
  cfg: PremiumConfig | null,
): Promise<Blob> {
  if (!cfg) throw new PremiumNotConfiguredError(voice.engine)
  const needsKey = cfg.engine !== 'elevenlabs' || !cfg.proxyUrl
  if (needsKey && !cfg.apiKey) throw new PremiumNotConfiguredError(cfg.engine)
  const voiceId = voice.voiceId || cfg.voiceId
  switch (cfg.engine) {
    case 'elevenlabs':
      return elevenLabs(segments, voiceId, cfg)
    case 'openai':
      return openai(segments, voiceId, cfg)
    case 'azure':
      return azure(segments, voiceId, cfg)
    case 'gemini':
      return gemini(segments, voiceId, cfg)
  }
}

/** v3 takes inline [audio tags] for acting direction; older models (e.g.
 *  eleven_multilingual_v2) would read the brackets ALOUD, so they get plain
 *  words. Exported for tests. */
export function elevenLabsText(model: string, segments: LineSegment[]): string {
  return model.startsWith('eleven_v3') ? segmentsToTaggedText(segments) : plainText(segments)
}

async function elevenLabs(segments: LineSegment[], voiceId: string | undefined, cfg: PremiumConfig): Promise<Blob> {
  const id = voiceId || '21m00Tcm4TlvDq8ikWAM'
  const model = cfg.model || 'eleven_v3'
  const body = JSON.stringify({ text: elevenLabsText(model, segments), model_id: model })
  const direct = `https://api.elevenlabs.io/v1/text-to-speech/${id}`
  const url = cfg.proxyUrl ? `${cfg.proxyUrl.replace(/\/$/, '')}/tts/${id}` : direct
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cfg.apiKey ? { 'xi-api-key': cfg.apiKey } : {}) },
    body,
  })
  if (!res.ok) throw new Error(`ElevenLabs error ${res.status}: ${await res.text().catch(() => '')}`)
  return res.blob()
}

async function openai(segments: LineSegment[], voiceId: string | undefined, cfg: PremiumConfig): Promise<Blob> {
  const body = JSON.stringify({
    model: cfg.model || 'gpt-4o-mini-tts',
    voice: voiceId || 'alloy',
    input: plainText(segments),
    instructions: directionsInstruction(segments),
    response_format: 'mp3',
  })
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body,
  })
  if (!res.ok) throw new Error(`OpenAI error ${res.status}: ${await res.text().catch(() => '')}`)
  return res.blob()
}

async function gemini(segments: LineSegment[], voiceId: string | undefined, cfg: PremiumConfig): Promise<Blob> {
  const model = cfg.model || 'gemini-2.5-flash-preview-tts'
  // Key goes in the header, not the URL — query strings end up in proxy/server logs.
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`
  const body = JSON.stringify({
    contents: [{ parts: [{ text: geminiPrompt(segments) }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voiceId || 'Kore' } } },
    },
  })
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cfg.apiKey! },
    body,
  })
  if (!res.ok) throw new Error(`Gemini error ${res.status}: ${await res.text().catch(() => '')}`)
  const json = await res.json()
  const part = json?.candidates?.[0]?.content?.parts?.find((p: { inlineData?: unknown }) => p.inlineData)
  const inline = part?.inlineData
  if (!inline?.data) throw new Error('Gemini returned no audio.')
  const rate = Number(/rate=(\d+)/.exec(inline.mimeType ?? '')?.[1]) || 24000
  return pcmToWav(inline.data, rate)
}

async function azure(segments: LineSegment[], voiceId: string | undefined, cfg: PremiumConfig): Promise<Blob> {
  if (!cfg.region) throw new Error('Azure needs a region (e.g. "uksouth") in Settings.')
  const sdk = await import('microsoft-cognitiveservices-speech-sdk')
  const speechConfig = sdk.SpeechConfig.fromSubscription(cfg.apiKey!, cfg.region)
  speechConfig.speechSynthesisOutputFormat = sdk.SpeechSynthesisOutputFormat.Audio24Khz48KBitRateMonoMp3
  const ssml = buildAzureSSML(segments, voiceId || 'en-US-AriaNeural')
  // null audio output → we get the bytes and play them ourselves (no auto-speaker).
  const synth = new sdk.SpeechSynthesizer(speechConfig, null as unknown as undefined)
  try {
    const data = await new Promise<ArrayBuffer>((resolve, reject) => {
      synth.speakSsmlAsync(
        ssml,
        (result) => {
          if (result.reason === sdk.ResultReason.SynthesizingAudioCompleted) resolve(result.audioData)
          else reject(new Error(result.errorDetails || 'Azure synthesis failed.'))
        },
        (err) => reject(new Error(String(err))),
      )
    })
    return new Blob([data], { type: 'audio/mpeg' })
  } finally {
    synth.close()
    speechConfig.close() // the config holds native handles too
  }
}
