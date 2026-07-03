// Rehearsal state machine. Walks a selected list of the play's beats (a whole
// play, one scene, or just the actor's lines with cue context — see lib/sections):
//   • partner dialogue  → TTS performs it, then advances
//   • stage/heading      → shown (optionally narrated), then advances
//   • the actor's line   → listen, score against the known line, and reveal the
//                          line as a prompt when they go quiet or stall.
// The engine is UI-agnostic: it pushes immutable snapshots via onUpdate.

import type { Beat, LineScore, LineSegment, Play, VoiceAssignment } from '../types'
import type { Recognizer } from '../audio/recognizer'
import type { AppSettings } from '../store/settings'
import type { Speaker } from '../tts/speaker'
import { scoreLine } from '../lib/scorer'
import { beatSegments } from '../lib/directions'
import { ENGINE_TRAITS } from '../tts/engineTraits'

export type Phase = 'idle' | 'partner' | 'stage' | 'listening' | 'scored' | 'stuck' | 'paused' | 'done'

/** Input level above which a frame counts as "speaking" for projection stats. */
const VOICED_LEVEL = 0.12

export interface LineAttempt {
  beatId: string
  characterName: string
  target: string
  transcript: string
  accuracy: number
  passed: boolean
  /** Mean input loudness 0..1 while delivering this line (projection coaching). */
  projection?: number
}

export interface RehearsalState {
  phase: Phase
  beatIndex: number
  totalBeats: number
  beat?: Beat
  isMyLine: boolean
  /** During a partner line: true once audio is actually playing (false while
   *  the voice is still being generated — first run of a play). */
  partnerSpeaking: boolean
  /** Accumulated recognizer transcript for the current line. */
  transcript: string
  score?: LineScore
  /** Show the full correct text as a prompt. */
  revealed: boolean
  /** Mic is armed for the actor's line. */
  listening: boolean
  progressPct: number
  attempts: LineAttempt[]
  error?: string
}

export interface EngineDeps {
  play: Play
  myCharacterId: string
  speaker: Speaker
  recognizer: Recognizer
  voiceMap: Map<string, VoiceAssignment>
  narratorVoice: VoiceAssignment
  settings: AppSettings
  onUpdate: (s: RehearsalState) => void
  /** Live mic loudness 0..1 during the actor's line, for the listening meter. */
  onLevel?: (level: number) => void
  /** Ordered beat indices to rehearse. Defaults to rangeStart..rangeEnd, else all. */
  beatOrder?: number[]
  rangeStart?: number
  rangeEnd?: number
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

/** True once the actor has spoken through to the end of the line — the last
 *  *speakable* target word is no longer "missing". Trailing punctuation-only
 *  display words (a stray "—" or "…", which have no norm) are skipped so they
 *  can't make a mid-line pause look finished. Used to avoid accepting a passing
 *  score on a partial transcript before the line is actually finished. */
function reachedLineEnd(score: LineScore): boolean {
  const w = score.words
  for (let i = w.length - 1; i >= 0; i--) {
    if (w[i].norm) return w[i].status !== 'missing'
  }
  return true // nothing speakable (all punctuation) → treat as finished
}

/** Build the ordered, valid beat-index list this run will walk. */
function buildOrder(deps: EngineDeps, n: number): number[] {
  const valid = (i: number) => Number.isInteger(i) && i >= 0 && i < n
  if (deps.beatOrder && deps.beatOrder.length) {
    return [...new Set(deps.beatOrder.filter(valid))].sort((a, b) => a - b)
  }
  if (n === 0) return []
  const last = n - 1
  const s = clamp(deps.rangeStart ?? 0, 0, last)
  const e = clamp(deps.rangeEnd ?? last, s, last)
  const out: number[] = []
  for (let i = s; i <= e; i++) out.push(i)
  return out
}

export class RehearsalEngine {
  private pos = -1 // position within `order`
  private running = false
  private phase: Phase = 'idle'
  private pausedPhase: Phase = 'idle'
  private transcript = ''
  private score: LineScore | undefined
  private revealed = false
  private speakingCharId: string | undefined
  private partnerSpeaking = false
  private attempts: LineAttempt[] = []
  private error: string | undefined
  /** True while `error` describes a TTS failure (vs a recognizer one) — lets a
   *  recovered voice clear its own notice without hiding recognizer errors. */
  private ttsError = false

