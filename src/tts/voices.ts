// Assigns a distinct voice to each character so the scene partner doesn't sound
// like one person reading everyone. Honours an explicit per-character voice when
// it matches the active engine; otherwise casts from the engine's pool, matching
// the character's likely gender (guessed from their name) and keeping every
// character's voice unique within the session.

import type { Character, TTSEngine, VoiceAssignment } from '../types'
import { guessGender, type Gender } from '../lib/gender'
import { KOKORO_VOICES } from './kokoro'
import { listWebSpeechVoices } from './webspeech'

export interface PoolVoice {
  id: string
  gender?: Gender
}

// Default ElevenLabs library voices (only used once premium is configured).
const ELEVEN_POOL: PoolVoice[] = [
  { id: '21m00Tcm4TlvDq8ikWAM', gender: 'f' }, // Rachel
  { id: 'AZnzlk1XvdvUeBnXmlld', gender: 'f' }, // Domi
  { id: 'EXAVITQu4vr4xnSDxMaL', gender: 'f' }, // Bella
  { id: 'ErXwobaYiN019PkySvjV', gender: 'm' }, // Antoni
]

/** Infer a Web Speech voice's gender from its name/URI ("…Female", "David", …). */
function webSpeechGender(label: string, id: string): Gender | undefined {
  const s = `${label} ${id}`.toLowerCase()
  if (/\b(female|woman|girl)\b/.test(s)) return 'f'
  if (/\b(male|man|boy)\b/.test(s)) return 'm'
  // Fall back to a recognisable given name in the voice's label (e.g. "Zira").
  return guessGender(label)
}

/** The engine's available voices, each tagged with a gender when we can tell. */
export async function genderedPool(engine: TTSEngine): Promise<PoolVoice[]> {
  if (engine === 'kokoro') {
    // Interleave female/male so sequential casting alternates for contrast.
    const f = KOKORO_VOICES.filter((v) => v.gender === 'f')
    const m = KOKORO_VOICES.filter((v) => v.gender === 'm')
    const out: PoolVoice[] = []
    for (let i = 0; i < Math.max(f.length, m.length); i++) {
      if (f[i]) out.push({ id: f[i].id, gender: 'f' })
      if (m[i]) out.push({ id: m[i].id, gender: 'm' })
    }
    return out
  }
  if (engine === 'webspeech') {
    const voices = await listWebSpeechVoices()
    const english = voices.filter((v) => /^en/i.test(v.lang ?? ''))
    const list = english.length ? english : voices
    const pool = list.map((v) => ({ id: v.id, gender: webSpeechGender(v.label, v.id) }))
    return pool.length ? pool : [{ id: '' }]
  }
  return ELEVEN_POOL
}

/** Back-compat: just the ids of the engine's pool. */
export async function voicePool(engine: TTSEngine): Promise<string[]> {
  return (await genderedPool(engine)).map((v) => v.id)
}

export async function buildVoiceMap(
  characters: Character[],
  engine: TTSEngine,
  rate: number,
  /** The actor's own character — excluded so it never consumes a partner voice. */
  myCharacterId?: string,
): Promise<Map<string, VoiceAssignment>> {
  const pool = await genderedPool(engine)
  const map = new Map<string, VoiceAssignment>()
  const used = new Set<string>()

  // Pass 1: explicit voices for this engine win, and reserve their id.
  for (const c of characters) {
    if (c.id === myCharacterId) continue
    if (c.voice && c.voice.engine === engine) {
      map.set(c.id, { rate, ...c.voice })
      if (c.voice.voiceId) used.add(c.voice.voiceId)
    }
  }

  // Pass 2: auto-cast the rest, preferring the character's gender and an unused
  // voice, degrading gracefully to any unused, then reusing if the pool is small.
  const pickFor = (g?: Gender): string | undefined => {
    const byGenderUnused = pool.find((v) => v.gender === g && !used.has(v.id))
    const anyUnused = pool.find((v) => !used.has(v.id))
    const byGender = pool.find((v) => v.gender === g)
    const pick = byGenderUnused ?? anyUnused ?? byGender ?? pool[0]
    if (pick) used.add(pick.id)
    return pick?.id || undefined
  }
  for (const c of characters) {
    if (c.id === myCharacterId || map.has(c.id)) continue
    map.set(c.id, { engine, voiceId: pickFor(guessGender(c.name)), rate, direction: c.voice?.direction })
  }
  return map
}
