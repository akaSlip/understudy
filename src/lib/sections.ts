// Resolving "which beats to rehearse" from a high-level spec into a concrete,
// ordered list of beat indices the engine walks. Kept pure so it's unit-tested
// and reused by the UI (to preview/summarise a selection) and persistence.
//
// Modes:
//   whole  — the entire play
//   mine   — only the actor's lines, each padded with N cue lines before/after
//            ("cue-to-cue"), optionally restricted to one scene/act
//   scene  — one detected act/scene (heading → next heading)
//   custom — an explicit contiguous beat range

import type { Play } from '../types'

export type SectionSpec =
  | { mode: 'whole' }
  | { mode: 'mine'; before: number; after: number; scopeId?: string }
  | { mode: 'scene'; headingId: string }
  | { mode: 'custom'; startBeatId: string; endBeatId: string }

export const DEFAULT_SECTION: SectionSpec = { mode: 'whole' }

/** A structural unit of the play (an act or scene), delimited by heading beats. */
export interface SectionUnit {
  id: string // the heading beat's id
  label: string
  start: number // inclusive beat index
  end: number // inclusive beat index
}

const range = (a: number, b: number): number[] => {
  const out: number[] = []
  for (let i = a; i <= b; i++) out.push(i)
  return out
}

/** Acts/scenes derived from heading beats. Each runs from its heading to just
 *  before the next heading (or the end of the play). */
export function detectSections(play: Play): SectionUnit[] {
  const beats = play.beats
  const units: SectionUnit[] = []
  let cur: SectionUnit | null = null
  for (let i = 0; i < beats.length; i++) {
    const b = beats[i]
    if (b.kind === 'heading') {
      if (cur) {
        cur.end = i - 1
        units.push(cur)
      }
      cur = { id: b.id, label: b.text.replace(/\s+/g, ' ').trim() || 'Section', start: i, end: i }
    }
  }
  if (cur) {
    cur.end = beats.length - 1
    units.push(cur)
  }
  return units
}

/** Resolve a spec to a sorted, de-duplicated list of beat indices. Returns [] if
 *  the spec yields nothing (e.g. "my lines" for a character with none in scope);
 *  callers surface that. Falls back to the whole play if referenced ids vanished. */
export function resolveSection(play: Play, myCharacterId: string, spec: SectionSpec): number[] {
  const beats = play.beats
  const last = beats.length - 1
  if (last < 0) return []
  const whole = () => range(0, last)

  switch (spec.mode) {
    case 'whole':
      return whole()

    case 'scene': {
      const u = detectSections(play).find((s) => s.id === spec.headingId)
      return u ? range(u.start, u.end) : whole()
    }

    case 'custom': {
      const s = beats.findIndex((b) => b.id === spec.startBeatId)
      const e = beats.findIndex((b) => b.id === spec.endBeatId)
      if (s < 0 || e < 0) return whole()
      return range(Math.min(s, e), Math.max(s, e))
    }

    case 'mine': {
      let lo = 0
      let hi = last
      if (spec.scopeId) {
        const u = detectSections(play).find((s) => s.id === spec.scopeId)
        if (u) {
          lo = u.start
          hi = u.end
        }
      }
      const before = Math.max(0, spec.before | 0)
      const after = Math.max(0, spec.after | 0)
      const set = new Set<number>()
      for (let i = lo; i <= hi; i++) {
        const b = beats[i]
        if (b.kind === 'dialogue' && b.characterId === myCharacterId) {
          for (let j = i - before; j <= i + after; j++) if (j >= lo && j <= hi) set.add(j)
        }
      }
      return [...set].sort((a, b) => a - b)
    }
  }
}

export interface SectionSummary {
  beats: number
  myLines: number
  /** Number of contiguous runs (cue-to-cue clusters). */
  clusters: number
}

export function summarizeSection(play: Play, myCharacterId: string, order: number[]): SectionSummary {
  let myLines = 0
  let clusters = 0
  for (let k = 0; k < order.length; k++) {
    const b = play.beats[order[k]]
    if (b?.kind === 'dialogue' && b.characterId === myCharacterId) myLines++
    if (k === 0 || order[k] !== order[k - 1] + 1) clusters++
  }
  return { beats: order.length, myLines, clusters }
}
