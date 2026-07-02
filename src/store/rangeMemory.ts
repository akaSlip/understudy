// Remembers the last rehearsed section per (play, character) so returning to a
// scene is one click. Stores the high-level SectionSpec (mode + params, by beat
// / heading id) so it survives edits; resolveSection falls back gracefully when
// a referenced id no longer exists.
//
// Keyed by the character's NAME (normalised), not their id — character ids can
// be reminted when a play is re-imported, but the name is what the actor picks.
// Reads fall back to the legacy id-based keys saved by earlier builds.

import type { SectionSpec } from '../lib/sections'
import { characterKey } from '../lib/util'
import { db } from './db'

const key = (playId: string, characterName: string) => `section:${playId}:${characterKey(characterName)}`
const legacyIdKey = (playId: string, characterId: string) => `section:${playId}:${characterId}`
const legacyRangeKey = (playId: string, characterId: string) => `range:${playId}:${characterId}`

interface LegacyRange {
  startBeatId: string
  endBeatId: string
}

function normalize(value: unknown): SectionSpec | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (typeof v.mode === 'string') return v as unknown as SectionSpec
  if (typeof v.startBeatId === 'string' && typeof v.endBeatId === 'string') {
    const r = v as unknown as LegacyRange
    return { mode: 'custom', startBeatId: r.startBeatId, endBeatId: r.endBeatId }
  }
  return null
}

export async function loadSection(
  playId: string,
  characterName: string,
  legacyCharacterId?: string,
): Promise<SectionSpec | null> {
  const row =
    (await db.meta.get(key(playId, characterName))) ??
    (legacyCharacterId ? (await db.meta.get(legacyIdKey(playId, legacyCharacterId))) ?? (await db.meta.get(legacyRangeKey(playId, legacyCharacterId))) : undefined)
  return normalize(row?.value)
}

export async function saveSection(playId: string, characterName: string, spec: SectionSpec): Promise<void> {
  await db.meta.put({ key: key(playId, characterName), value: spec })
}