  // Projection stats for the current line.
  private levelSum = 0
  private levelCount = 0
  // Live override for auto-cue (auto-advance); falls back to the setting.
  private autoCueOverride: boolean | undefined
  // Live in-rehearsal controls (Tune panel).
  private scoring = true
  private passThresholdOverride: number | undefined

  private stuckTimer?: ReturnType<typeof setTimeout>
  private revealBackstopTimer?: ReturnType<typeof setTimeout>
  private advanceTimer?: ReturnType<typeof setTimeout>

  private readonly beats: Beat[]
  private readonly charName: Map<string, string>
  private readonly order: number[]

  constructor(private deps: EngineDeps) {
    this.beats = deps.play.beats
    this.charName = new Map(deps.play.characters.map((c) => [c.id, c.name]))
    this.order = buildOrder(deps, this.beats.length)
  }

  private curIdx(): number {
    return this.order[this.pos] ?? -1
  }
  private curBeat(): Beat | undefined {
    return this.beats[this.curIdx()]
  }

  // -- lifecycle ------------------------------------------------------------

  /** Starts the recognizer and enters the first beat. Rethrows a recognizer
   *  start failure so the caller can show its error flow instead of landing the
   *  user on a broken stage view. */
  async start(): Promise<void> {
    this.running = true
    try {
      await this.deps.recognizer.start({
        onFinal: (t) => this.onFinal(t),
        onLevel: (l) => this.handleLevel(l),
        onError: (e) => {
          this.error = e.message
          this.emit()
        },
      })
    } catch (e) {
      this.running = false
      throw e
    }
    this.prefetchAhead(2) // warm the opening scene-partner lines
    this.goToPos(0)
  }

  dispose(): void {
    this.running = false
    this.clearTimers()
    this.deps.speaker.stop()
    void this.deps.recognizer.stop()
  }

  /** End the run early and surface the session summary. */
  endSession(): void {
    this.recordAttemptIfMyLine()
    this.finish()
  }

  private autoCue(): boolean {
    return this.autoCueOverride ?? this.deps.settings.autoAdvance
  }

  private passThreshold(): number {
    return this.passThresholdOverride ?? this.deps.settings.passThreshold
  }

  /** Adjust the accuracy-to-pass live; applies from the next scoring event. */
  setPassThreshold(v: number): void {
    this.passThresholdOverride = v
  }

  /** Turn line scoring on/off mid-rehearsal. Off = read-along mode: the actor's
   *  lines are shown as prompts, the mic stays off, and they advance with Next. */
  setScoring(on: boolean): void {
    this.scoring = on
    if (!this.isMyLine() || this.phase === 'paused' || this.phase === 'done') return
    if (!on) {
      this.clearTimers()
      this.deps.recognizer.setActive(false)
      this.revealed = true
      if (this.phase === 'listening') this.phase = 'stuck'
      this.emit()
    } else if (this.phase === 'stuck' || this.phase === 'listening') {
      this.retryLine() // re-arm the current line for a fresh scored attempt
    }
  }

  /** Toggle auto-cue mid-session. Turning it on while sitting on a passed line
   *  advances shortly after. */
  setAutoCue(on: boolean): void {
    this.autoCueOverride = on
    if (on && this.phase === 'scored') {
      this.clearTimers()
      this.advanceTimer = setTimeout(() => this.goToPos(this.pos + 1), 400)
    } else if (!on && this.advanceTimer && this.phase === 'scored') {
      // Turning it off must also cancel an advance that's already scheduled —
      // but ONLY the auto-cue one: on a stage beat the same timer field holds
      // the stage-direction advance, which is not governed by auto-cue.
      clearTimeout(this.advanceTimer)
      this.advanceTimer = undefined
    }
  }

