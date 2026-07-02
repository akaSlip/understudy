import type { Theme } from '../lib/theme'
import { db } from './db'

export type RecognizerKind = 'whisper' | 'webspeech'
export type WhisperSize = 'tiny' | 'base'
export type FreeTTSKind = 'webspeech' | 'kokoro'

export interface AppSettings {
  /** Speech recognizer used to score the actor's lines. */
  recognizer: RecognizerKind
  whisperModel: WhisperSize
  /** Free TTS engine for the scene partner (premium engines slot in later). */
  tts: FreeTTSKind
  /** Accuracy (0..1) at/above which a line is accepted. */
  passThreshold: number
  /** Exact-word matching (disables homophone tolerance). */
  strict: boolean
  /** Auto-advance to the next beat when a line passes. */
  autoAdvance: boolean
  /** After this long with no new correct word, reveal the line as a prompt. */
  stuckTimeoutMs: number
  /** "Keep the flow going": auto-advance past an unfinished line after this long. */
  keepFlowTimeoutMs: number
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
  /** Coach vocal projection using the mic level (off for quiet environments). */
  projectionCoaching: boolean
  /** Target loudness 0..1 to aim for when projection coaching is on. */
  projectionTarget: number
}

export const DEFAULT_SETTINGS: AppSettings = {
  recognizer: 'whisper',
  whisperModel: 'tiny',
  tts: 'webspeech',
  passThreshold: 0.8,
  strict: false,
  autoAdvance: true,
  stuckTimeoutMs: 3500,
  keepFlowTimeoutMs: 9000,
  waitForCompletion: true,
  endSilenceMs: 1200,
  speakStageDirections: false,
  ttsRate: 1,
  alwaysShowMyLines: true,
  showDirections: true,
  theme: 'system',
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
