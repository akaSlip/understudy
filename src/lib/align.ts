// Needleman–Wunsch global alignment over *word tokens* (not characters), with
// full traceback. This single structure yields both the scalar score and the
// per-word match/sub/missing/extra map that drives the teleprompter colours.

import { NEAR_THRESHOLD, subCost } from './phonetics'

export type TokenStatus = 'match' | 'near' | 'sub' | 'missing'

export interface TokenResult {
  status: TokenStatus
  heard?: string
}

export interface AlignResult {
  /** One entry per target token, in order. */
  perToken: TokenResult[]
  /** Hypothesis tokens with no target counterpart (ad-libs / recognizer noise). */
  extras: { heard: string; afterTokenIndex: number }[]
  matched: number
  near: number
  subs: number
  /** Target tokens the actor skipped. */
  dels: number
  /** Extra spoken tokens. */
  ins: number
}

const GAP = 1

type Move = 'diag' | 'up' | 'left'

export function alignTokens(target: string[], hyp: string[], strict = false): AlignResult {
  const n = target.length
  const m = hyp.length

  // dp[i][j] = min cost aligning target[0..i) with hyp[0..j).
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  const bp: (Move | null)[][] = Array.from({ length: n + 1 }, () => new Array<Move | null>(m + 1).fill(null))

  for (let i = 1; i <= n; i++) {
    dp[i][0] = i * GAP
    bp[i][0] = 'up'
  }
  for (let j = 1; j <= m; j++) {
    dp[0][j] = j * GAP
    bp[0][j] = 'left'
  }

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const diag = dp[i - 1][j - 1] + subCost(target[i - 1], hyp[j - 1], strict)
      const up = dp[i - 1][j] + GAP // target token skipped
      const left = dp[i][j - 1] + GAP // extra spoken token
      // Prefer diagonal on ties to keep the alignment tight.
      let best = diag
      let move: Move = 'diag'
      if (up < best) {
        best = up
        move = 'up'
      }
      if (left < best) {
        best = left
        move = 'left'
      }
      dp[i][j] = best
      bp[i][j] = move
    }
  }

  // Backtrace to a reversed op list.
  const revOps: Move[] = []
  let i = n
  let j = m
  while (i > 0 || j > 0) {
    const move = bp[i][j]!
    revOps.push(move)
    if (move === 'diag') {
      i--
      j--
    } else if (move === 'up') {
      i--
    } else {
      j--
    }
  }
  revOps.reverse()

  // Walk forward, emitting per-token results.
  const perToken: TokenResult[] = []
  const extras: { heard: string; afterTokenIndex: number }[] = []
  let t = 0 // next target token index
  let h = 0 // next hyp token index
  let matched = 0
  let near = 0
  let subs = 0
  let dels = 0
  let ins = 0

  for (const move of revOps) {
    if (move === 'diag') {
      const cost = subCost(target[t], hyp[h], strict)
      let status: TokenStatus
      if (cost === 0) {
        status = 'match'
        matched++
      } else if (cost <= NEAR_THRESHOLD) {
        status = 'near'
        near++
      } else {
        status = 'sub'
        subs++
      }
      perToken.push({ status, heard: hyp[h] })
      t++
      h++
    } else if (move === 'up') {
      perToken.push({ status: 'missing' })
      dels++
      t++
    } else {
      extras.push({ heard: hyp[h], afterTokenIndex: t - 1 })
      ins++
      h++
    }
  }

  return { perToken, extras, matched, near, subs, dels, ins }
}