  /** Reassign a character's scene-partner voice mid-rehearsal. If that character
   *  is speaking right now, the line restarts in the new voice; upcoming lines
   *  are re-warmed. */
  setVoice(characterId: string, voiceId?: string): void {
    const base = this.deps.voiceMap.get(characterId)
    const engine = base?.engine ?? this.deps.narratorVoice.engine
    const rate = base?.rate ?? this.deps.narratorVoice.rate
    this.deps.voiceMap.set(characterId, { ...base, engine, rate, voiceId })
    if (this.phase === 'partner' && this.speakingCharId === characterId) {
      this.goToPos(this.pos) // re-speak the current line with the new voice
    } else {
      this.prefetchAhead(2)
    }
  }

  // -- manual controls ------------------------------------------------------

  pause(): void {
    if (this.phase === 'done' || this.phase === 'paused' || this.phase === 'idle') return
    this.pausedPhase = this.phase
    this.clearTimers()
    this.deps.speaker.stop()
    this.deps.recognizer.setActive(false)
    this.phase = 'paused'
    this.emit()
  }

  resume(): void {
    if (this.phase !== 'paused') return
    // A line that was already passed must not be re-opened for listening.
    if (this.pausedPhase === 'scored') {
      this.phase = 'scored'
      this.emit()
      if (this.autoCue()) {
        this.advanceTimer = setTimeout(() => this.goToPos(this.pos + 1), 750)
      }
      return
    }
    this.enter()
  }

  next(): void {
    this.recordAttemptIfMyLine()
    this.goToPos(this.pos + 1)
  }

  prev(): void {
    let p = this.pos - 1
    while (p > 0 && this.beats[this.order[p]]?.kind !== 'dialogue') p--
    this.goToPos(Math.max(0, p))
  }

  reveal(): void {
    this.revealed = true
    if (this.phase === 'listening') this.phase = 'stuck'
    this.emit()
  }

  retryLine(): void {
    if (!this.isMyLine()) return
    if (this.phase === 'paused' || this.phase === 'done') return
    this.clearTimers()
    this.transcript = ''
    this.score = undefined
    this.revealed = false
    this.error = undefined
    this.resetProjection()
    this.phase = 'listening'
    this.deps.recognizer.setActive(true) // fresh capture session
    this.armTimers()
    this.emit()
  }

  // -- flow -----------------------------------------------------------------

  private goToPos(pos: number): void {
    this.clearTimers()
    this.deps.speaker.stop()
    this.deps.recognizer.setActive(false) // mute mic across the transition
    this.transcript = ''
    this.score = undefined
    this.revealed = false
    this.speakingCharId = undefined
    this.partnerSpeaking = false
    if (pos >= this.order.length) {
      this.pos = this.order.length
      this.finish()
      return
    }
    this.pos = Math.max(0, pos)
    this.enter()
  }

  private enter(): void {
    if (!this.running) return
    const beat = this.curBeat()
    if (this.pos < 0 || !beat) return

    // Pre-generate upcoming scene-partner audio (neural voices) so it plays the
    // instant it's reached rather than stalling to synthesise on demand.
    this.prefetchAhead(2)

    if (beat.kind !== 'dialogue') {
      this.deps.recognizer.setActive(false)
      this.phase = 'stage'
      this.emit()
      if (this.deps.settings.speakStageDirections && beat.text.trim()) {
        this.performLine(beatSegments(beat), this.deps.narratorVoice).then(
          () => this.afterStage(),
          () => {}, // aborted by a transition
        )
      } else {
        this.advanceTimer = setTimeout(() => this.afterStage(), 1100)
      }
      return
    }

    if (beat.characterId === this.deps.myCharacterId) {
      if (!this.scoring) {
        // Read-along mode: show the line as a prompt, no mic, advance via Next.
        this.deps.recognizer.setActive(false)
        this.revealed = true
        this.phase = 'stuck'
        this.emit()
        return
      }
      // The actor's line — arm the mic for a fresh capture session.
      this.resetProjection()
      this.phase = 'listening'
      this.deps.recognizer.setActive(true)
      this.emit()
      this.armTimers()
      return
    }

    // A partner line — keep the mic disarmed so the TTS isn't captured.
    this.deps.recognizer.setActive(false)
    this.phase = 'partner'
    this.speakingCharId = beat.characterId
    this.emit()
    const voice = this.deps.voiceMap.get(beat.characterId!) ?? this.deps.narratorVoice
    this.performLine(beatSegments(beat), voice).then(
      () => {
        if (this.running && this.phase === 'partner') this.goToPos(this.pos + 1)
      },
      () => {}, // aborted by a transition (pause / next / setVoice)
    )
  }

