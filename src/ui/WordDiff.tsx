import type { LineScore, TargetWord } from '../types'
import { clamp } from '../lib/util'

function mask(word: string): string {
  const letters = word.replace(/[^\p{L}\p{N}]/gu, '')
  return '·'.repeat(clamp(letters.length, 2, 9))
}

/**
 * Renders the actor's line as a live diff:
 *  - before reveal: correctly-spoken words illuminate (green/amber) while wrong
 *    or not-yet-said words stay masked, preserving the off-book challenge.
 *  - after reveal: the full correct text is shown, coloured by status.
 */
export function WordDiff({ words, revealed, score }: { words: TargetWord[]; revealed: boolean; score?: LineScore }) {
  if (!words.length) return null
  return (
    <p className="worddiff">
      {words.map((w, i) => (
        <WordSpan key={i} w={w} revealed={revealed} />
      ))}
      {revealed && score && score.extras.length > 0 && (
        <span className="extras"> (heard extra: {score.extras.map((e) => e.heard).join(', ')})</span>
      )}
    </p>
  )
}

function WordSpan({ w, revealed }: { w: TargetWord; revealed: boolean }) {
  const spoken = w.status === 'match' || w.status === 'near'
  const show = revealed || spoken
  const cls = `word ${w.status}${show ? '' : ' hidden'}`
  const title =
    w.status === 'sub' && w.heard ? `heard: "${w.heard}"` : w.status === 'missing' ? 'skipped' : undefined
  return (
    <span className={cls} title={title}>
      {show ? w.raw : mask(w.raw)}{' '}
    </span>
  )
}
