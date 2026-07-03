// ---------------------------------------------------------------------------
// Inline cues
// ---------------------------------------------------------------------------
// Two kinds of inline cue can appear in a dialogue line:
//   {braces}       VOCAL cues — "{angrily}" — steer the voice: premium engines
//                  (ElevenLabs v3) get them as inline acting tags; the free
//                  voices approximate them with pitch / rate / pause shifts.
//   (parentheses)  PERFORMANCE cues — "(draws his sword)", "(to the Ghost)" —
//                  shown to the actor, never spoken, scored, or fed to a voice.
// A line splits into LineSegments at each cue; the plain concatenated words are
// what the actor is scored against and what the voices actually speak.

import type { Beat, LineSegment } from '../types'

/** Break a line on its inline cues. Returns the plain words (for scoring /
 *  speaking) and the ordered segments carrying vocal + performance cues. */
export function splitDirections(text: string): { plain: string; segments: LineSegment[] } {
  const re = /\(([^)]*)\)|\{([^}]*)\}/g
  const segments: LineSegment[] = []
  let cursor = 0
  let curText = ''
  let curDir: string | undefined
  let curCue: string | undefined
  const flush = () => {
    const clean = curText.replace(/\s+/g, ' ').trim()
    if (clean) {
      const seg: LineSegment = { text: clean }
      if (curDir) seg.direction = curDir
      if (curCue) seg.cue = curCue
      segments.push(seg)
      curDir = curCue = undefined // consumed; empty flushes keep them pending
    }
    curText = ''
  }
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const cue = m[1] !== undefined ? m[1].trim() : undefined // (…)
    const dir = m[2] !== undefined ? m[2].trim() : undefined // {…}
    curText += text.slice(cursor, m.index)
    flush()
    if (dir) curDir = curDir ? `${curDir}, ${dir}` : dir
    if (cue) curCue = curCue ? `${curCue}; ${cue}` : cue
    cursor = re.lastIndex
  }
  curText += text.slice(cursor)
  flush()
  // Trailing cues with no words after them — "Goodbye. {sadly}" — attach to the
  // last segment instead of being dropped (or left as scoreable text).
  if ((curDir || curCue) && segments.length) {
    const last = segments[segments.length - 1]
    if (curDir) last.direction = last.direction ? `${last.direction}, ${curDir}` : curDir
    if (curCue) last.cue = last.cue ? `${last.cue}; ${curCue}` : curCue
  }
  const plain = segments.map((s) => s.text).join(' ').replace(/\s+/g, ' ').trim()
  return { plain, segments }
}

/** The delivery segments for a beat (a single plain segment when it has none). */
export function beatSegments(beat: Beat): LineSegment[] {
  if (beat.segments && beat.segments.length) return beat.segments
  return [{ text: beat.text }]
}

/** Rebuild a beat's segments/text from its raw dialogue text. Mutates and
 *  returns the beat. A line that is ONLY a cue — "{angry}" or "(waves)" with no
 *  words — becomes the beat's parenthetical (displayed, not scored/spoken). */
export function applySegments(beat: Beat): Beat {
  if (beat.kind !== 'dialogue') return beat
  const { plain, segments } = splitDirections(beat.text)
  if (!plain) {
    const note = beat.text.replace(/[(){}]/g, ' ').replace(/\s+/g, ' ').trim()
    if (note) {
      beat.parenthetical = beat.parenthetical || note
      beat.text = ''
    }
    delete beat.segments
    return beat
  }
  const hasInline = segments.length > 1 || segments.some((s) => s.direction || s.cue)
  if (!hasInline) {
    delete beat.segments
    return beat
  }
  beat.text = plain
  beat.segments = segments
  return beat
}

/** Premium (ElevenLabs v3) delivery: inline acting tags from VOCAL cues only —
 *  performance cues are stage business, not something the voice should act. */
export function segmentsToTaggedText(segments: LineSegment[]): string {
  return segments
    .map((s) => (s.direction ? `[${s.direction}] ${s.text}` : s.text))
    .join(' ')
    .trim()
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

// Emotion → prosody multipliers for the free Web Speech voice. Keys are matched
// as substrings of the vocal cue, so "very angry" and "angrily" both hit "ang".
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
  [/\bplead|beg|implor|desper/i, { rate: 1.05, pitch: 1.15 }],
  [/\burgent|hurried|rushed|breathless/i, { rate: 1.18, pitch: 1.05 }],
  [/\bslow|deliberate|drawl/i, { rate: 0.78, pitch: 0.98 }],
]

/** Map a vocal cue to Web Speech prosody multipliers (1 = neutral). */
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

// ---------------------------------------------------------------------------
// Voice age bands
// ---------------------------------------------------------------------------

import type { AgeBand } from '../types'

// 'adult' is deliberately absent: it IS the neutral default (age unset).
export const AGE_BANDS: Array<{ value: AgeBand; label: string }> = [
  { value: 'child', label: 'Child' },
  { value: 'adolescent', label: 'Adolescent' },
  { value: 'young-adult', label: 'Young adult' },
  { value: 'senior', label: 'Senior' },
  { value: 'elderly', label: 'Elderly' },
]

/** Phrase folded into the standing delivery for cloud engines. 'adult' is the
 *  neutral default — no phrase. */
export function agePhrase(age?: AgeBand): string | undefined {
  switch (age) {
    case 'child':
      return "a young child's voice"
    case 'adolescent':
      return 'a teenage voice'
    case 'young-adult':
      return 'a young adult voice'
    case 'senior':
      return 'an older, mature voice'
    case 'elderly':
      return 'an elderly, aged voice'
    default:
      return undefined
  }
}

/** Fold a character's standing delivery (age + personality) into segments that
 *  carry no inline {vocal} cue of their own. Lives here — with the other cue
 *  logic — so speaking and pre-generation compose IDENTICALLY (cache keys are
 *  derived from the composed segments). */
export function applyStandingDelivery(
  segments: LineSegment[],
  voice: { direction?: string; age?: AgeBand },
): LineSegment[] {
  const standing = [agePhrase(voice.age), voice.direction].filter(Boolean).join(', ')
  if (!standing) return segments
  return segments.map((s) => (s.direction ? s : { ...s, direction: standing }))
}

/** Pitch/rate multipliers approximating age on the System (Web Speech) voice. */
export function ageProsody(age?: AgeBand): { rate: number; pitch: number } {
  switch (age) {
    case 'child':
      return { rate: 1.08, pitch: 1.5 }
    case 'adolescent':
      return { rate: 1.05, pitch: 1.25 }
    case 'young-adult':
      return { rate: 1.02, pitch: 1.1 }
    case 'senior':
      return { rate: 0.92, pitch: 0.92 }
    case 'elderly':
      return { rate: 0.84, pitch: 0.82 }
    default:
      return { rate: 1, pitch: 1 }
  }
}
