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

// ElevenLabs default library voices.
const ELEVENLABS: GenderedVoice[] = [
  { id: '21m00Tcm4TlvDq8ikWAM', label: 'Rachel — female', gender: 'f' },
  { id: 'EXAVITQu4vr4xnSDxMaL', label: 'Bella — female', gender: 'f' },
  { id: 'AZnzlk1XvdvUeBnXmlld', label: 'Domi — female', gender: 'f' },
  { id: 'MF3mGyEYCl7XYWbV9V6O', label: 'Elli — female', gender: 'f' },
  { id: 'ErXwobaYiN019PkySvjV', label: 'Antoni — male', gender: 'm' },
  { id: 'TxGEqnHWrfWFTfGW9XjX', label: 'Josh — male', gender: 'm' },
  { id: 'VR6AewLTigWG4xSOukaG', label: 'Arnold — male', gender: 'm' },
  { id: 'pNInz6obpgDQGcFmaJgB', label: 'Adam — male', gender: 'm' },
]

export const PREMIUM_VOICES: Record<PremiumEngine, GenderedVoice[]> = {
  openai: OPENAI,
  gemini: GEMINI,
  azure: AZURE,
  elevenlabs: ELEVENLABS,
}

/** Human-friendly engine label + where to get a key (shown in Settings). */
export const ENGINE_INFO: Record<PremiumEngine, { label: string; keysUrl: string; needsRegion?: boolean }> = {
  elevenlabs: { label: 'ElevenLabs v3', keysUrl: 'https://elevenlabs.io/app/settings/api-keys' },
  openai: { label: 'OpenAI', keysUrl: 'https://platform.openai.com/api-keys' },
  azure: { label: 'Azure Speech', keysUrl: 'https://portal.azure.com', needsRegion: true },
  gemini: { label: 'Google Gemini', keysUrl: 'https://aistudio.google.com/apikey' },
}