  private afterStage(): void {
    if (this.running && this.phase === 'stage') this.goToPos(this.pos + 1)
  }

  /** Speak a line with graceful degradation, shared by partner dialogue and
   *  stage narration: a real generation failure (bad API key, offline, rate
   *  limit) surfaces the reason and retries once with the free system voice, so
   *  a broken cloud voice never freezes or silences the rehearsal. Resolves
   *  once spoken (either voice) or unspeakable; rejects only when aborted by a
   *  transition. */
  private async performLine(segments: LineSegment[], voice: VoiceAssignment): Promise<void> {
    const isAbort = (e: unknown) => (e as { name?: string })?.name === 'AbortError'
    const onStart = () => {
      this.partnerSpeaking = true // audio is actually playing now
      this.emit()
    }
    try {
      await this.deps.speaker.speakSegments(segments, voice, onStart)
      // The primary voice works (again) — retire any stale fallback notice
      // (but never a recognizer error, which this says nothing about).
      if (this.ttsError) {
        this.ttsError = false
        this.error = undefined
      }
    } catch (e) {
      if (isAbort(e)) throw e
      this.error = `Voice playback failed — using the system voice. (${e instanceof Error ? e.message : String(e)})`
      this.ttsError = true
      this.emit()
      if (voice.engine === 'webspeech') return // no different voice to fall back to
      try {
        await this.deps.speaker.speakSegments(segments, { engine: 'webspeech', rate: voice.rate }, onStart)
      } catch (e2) {
        if (isAbort(e2)) throw e2
        // Even the fallback failed (no speech synthesis at all) — keep the flow.
      }
    }
  }

  /** Fire-and-forget pre-generation of upcoming scene-partner lines (blob
   *  voices only; the Speaker no-ops for the live Web Speech voice and de-dupes
   *  against the eventual playback). Kokoro looks further ahead than the given
   *  count: on-device generation is free but slow (especially WASM), and a
   *  cluster of consecutive partner lines can outrun a shallow prefetch —
   *  the "partner slow to speak mid-scene on first run" symptom. */
  private prefetchAhead(count: number): void {
    count = Math.max(count, ENGINE_TRAITS[this.deps.settings.tts]?.prefetchDepth ?? count)
    let found = 0
    for (let p = this.pos + 1; p < this.order.length && found < count; p++) {
      const b = this.beats[this.order[p]]
      if (b?.kind === 'dialogue' && b.characterId && b.characterId !== this.deps.myCharacterId) {
        const voice = this.deps.voiceMap.get(b.characterId) ?? this.deps.narratorVoice
        void this.deps.speaker.pregenerateSegments(beatSegments(b), voice).catch(() => {})
        found++
      }
    }
  }

  // -- recognition + scoring ------------------------------------------------

  private handleLevel(level: number): void {
    this.deps.onLevel?.(level)
    if ((this.phase === 'listening' || this.phase === 'stuck') && level > VOICED_LEVEL) {
      this.levelSum += level
      this.levelCount++
    }
  }

  private resetProjection(): void {
    this.levelSum = 0
    this.levelCount = 0
  }

  private onFinal(text: string): void {
    if (this.phase !== 'listening' && this.phase !== 'stuck') return
    if (!text.trim()) return
    this.transcript = (this.transcript + ' ' + text).trim()
    const beat = this.curBeat()!
    this.score = scoreLine(beat.text, this.transcript, {
      passThreshold: this.passThreshold(),
      strict: this.deps.settings.strict,
    })
    // Got speech → reset the "stuck" watchdog.
    this.armStuckTimer()
    // Only accept the line once the actor has actually reached its end, so a
    // pause partway through doesn't score (and skip) a half-delivered line.
    const complete = !this.deps.settings.waitForCompletion || reachedLineEnd(this.score)
    if (this.score.passed && complete) {
      this.onLinePassed()
    } else {
      this.emit()
    }
  }

