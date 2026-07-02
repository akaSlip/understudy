// Rehearsal state machine. Walks a selected list of the play's beats (a whole
// play, one scene, or just the actor's lines with cue context — see lib/sections):
//   • partner dialogue  → TTS performs it, then advances
//   • stage/heading      → shown (optionally narrated), then advances
//   • the actor's line   → listen, score against the known line, reveal on
//                          "stuck", and "keep the flow going" past a fumble.
// The engine is UI-agnostic: it pushes immutable snapshots via onUpdate.

import type { Beat, LineScore, Play, VoiceAssignment } from '../types'
import type { Recognizer } from '../audio/recognizer'
import type { AppSettings } from '../store/settings'
import type { Speaker } from '../tts/speaker'
import { scoreLine } from '../lib/scorer'

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
  speakingCharId?: string
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
  private attempts: LineAttempt[] = []
  private error: string | undefined

  // Projection stats for the current line.
  private levelSum = 0
  private levelCount = 0
  // Live override for auto-cue (auto-advance); falls back to the setting.
  private autoCueOverride: boolean | undefined

  private stuckTimer?: ReturnType<typeof setTimeout>
  private keepFlowTimer?: ReturnType<typeof setTimeout>
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
      this.error = e instanceof Error ? e.message : String(e)
      this.emit()
      return
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

  /** Toggle auto-cue mid-session. Turning it on while sitting on a passed line
   *  advances shortly after. */
  setAutoCue(on: boolean): void {
    this.autoCueOverride = on
    if (on && this.phase === 'scored') {
      this.clearTimers()
      this.advanceTimer = setTimeout(() => this.goToPos(this.pos + 1), 400)
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
        this.speak(beat.text, this.deps.narratorVoice, () => {}).then(
          () => this.afterStage(),
          () => {},
        )
      } else {
        this.advanceTimer = setTimeout(() => this.afterStage(), 1100)
      }
      return
    }

    if (beat.characterId === this.deps.myCharacterId) {
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
    this.speak(beat.text, voice, () => this.emit()).then(
      () => {
        if (this.running && this.phase === 'partner') this.goToPos(this.pos + 1)
      },
      () => {
        /* aborted by a transition — ignore */
      },
    )
  }

  private afterStage(): void {
    if (this.running && this.phase === 'stage') this.goToPos(this.pos + 1)
  }

  private speak(text: string, voice: VoiceAssignment, onStart: () => void): Promise<void> {
    return this.deps.speaker.speak(text, voice, onStart)
  }

  /** Fire-and-forget pre-generation of the next `count` scene-partner lines
   *  (blob voices only; the Speaker no-ops for the live Web Speech voice and
   *  de-dupes against the eventual playback). */
  private prefetchAhead(count: number): void {
    let found = 0
    for (let p = this.pos + 1; p < this.order.length && found < count; p++) {
      const b = this.beats[this.order[p]]
      if (b?.kind === 'dialogue' && b.characterId && b.characterId !== this.deps.myCharacterId) {
        const voice = this.deps.voiceMap.get(b.characterId) ?? this.deps.narratorVoice
        void this.deps.speaker.pregenerate(b.text, voice).catch(() => {})
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
      passThreshold: this.deps.settings.passThreshold,
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
    this.recordAttemptIfMyLine()
    this.emit()
    if (this.autoCue()) {
      this.advanceTimer = setTimeout(() => this.goToPos(this.pos + 1), 750)
    }
  }

  // -- timers ---------------------------------------------------------------

  private armTimers(): void {
    this.armStuckTimer()
    if (this.keepFlowTimer) clearTimeout(this.keepFlowTimer)
    if (this.deps.settings.keepFlowTimeoutMs > 0) {
      this.keepFlowTimer = setTimeout(() => this.onKeepFlow(), this.deps.settings.keepFlowTimeoutMs)
    }
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

  private onKeepFlow(): void {
    // A long silence on the actor's own line is usually them gathering the
    // words, or an intentional dramatic pause. Never auto-skip it — that both
    // pressures a natural pause and would silently drop the line from the
    // results count. Reveal the line as a prompt and wait; they finish it, or
    // press "Next" to move on at their own pace.
    this.revealed = true
    if (this.phase === 'listening') this.phase = 'stuck'
    this.emit()
  }

  private clearTimers(): void {
    for (const t of [this.stuckTimer, this.keepFlowTimer, this.advanceTimer]) if (t) clearTimeout(t)
    this.stuckTimer = this.keepFlowTimer = this.advanceTimer = undefined
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
    const last = this.attempts[this.attempts.length - 1]
    if (last && last.beatId === beat.id) {
      // Keep the best attempt for a line — never downgrade a pass on retry.
      if (next.accuracy >= last.accuracy || (!last.passed && next.passed)) {
        this.attempts[this.attempts.length - 1] = next
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
      speakingCharId: this.speakingCharId,
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
