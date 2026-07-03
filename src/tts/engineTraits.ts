// One table describing what each TTS engine can actually do — the single
// source the UI and engine consult instead of scattering `engine === 'x'`
// special cases. A new engine gets a row here and everything lights up (or
// correctly stays hidden) by itself.

import type { TTSEngine } from '../types'

export interface EngineTraits {
  /** Honours a standing personality phrase (instruction-steerable). */
  personality: boolean
  /** Can convey a perceived age (via prosody or instruction). */
  age: boolean
  /** How many upcoming partner lines to pre-generate. On-device Kokoro is
   *  slow-but-free (deep lookahead); cloud calls cost money (shallow); the
   *  live System voice generates nothing. */
  prefetchDepth: number
}

export const ENGINE_TRAITS: Record<TTSEngine, EngineTraits> = {
  webspeech: { personality: false, age: true, prefetchDepth: 0 },
  kokoro: { personality: false, age: false, prefetchDepth: 4 },
  elevenlabs: { personality: true, age: true, prefetchDepth: 2 },
  openai: { personality: true, age: true, prefetchDepth: 2 },
  azure: { personality: true, age: true, prefetchDepth: 2 },
  gemini: { personality: true, age: true, prefetchDepth: 2 },
}
