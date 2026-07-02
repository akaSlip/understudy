// Turns a recognizer transcript + the known target line into a LineScore:
// per-display-word status, a 0..1 accuracy, WER, and a pass/fail verdict.

import type { ExtraWord, LineScore, TargetWord, WordStatus } from '../types'
import { alignTokens, type TokenStatus } from './align'
import { tokenizeHypothesis, tokenizeTarget } from './normalize'

export interface ScoreOptions {
  /** Accuracy at/above which the line is accepted. Default 0.8. */
  passThreshold?: number
  /** Exact-word matching only (disables homophone/near tolerance). */
  strict?: boolean
}

/** Credit each token type contributes to the accuracy fraction. */
const CREDIT: Record<TokenStatus, number> = { match: 1, near: 0.7, sub: 0, missing: 0 }

function aggregate(statuses: TokenStatus[]): WordStatus {
  // No tokens means the display word is pure punctuation (e.g. a spaced em-dash);
  // there's nothing to say, so it's trivially correct — never a "skip".
  if (statuses.length === 0) return 'match'
  if (statuses.every((s) => s === 'match')) return 'match'
  if (statuses.every((s) => s === 'missing')) return 'missing'
  if (statuses.some((s) => s === 'match' || s === 'near')) return 'near'
  return 'sub'
}

export function scoreLine(target: string, transcript: string, opts: ScoreOptions = {}): LineScore {
  const passThreshold = opts.passThreshold ?? 0.8
  const { rawWords, tokens } = tokenizeTarget(target)
  const hyp = tokenizeHypothesis(transcript)

  // Empty target (e.g. an action beat) — nothing to score.
  if (tokens.length === 0) {
    return { accuracy: 1, wer: 0, words: [], extras: [], transcript, passed: true }
  }

  const al = alignTokens(
    tokens.map((t) => t.text),
    hyp,
    opts.strict,
  )

  // Group token-level results back onto display words.
  const perWordStatuses: TokenStatus[][] = rawWords.map(() => [])
  const perWordHeard: string[][] = rawWords.map(() => [])
  al.perToken.forEach((res, idx) => {
    const rawIndex = tokens[idx].rawIndex
    perWordStatuses[rawIndex].push(res.status)
    if (res.heard) perWordHeard[rawIndex].push(res.heard)
  })

  const words: TargetWord[] = rawWords.map((raw, i) => {
    const status = aggregate(perWordStatuses[i])
    const heard = perWordHeard[i].join(' ')
    return {
      raw,
      norm: tokens.filter((t) => t.rawIndex === i).map((t) => t.text).join(' '),
      status,
      heard: heard || undefined,
    }
  })

  // Map extra tokens onto a display-word insertion point.
  const extras: ExtraWord[] = al.extras.map((e) => {
    const afterTargetIndex =
      e.afterTokenIndex >= 0 && e.afterTokenIndex < tokens.length
        ? tokens[e.afterTokenIndex].rawIndex
        : -1
    return { heard: e.heard, afterTargetIndex }
  })

  const N = tokens.length
  const credit = al.matched * CREDIT.match + al.near * CREDIT.near
  const accuracy = credit / N
  // Lenient WER: accepted "near" tokens are not counted as errors.
  const wer = Math.min(1, (al.subs + al.dels + al.ins) / N)
  // Pass/fail counts accepted near-misses (homophones) at FULL credit —
  // otherwise a short line delivered perfectly as a homophone ("There!" heard
  // "their", 0.7 credit) could never clear the threshold. The displayed
  // accuracy keeps the graded 0.7 so the actor still sees the difference.
  const passFraction = (al.matched + al.near) / N

  return {
    accuracy,
    wer,
    words,
    extras,
    transcript,
    passed: passFraction >= passThreshold,
  }
}
