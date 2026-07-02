// ---------------------------------------------------------------------------
// Inline delivery directions
// ---------------------------------------------------------------------------
// A single spoken line can shift emotion partway through, e.g.
//   "(bewildered) What is this? (angrily) How dare you! (defeated) …I give up."
// We split such a line into LineSegments, each with its own delivery note. The
// premium engines (ElevenLabs v3) take the note as an inline acting tag for
// genuine emotion; the free on-device voices approximate it with pitch / rate /
// pause shifts. The plain concatenated words are what we score against.

import type { Beat, LineSegment } from '../types'

/** A parenthetical is treated as a *delivery direction* (rather than literal
 *  spoken text) only when it's short and note-like — no sentence punctuation and
 *  a handful of words at most. This keeps genuine parenthetical asides in a line
 *  from being swallowed. */
function looksLikeDirection(s: string): boolean {
  const t = s.trim()
  if (!t || t.length > 40) return false
  // Sentence punctuation or a comma signals a spoken aside, not a delivery note.
  if (/[.?!;:,]/.test(t)) return false
  return t.split(/\s+/).length <= 5
}

/** Break a line on its inline direction parentheticals. Returns the plain words
 *  (for scoring/display fallback) and the ordered segments. */
export function splitDirections(text: string): { plain: string; segments: LineSegment[] } {
  const re = /\(([^)]+)\)/g
  const segments: LineSegment[] = []
  let cursor = 0
  let curText = ''
  let curDir: string | undefined
  const flush = () => {
    const clean = curText.replace(/\s+/g, ' ').trim()
    if (clean) {
      segments.push(curDir ? { text: clean, direction: curDir } : { text: clean })
      curDir = undefined // consumed — only a direction with NO text stays pending
    }
    curText = ''
  }
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const content = m[1].trim()
    if (looksLikeDirection(content)) {
      curText += text.slice(cursor, m.index)
      flush()
      curDir = content
    } else {
      // Not a direction — keep the literal parenthesis as spoken text.
      curText += text.slice(cursor, re.lastIndex)
    }
    cursor = re.lastIndex
  }
  curText += text.slice(cursor)
  flush()
  // A trailing direction with no words after it — "Goodbye. (sadly)" — would
  // otherwise be dropped AND left in the spoken text. Attach it to the last
  // segment instead so it still colours the delivery.
  if (curDir && segments.length) {
    const last = segments[segments.length - 1]
    last.direction = last.direction ? `${last.direction}, ${curDir}` : curDir
  }
  const plain = segments.map((s) => s.text).join(' ').replace(/\s+/g, ' ').trim()
  return { plain, segments }
}

/** The delivery segments for a beat: its explicit segments, or a single segment
 *  carrying any whole-line parenthetical as the direction. */
export function beatSegments(beat: Beat): LineSegment[] {
  if (beat.segments && beat.segments.length) return beat.segments
  return [beat.parenthetical ? { text: beat.text, direction: beat.parenthetical } : { text: beat.text }]
}

/** Rebuild a beat's segments/text/parenthetical from its raw dialogue text.
 *  Folds a leading whole-line parenthetical into the first segment's direction
 *  so premium tags and on-screen notes stay in sync. Mutates and returns beat. */
export function applySegments(beat: Beat): Beat {
  if (beat.kind !== 'dialogue') return beat
  const { plain, segments } = splitDirections(beat.text)
  // A line that is ONLY a direction — "(bewildered)" with no words — must not
  // remain as scoreable/speakable text; treat it as the line's parenthetical.
  if (!plain && !segments.length) {
    const dir = beat.text.replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim()
    if (dir && looksLikeDirection(dir)) {
      beat.parenthetical = beat.parenthetical || dir
      beat.text = ''
      delete beat.segments
      return beat
    }
  }
  const hasInline = segments.length > 1 || segments.some((s) => s.direction)
  if (!hasInline) {
    delete beat.segments
    return beat
  }
  if (beat.parenthetical && segments[0] && !segments[0].direction) {
    segments[0] = { ...segments[0], direction: beat.parenthetical }
    beat.parenthetical = undefined
  }
  beat.text = plain
  beat.segments = segments
  return beat
}

/** Premium (ElevenLabs v3) delivery: inline acting tags, one per segment. */
export function segmentsToTaggedText(segments: LineSegment[]): string {
  return segments
    .map((s) => (s.direction ? `[${s.direction}] ${s.text}` : s.text))
    .join(' ')
    .trim()
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

// Emotion → prosody multipliers for the free Web Speech voice. Keys are matched
// as substrings of the direction, so "very angry" and "angrily" both hit "ang".
const PROSODY: Array<[RegExp, { rate: number; pitch: number }]> = [
  [/\bang|furi|rage|irate|snap|snarl/i, { rate: 1.12, pitch: 0.9 }],
  [/\bshout|yell|loud/i, { rate: 1.12, pitch: 1.12 }],
  [/\bsad|depress|defeat|despair|glum|mourn|grief|weary|resign|dejec/i, { rate: 0.82, pitch: 0.85 }],
  [/\bcry|sob|tearful|weep/i, { rate: 0.8, pitch: 0.92 }],
  [/\bbewild|confus|puzzl|baffl|perplex|unsure|hesit/i, { rate: 0.92, pitch: 1.1 }],
  [/\bsurpris|shock|astonish|aghast|amaz/i, { rate: 1.08, pitch: 1.22 }],
  [/\bexcit|eager|thrill|elat|delight/i, { rate: 1.15, pitch: 1.15 }],
  [/\bhapp|joy|cheer|gleeful|merry|warm/i, { rate: 1.05, pitch: 1.1 }],
  [/\bafraid|fear|terrif|scared|panic|anxi|nervous/i, { rate: 1.1, pitch: 1.12 }],
  [/\bwhisper|soft|gentl|quiet|hush|tender/i, { rate: 0.92, pitch: 0.98 }],
  [/\bcold|bitter|coldly|icy|scorn|conte|sneer/i, { rate: 0.95, pitch: 0.9 }],
  [/\bcalm|serene|steady|measured|matter-of-fact/i, { rate: 0.96, pitch: 0.98 }],
  [/\bsarcas|wry|mock|dry|ironic/i, { rate: 0.98, pitch: 0.95 }],
  [/\bproud|firm|resolute|command|defiant|bold/i, { rate: 1.0, pitch: 0.96 }],
  [/\bple, |plead|beg|implor|desper/i, { rate: 1.05, pitch: 1.15 }],
]

/** Map a direction note to Web Speech prosody multipliers (1 = neutral). */
export function directionToProsody(direction?: string): { rate: number; pitch: number } {
  if (!direction) return { rate: 1, pitch: 1 }
  for (const [re, p] of PROSODY) if (re.test(direction)) return p
  return { rate: 1, pitch: 1 }
}

/** Extra pause (ms) between segments so an emotional turn lands. */
export function segmentGapMs(direction?: string): number {
  if (!direction) return 220
  if (/\bdepress|defeat|despair|sad|resign|grief|dejec/i.test(direction)) return 420
  if (/\bbewild|confus|puzzl|hesit|pause|beat/i.test(direction)) return 380
  return 260
}

export { clamp as clampProsody }
