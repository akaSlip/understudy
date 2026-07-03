// One-time boolean flags (e.g. "the user has done the sound check"), kept in
// the same meta table as the other small persisted state.

import { db } from './db'

export async function getFlag(key: string): Promise<boolean> {
  const row = await db.meta.get(`flag:${key}`)
  return row?.value === true
}

export async function setFlag(key: string, value = true): Promise<void> {
  await db.meta.put({ key: `flag:${key}`, value })
}
