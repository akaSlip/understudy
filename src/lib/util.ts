/** Collision-resistant id. Uses crypto.randomUUID where available. */
export function uid(prefix = ''): string {
  const g = globalThis as unknown as { crypto?: Crypto }
  if (g.crypto?.randomUUID) return prefix + g.crypto.randomUUID()
  // Fallback (non-secure) for older runtimes.
  return prefix + 'xxxxxxxxyxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  }) + Date.now().toString(36)
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}

/** Normalise a character name to an identity key (case/space/extension-insensitive). */
export function characterKey(name: string): string {
  return name
    .replace(/\(.*?\)/g, ' ') // drop (V.O.), (CONT'D), (O.S.)
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .toUpperCase()
}
