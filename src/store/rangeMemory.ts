// Remembers the last rehearsed section per (play, character) so returning to a
// scene is one click. Stores the high-level SectionSpec (mode + params, by beat
// / heading id) so it survives edits; resolveSection falls back gracefully when
// a referenced id no longer exists. Understands the legacy {startBeatId,endBeatId}
// shape saved by earlier builds and reads it as a custom range.

import type { SectionSpec } from '../lib/sections'
import { db } from './db'

const key = (playId: string, characterId: string) => `section:${playId}:${characterId}`
const legacyKey = (playId: string, characterId: string) => `range:${playId}:${characterId}`

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

export async function loadSection(playId: string, characterId: string): Promise<SectionSpec | null> {
  const row = (await db.meta.get(key(playId, characterId))) ?? (await db.meta.get(legacyKey(playId, characterId)))
  return normalize(row?.value)
}

export async function saveSection(playId: string, characterId: string, spec: SectionSpec): Promise<void> {
  await db.meta.put({ key: key(playId, characterId), value: spec })
}
