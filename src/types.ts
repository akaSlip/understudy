// ---------------------------------------------------------------------------
// Core domain model
// ---------------------------------------------------------------------------
// A Play is a title + a cast of Characters + an ordered list of Beats.
// A Beat is the atomic unit the rehearsal engine walks through: a line of
// dialogue, a stage/action direction, or a scene heading. Dialogue beats are
// attached to a character; during rehearsal the beats belonging to the actor's
// chosen character are the ones they must *speak and be scored on*, and every
// other dialogue beat is *performed by TTS*.

export type TTSEngine = 'webspeech' | 'kokoro' | 'elevenlabs' | 'hume' | 'openai'

export interface VoiceAssignment {
  engine: TTSEngine
  /** Engine-specific voice identifier (e.g. a SpeechSynthesis voice name, a
   *  Kokoro voice id, or an ElevenLabs voiceId). Undefined = engine default. */
  voiceId?: string
  /** 0.5–2.0 playback rate. */
  rate?: number
  /** 0–2 pitch (only honoured by the Web Speech engine). */
  pitch?: number
  /** Natural-language delivery note for instruction-steerable premium engines
   *  (Hume / OpenAI). Ignored by free engines. */
  direction?: string
}

export interface Character {
  id: string
  name: string
  /** Optional per-character voice. If absent, a voice is auto-assigned at
   *  rehearsal time from a rotating pool so characters sound distinct. */
  voice?: VoiceAssignment
  /** Free-text acting notes about the character (not spoken). */
  notes?: string
}

export type BeatKind = 'dialogue' | 'action' | 'heading'

/** A span of a line delivered with a single emotional colour. A line that
 *  shifts "(bewildered) … (angrily) … (defeated) …" becomes several segments,
 *  each spoken with its own delivery: premium engines get the direction as an
 *  inline acting tag, and the free voices approximate it with pitch/rate/pause. */
export interface LineSegment {
  text: string
  /** Delivery note for this span, e.g. "bewildered" (no surrounding parens). */
  direction?: string
}

export interface Beat {
  id: string
  kind: BeatKind
  /** For dialogue beats: the speaking character. */
  characterId?: string
  /** Parenthetical acting direction shown inline, e.g. "(bitterly)". Also fed
   *  to instruction-steerable premium TTS as delivery guidance. */
  parenthetical?: string
  /** The spoken text (dialogue) or the direction/heading text. Always the plain
   *  words with any inline directions removed — used for scoring and as the
   *  fallback when there are no segments. */
  text: string
  /** Present when a dialogue line carries inline delivery shifts. The segments'
   *  text concatenates back to `text`. Absent for a single-tone line. */
  segments?: LineSegment[]
}

export interface Play {
  id: string
  title: string
  author?: string
  characters: Character[]
  beats: Beat[]
  /** How the play entered the library — informational. */
  source: 'seed' | 'manual' | 'fountain' | 'pdf'
  createdAt: number
  updatedAt: number
}

// ---------------------------------------------------------------------------
// Scoring model
// ---------------------------------------------------------------------------
// The scorer aligns what the recognizer heard against the known target line.
// Because the target is known, this is *constrained verification*, not open
// transcription: every target word gets a status, which drives the colour of
// the teleprompter and the 0–100% accuracy number.

export type WordStatus =
  | 'match' // spoken correctly (exact or accepted homophone/near-miss)
  | 'near' // close enough to accept but not exact (shown amber)
  | 'sub' // a different word was said in its place (wrong)
  | 'missing' // the actor skipped this target word

export interface TargetWord {
  /** The word as written in the script (original casing/punctuation). */
  raw: string
  /** Normalised form used for matching. */
  norm: string
  status: WordStatus
  /** What the recognizer actually heard in this slot, if anything. */
  heard?: string
}

export interface ExtraWord {
  heard: string
  /** Index into the target word array *after* which this extra word was said. */
  afterTargetIndex: number
}

export interface LineScore {
  /** 0..1 — fraction of target words matched (near counts as a partial hit). */
  accuracy: number
  /** Word Error Rate 0..1 (substitutions + deletions + insertions) / N. */
  wer: number
  /** Per-target-word results, in script order. */
  words: TargetWord[]
  /** Words the actor said that aren't in the script (ad-libs / recognizer noise). */
  extras: ExtraWord[]
  /** The raw recognizer transcript that produced this score. */
  transcript: string
  /** True once accuracy clears the acceptance threshold. */
  passed: boolean
}

// ---------------------------------------------------------------------------
// Recognizer + TTS abstractions live in their own modules; the engine only
// depends on these narrow shapes.
// ---------------------------------------------------------------------------

export interface RecognitionResult {
  transcript: string
  /** True when this is a final (not interim) hypothesis. */
  isFinal: boolean
}
