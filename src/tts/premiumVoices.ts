// Curated voice lists for the cloud engines, with gender hints for casting.
// Per-character voices can be reassigned in the editor or during rehearsal;
// these are the pool the auto-caster and the pickers draw from.

import type { PremiumEngine } from '../types'
import type { TTSVoice } from './webspeech'

export type GenderedVoice = TTSVoice & { gender?: 'f' | 'm' }

// OpenAI gpt-4o-mini-tts voices (genders are approximate timbre leanings).
const OPENAI: GenderedVoice[] = [
  { id: 'alloy', label: 'Alloy — neutral', gender: 'm' },
  { id: 'ash', label: 'Ash — warm male', gender: 'm' },
  { id: 'ballad', label: 'Ballad — soft male', gender: 'm' },
  { id: 'echo', label: 'Echo — male', gender: 'm' },
  { id: 'onyx', label: 'Onyx — deep male', gender: 'm' },
  { id: 'sage', label: 'Sage — female', gender: 'f' },
  { id: 'nova', label: 'Nova — bright female', gender: 'f' },
  { id: 'shimmer', label: 'Shimmer — female', gender: 'f' },
  { id: 'coral', label: 'Coral — warm female', gender: 'f' },
  { id: 'fable', label: 'Fable — British, neutral', gender: 'm' },
]

// Google Gemini TTS prebuilt voices (a subset; genders are best-effort).
const GEMINI: GenderedVoice[] = [
  { id: 'Kore', label: 'Kore — female', gender: 'f' },
  { id: 'Aoede', label: 'Aoede — female', gender: 'f' },
  { id: 'Leda', label: 'Leda — female', gender: 'f' },
  { id: 'Callirrhoe', label: 'Callirrhoe — female', gender: 'f' },
  { id: 'Puck', label: 'Puck — male', gender: 'm' },
  { id: 'Charon', label: 'Charon — male', gender: 'm' },
  { id: 'Fenrir', label: 'Fenrir — male', gender: 'm' },
  { id: 'Orus', label: 'Orus — male', gender: 'm' },
]

// Azure Neural voices that support expressive styles (mstts:express-as).
const AZURE: GenderedVoice[] = [
  { id: 'en-US-AriaNeural', label: 'Aria — female (US)', gender: 'f' },
  { id: 'en-US-JennyNeural', label: 'Jenny — female (US)', gender: 'f' },
  { id: 'en-US-NancyNeural', label: 'Nancy — female (US)', gender: 'f' },
  { id: 'en-US-GuyNeural', label: 'Guy — male (US)', gender: 'm' },
  { id: 'en-US-DavisNeural', label: 'Davis — male (US)', gender: 'm' },
  { id: 'en-US-TonyNeural', label: 'Tony — male (US)', gender: 'm' },
  { id: 'en-GB-SoniaNeural', label: 'Sonia — female (UK)', gender: 'f' },
  { id: 'en-GB-RyanNeural', label: 'Ryan — male (UK)', gender: 'm' },
]

// ElevenLabs CURRENT premade voices (usable by free-plan API keys, unlike
// "library" voices, which 402 on free). This static list is only the fallback:
// fetchElevenVoices() replaces it with the account's real voice list once a
// key is configured.
// Order: UK first (the auto-cast default), then AU, then US.
const ELEVENLABS: GenderedVoice[] = [
  { id: 'Xb7hH8MSUJpSbSDYk0k2', label: 'Alice — female (UK)', gender: 'f' },
  { id: 'pFZP5JQG7iQjIQuC4Bku', label: 'Lily — female (UK)', gender: 'f' },
  { id: 'JBFqnCBsd6RMkjVDRZzb', label: 'George — male (UK)', gender: 'm' },
  { id: 'onwK4e9ZLuTAKqWW03F9', label: 'Daniel — male (UK)', gender: 'm' },
  { id: 'IKne3meq5aSn9XLyUdCD', label: 'Charlie — male (AU)', gender: 'm' },
  { id: 'XrExE9yKIg1WjnnlVkGX', label: 'Matilda — female (AU)', gender: 'f' },
  { id: 'EXAVITQu4vr4xnSDxMaL', label: 'Sarah — female (US)', gender: 'f' },
  { id: '9BWtsMINqrJLrRacOk9x', label: 'Aria — female (US)', gender: 'f' },
  { id: 'TX3LPaxmHKxFdv7VOQHJ', label: 'Liam — male (US)', gender: 'm' },
  { id: 'bIHbv24MWmeRgasZH58o', label: 'Will — male (US)', gender: 'm' },
]

export const PREMIUM_VOICES: Record<PremiumEngine, GenderedVoice[]> = {
  openai: OPENAI,
  gemini: GEMINI,
  azure: AZURE,
  elevenlabs: ELEVENLABS,
}

// ElevenLabs is the one engine whose usable voices depend on the ACCOUNT
// (fetched live). The fetched list lives here as an explicit override so the
// static list above stays an immutable fallback — consumers go through
// currentPremiumVoices() instead of relying on hidden array mutation.
let elevenLive: GenderedVoice[] | null = null

export function setElevenVoices(voices: GenderedVoice[]): void {
  elevenLive = voices.length ? voices : null
}

/** The engine's voice list: the live account list when fetched, else static. */
export function currentPremiumVoices(engine: PremiumEngine): GenderedVoice[] {
  if (engine === 'elevenlabs' && elevenLive) return elevenLive
  return PREMIUM_VOICES[engine]
}

/** Human-friendly engine label + where to get a key (shown in Settings). */
export const ENGINE_INFO: Record<PremiumEngine, { label: string; keysUrl: string; needsRegion?: boolean }> = {
  elevenlabs: { label: 'ElevenLabs v3', keysUrl: 'https://elevenlabs.io/app/settings/api-keys' },
  openai: { label: 'OpenAI', keysUrl: 'https://platform.openai.com/api-keys' },
  azure: { label: 'Azure Speech', keysUrl: 'https://portal.azure.com', needsRegion: true },
  gemini: { label: 'Google Gemini', keysUrl: 'https://aistudio.google.com/apikey' },
}
