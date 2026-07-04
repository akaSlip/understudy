import type { Theme } from '../lib/theme'
import type { PremiumEngine, TTSEngine } from '../types'
import { db } from './db'

export type RecognizerKind = 'whisper' | 'webspeech'
export type WhisperSize = 'tiny' | 'base'
export type FreeTTSKind = 'webspeech' | 'kokoro'

/** Locally-stored credentials/config for a cloud voice engine. Kept only in
 *  this browser's IndexedDB — never sent anywhere but that engine's own API. */
export interface PremiumSettings {
  apiKey?: string
  /** Azure only: the resource region, e.g. "uksouth". */
  region?: string
  /** Optional default voice id for the engine (per-character voices override). */
  voiceId?: string
  /** Optional model override, e.g. "gpt-4o-mini-tts" / "eleven_v3". */
  model?: string
  /** Optional relay URL (only if a browser call is CORS-blocked, e.g. ElevenLabs). */
  proxyUrl?: string
}

export interface AppSettings {
  /** Speech recognizer used to score the actor's lines. */
  recognizer: RecognizerKind
  whisperModel: WhisperSize
  /** TTS engine for the scene partner: the free on-device voices, or a cloud
   *  engine (which needs a key in `premium`). */
  tts: TTSEngine
  /** Per-engine cloud credentials/config, keyed by engine name. */
  premium: Partial<Record<PremiumEngine, PremiumSettings>>
  /** Accuracy (0..1) at/above which a line is accepted. */
  passThreshold: number
  /** Exact-word matching (disables homophone tolerance). */
  strict: boolean
  /** Auto-advance to the next beat when a line passes. */
  autoAdvance: boolean
  /** After this long with no new correct word, reveal the line as a prompt. */
  stuckTimeoutMs: number
  /** Wait until the actor reaches the END of the line before accepting a pass,
   *  so a mid-line pause never scores a half-said line. */
  waitForCompletion: boolean
  /** Trailing silence (ms) that marks the end of the actor's line (Whisper). */
  endSilenceMs: number
  /** Speak stage directions / scene headings aloud with a narrator voice. */
  speakStageDirections: boolean
  /** Global TTS rate multiplier. */
  ttsRate: number
  /** Show the actor's own line text (on) vs. rehearse off-book (off). */
  alwaysShowMyLines: boolean
  /** Show the delivery direction / manner for each line. */
  showDirections: boolean
  /** Colour theme; 'system' follows the OS preference. */
  theme: Theme
  /** Auto-scroll long lines: the actor's own (at a set speed) and the
   *  partner's (paced to the reading) so the current text stays in view. */
  autoScrollLines: boolean
  /** Actor auto-scroll speed in pixels per second. */
  autoScrollSpeed: number
  /** Peek the first words of the actor's NEXT line during rehearsal
   *  (tablet/desktop only — hidden on phones). */
  showNextPeek: boolean
  /** Coach vocal projection using the mic level (off for quiet environments). */
  projectionCoaching: boolean
  /** Target loudness 0..1 to aim for when projection coaching is on. */
  projectionTarget: number
}

export const DEFAULT_SETTINGS: AppSettings = {
  recognizer: 'whisper',
  whisperModel: 'tiny',
  // Kokoro by default: fully on-device and identical on every platform —
  // the System voice depends on locally installed voices (often absent on
  // Linux), and cloud engines need a key. First use downloads the model once.
  tts: 'kokoro',
  premium: {},
  passThreshold: 0.8,
  strict: false,
  autoAdvance: true,
  stuckTimeoutMs: 3500,
  waitForCompletion: true,
  endSilenceMs: 1200,
  speakStageDirections: false,
  ttsRate: 1,
  alwaysShowMyLines: true,
  showDirections: true,
  theme: 'system',
  autoScrollLines: false,
  autoScrollSpeed: 40,
  showNextPeek: false,
  projectionCoaching: false,
  projectionTarget: 0.5,
}

const KEY = 'settings'

export async function loadSettings(): Promise<AppSettings> {
  const row = await db.meta.get(KEY)
  return { ...DEFAULT_SETTINGS, ...((row?.value as Partial<AppSettings>) ?? {}) }
}

export async function saveSettings(s: AppSettings): Promise<void> {
  await db.meta.put({ key: KEY, value: s })
}
