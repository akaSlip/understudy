// Assigns a distinct voice to each character so the scene partner doesn't sound
// like one person reading everyone. Honours an explicit per-character voice when
// it matches the active engine; otherwise rotates through the engine's pool.

import type { Character, TTSEngine, VoiceAssignment } from '../types'
import { KOKORO_VOICES } from './kokoro'
import { listWebSpeechVoices } from './webspeech'

// Default ElevenLabs library voices (only used once premium is configured).
const ELEVEN_POOL = ['21m00Tcm4TlvDq8ikWAM', 'AZnzlk1XvdvUeBnXmlld', 'EXAVITQu4vr4xnSDxMaL', 'ErXwobaYiN019PkySvjV']

export async function voicePool(engine: TTSEngine): Promise<string[]> {
  if (engine === 'kokoro') {
    // Interleave female/male for contrast.
    const f = KOKORO_VOICES.filter((v) => v.gender === 'f').map((v) => v.id)
    const m = KOKORO_VOICES.filter((v) => v.gender === 'm').map((v) => v.id)
    const out: string[] = []
    for (let i = 0; i < Math.max(f.length, m.length); i++) {
      if (f[i]) out.push(f[i])
      if (m[i]) out.push(m[i])
    }
    return out
  }
  if (engine === 'webspeech') {
    const voices = await listWebSpeechVoices()
    const english = voices.filter((v) => /^en/i.test(v.lang ?? ''))
    const pool = (english.length ? english : voices).map((v) => v.id)
    return pool.length ? pool : ['']
  }
  return ELEVEN_POOL
}

export async function buildVoiceMap(
  characters: Character[],
  engine: TTSEngine,
  rate: number,
): Promise<Map<string, VoiceAssignment>> {
  const pool = await voicePool(engine)
  const map = new Map<string, VoiceAssignment>()
  characters.forEach((c, i) => {
    if (c.voice && c.voice.engine === engine) {
      map.set(c.id, { rate, ...c.voice })
    } else {
      map.set(c.id, {
        engine,
        voiceId: pool[i % pool.length] || undefined,
        rate,
        direction: c.voice?.direction,
      })
    }
  })
  return map
}