  private onLinePassed(): void {
    this.clearTimers()
    this.deps.recognizer.setActive(false) // line accepted — stop listening
    this.phase = 'scored'
    this.error = undefined // things are working again — drop any stale banner
    this.ttsError = false
    this.recordAttemptIfMyLine()
    this.emit()
    if (this.autoCue()) {
      this.advanceTimer = setTimeout(() => this.goToPos(this.pos + 1), 750)
    }
  }

  // -- timers ---------------------------------------------------------------

  /** Arm the per-line timers: the sliding stuck watchdog plus an ABSOLUTE
   *  reveal backstop. The stuck timer re-arms on every recognised chunk, so an
   *  actor producing (even wrong) speech every few seconds could slide it
   *  forever — the backstop guarantees the full-line prompt still appears. */
  private armTimers(): void {
    this.armStuckTimer()
    if (this.revealBackstopTimer) clearTimeout(this.revealBackstopTimer)
    const ms = Math.max(9000, this.deps.settings.stuckTimeoutMs * 3)
    this.revealBackstopTimer = setTimeout(() => {
      if ((this.phase === 'listening' || this.phase === 'stuck') && !this.revealed) {
        this.revealed = true
        if (this.phase === 'listening') this.phase = 'stuck'
        this.emit()
      }
    }, ms)
  }

  private armStuckTimer(): void {
    if (this.stuckTimer) clearTimeout(this.stuckTimer)
    if (this.deps.settings.stuckTimeoutMs > 0) {
      this.stuckTimer = setTimeout(() => {
        if (this.phase === 'listening') {
          this.revealed = true
          this.phase = 'stuck'
          this.emit()
        }
      }, this.deps.settings.stuckTimeoutMs)
    }
  }

  private clearTimers(): void {
    for (const t of [this.stuckTimer, this.revealBackstopTimer, this.advanceTimer]) if (t) clearTimeout(t)
    this.stuckTimer = this.revealBackstopTimer = this.advanceTimer = undefined
  }

  // -- bookkeeping ----------------------------------------------------------

  private isMyLine(): boolean {
    const b = this.curBeat()
    return !!b && b.kind === 'dialogue' && b.characterId === this.deps.myCharacterId
  }

  private recordAttemptIfMyLine(): void {
    if (!this.isMyLine()) return
    const beat = this.curBeat()!
    const next = this.buildAttempt(beat)
    // One entry per line, however it was reached (retry, Prev navigation, …) —
    // duplicates would inflate the summary's counts and averages. The array is
    // one entry per distinct line, so a linear scan is plenty.
    const at = this.attempts.findIndex((a) => a.beatId === beat.id)
    if (at >= 0) {
      const prev = this.attempts[at]
      // Keep the best attempt for a line — never downgrade a pass on retry.
      if (next.accuracy >= prev.accuracy || (!prev.passed && next.passed)) {
        this.attempts[at] = next
      }
      return
    }
    if (this.transcript || this.score) this.attempts.push(next)
  }

  private buildAttempt(beat: Beat): LineAttempt {
    return {
      beatId: beat.id,
      characterName: this.charName.get(beat.characterId!) ?? '',
      target: beat.text,
      transcript: this.transcript,
      accuracy: this.score?.accuracy ?? 0,
      passed: this.score?.passed ?? false,
      projection: this.levelCount ? this.levelSum / this.levelCount : 0,
    }
  }

  private finish(): void {
    this.clearTimers()
    this.deps.speaker.stop()
    void this.deps.recognizer.stop()
    this.phase = 'done'
    this.running = false
    this.emit()
  }

  // -- snapshot -------------------------------------------------------------

  private emit(): void {
    const beat = this.curBeat()
    const isMyLine = this.isMyLine()
    const total = this.order.length
    const pos = clamp(this.pos, 0, total)
    const snapshot: RehearsalState = {
      phase: this.phase,
      beatIndex: pos,
      totalBeats: total,
      beat,
      isMyLine,
      partnerSpeaking: this.partnerSpeaking,
      transcript: this.transcript,
      score: this.score,
      revealed: this.revealed,
      listening: (this.phase === 'listening' || this.phase === 'stuck') && isMyLine,
      progressPct: total ? Math.round((pos / total) * 100) : 0,
      attempts: this.attempts,
      error: this.error,
    }
    this.deps.onUpdate(snapshot)
  }
}
