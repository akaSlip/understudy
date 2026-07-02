// Phonetic + fuzzy word comparison used as the substitution cost inside the
// alignment. The point is to *not* mark a correct delivery wrong just because
// the recognizer picked a homophone or a near-spelling: "their/there/they're",
// "to/too/two", "flower/flour" should all count.

import { doubleMetaphone } from 'double-metaphone'

const codeCache = new Map<string, [string, string]>()

export function phoneticCodes(word: string): [string, string] {
  let c = codeCache.get(word)
  if (!c) {
    c = doubleMetaphone(word)
    codeCache.set(word, c)
  }
  return c
}

export function metaphoneMatch(a: string, b: string): boolean {
  const [a1, a2] = phoneticCodes(a)
  const [b1, b2] = phoneticCodes(b)
  if (!a1 && !b1) return false
  return a1 === b1 || a1 === b2 || a2 === b1 || (a2 !== '' && a2 === b2)
}

/** Classic Levenshtein edit distance over characters. Words are short, so the
 *  simple O(n·m) form is more than fast enough. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  const n = a.length
  const m = b.length
  if (n === 0) return m
  if (m === 0) return n
  let prev = new Array<number>(m + 1)
  let curr = new Array<number>(m + 1)
  for (let j = 0; j <= m; j++) prev[j] = j
  for (let i = 1; i <= n; i++) {
    curr[0] = i
    const ai = a.charCodeAt(i - 1)
    for (let j = 1; j <= m; j++) {
      const cost = ai === b.charCodeAt(j - 1) ? 0 : 1
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost)
    }
    ;[prev, curr] = [curr, prev]
  }
  return prev[m]
}

export function charSimilarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length)
  if (maxLen === 0) return 1
  return 1 - levenshtein(a, b) / maxLen
}

/**
 * Graded substitution cost in [0, 1] between two *normalised* words.
 *   0.00  exact match                       → "match" (green)
 *   0.15  homophone (shared metaphone code)  → "near"  (amber, accepted)
 *   0.30  very close spelling (sim > 0.8)    → "near"  (amber, accepted)
 *   0.60  loosely close (sim > 0.6)          → "sub"   (red, but soft)
 *   1.00  unrelated                          → "sub"   (red)
 * In strict mode only exact matches score 0; everything else is a full error.
 */
export function subCost(a: string, b: string, strict = false): number {
  if (a === b) return 0
  if (strict) return 1
  if (a.length > 1 && b.length > 1 && metaphoneMatch(a, b)) return 0.15
  const sim = charSimilarity(a, b)
  if (sim > 0.8) return 0.3
  if (sim > 0.6) return 0.6
  return 1
}

/** Costs at or below this count as an accepted ("near") delivery. */
export const NEAR_THRESHOLD = 0.35
