import type { Play } from '../types'
import { buildSeedPlay, SEED_PLAYS, SEED_VERSION } from '../lib/seed'
import { db } from './db'

export async function getAllPlays(): Promise<Play[]> {
  const plays = await db.plays.toArray()
  return plays.sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function getPlay(id: string): Promise<Play | undefined> {
  return db.plays.get(id)
}

export async function savePlay(play: Play): Promise<void> {
  play.updatedAt = Date.now()
  await db.plays.put(play)
}

export async function deletePlay(id: string): Promise<void> {
  await db.plays.delete(id)
}

/** Seed the sample plays, and refresh them when SEED_VERSION increases (e.g.
 *  after a parser fix). Only the built-in samples (source: 'seed') are replaced
 *  — the user's own created/imported plays are left untouched. */
export async function seedIfFirstRun(): Promise<void> {
  const row = await db.meta.get('seedVersion')
  const version = typeof row?.value === 'number' ? (row.value as number) : 0
  if (version >= SEED_VERSION) return

  const all = await db.plays.toArray()
  const oldSeedIds = all.filter((p) => p.source === 'seed').map((p) => p.id)
  if (oldSeedIds.length) await db.plays.bulkDelete(oldSeedIds)

  const now = Date.now()
  await db.plays.bulkPut(SEED_PLAYS.map((def, i) => buildSeedPlay(def, now - i)))
  await db.meta.put({ key: 'seedVersion', value: SEED_VERSION })
}
