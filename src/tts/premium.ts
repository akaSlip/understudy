// ---------------------------------------------------------------------------
// Premium (expressive) TTS drop-in seam.
// ---------------------------------------------------------------------------
// v1 ships free voices only, so nothing here runs unless a key is configured.
// This is the ONE place to enable true-inflection acting voices later:
//   1. Add a key (stored locally in IndexedDB, never on a server) — or point
//      `proxyUrl` at a ~50-line Cloudflare Worker that forwards the request
//      (only needed for ElevenLabs, which blocks direct browser calls via CORS).
//   2. Set settings.tts to the premium engine and assign per-character voices.
// Output is pre-generated once per line and cached (see Speaker), so cost is
// one-time-per-line and playback stays instant + offline afterwards.

import type { TTSEngine, VoiceAssignment } from '../types'

export interface PremiumConfig {
  engine: Extract<TTSEngine, 'elevenlabs' | 'hume' | 'openai'>
  apiKey?: string
  /** Optional relay (Cloudflare Worker) to fix CORS / hide a shared key. */
  proxyUrl?: string
  /** Default model id (e.g. 'eleven_v3', 'octave-2', 'gpt-4o-mini-tts'). */
  modelId?: string
}

export class PremiumNotConfiguredError extends Error {
  constructor(engine: string) {
    super(`Premium voice "${engine}" is not configured. Add an API key in Settings to enable expressive voices.`)
    this.name = 'PremiumNotConfiguredError'
  }
}

export async function generatePremium(
  text: string,
  voice: VoiceAssignment,
  cfg: PremiumConfig | null,
): Promise<Blob> {
  if (!cfg || (!cfg.apiKey && !cfg.proxyUrl)) {
    throw new PremiumNotConfiguredError(voice.engine)
  }
  switch (cfg.engine) {
    case 'elevenlabs':
      return elevenLabs(text, voice, cfg)
    case 'hume':
    case 'openai':
      // Same shape as ElevenLabs; wire up when needed. Left unimplemented so
      // the seam is explicit rather than silently wrong.
      throw new PremiumNotConfiguredError(cfg.engine)
  }
}

async function elevenLabs(text: string, voice: VoiceAssignment, cfg: PremiumConfig): Promise<Blob> {
  const voiceId = voice.voiceId || '21m00Tcm4TlvDq8ikWAM' // a default library voice
  // v3 takes inline audio tags for per-line acting direction.
  const body = JSON.stringify({
    text: voice.direction ? `[${voice.direction}] ${text}` : text,
    model_id: cfg.modelId || 'eleven_v3',
  })
  const direct = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`
  const url = cfg.proxyUrl ? `${cfg.proxyUrl.replace(/\/$/, '')}/tts/${voiceId}` : direct
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cfg.apiKey ? { 'xi-api-key': cfg.apiKey } : {}),
    },
    body,
  })
  if (!res.ok) throw new Error(`ElevenLabs error ${res.status}: ${await res.text().catch(() => '')}`)
  return res.blob()
}
