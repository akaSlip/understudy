// ---------------------------------------------------------------------------
// Fountain / play-text importer + exporter
// ---------------------------------------------------------------------------
// Fountain (https://fountain.io) is the plain-text screenplay standard. Real
// users, though, paste plays in many shapes — most commonly "NAME: line" — so
// this importer accepts both proper Fountain and that looser play format and
// normalises everything into our Beat/Character model.

import type { Beat, Character } from '../types'
import { applySegments, beatSegments } from './directions'
import { characterKey, uid } from './util'

export interface ParsedScript {
  title?: string
  author?: string
  characters: Character[]
  beats: Beat[]
}

const SCENE_RE = /^(int|ext|est|int\.?\/ext|i\/e)[\s.]/i
// "NAME: dialogue" on one line — colon only (dashes/periods cause false hits).
const INLINE_NAME_RE = /^([\p{Lu}][\p{L}\p{N} .'’\-]{0,40}?)\s*:\s+(\S.*)$/u
const PAREN_RE = /^\((.*)\)$/

// Lead words that look like "NAME:" but are really labels/directions, not cues.
const NON_CHARACTER = new Set([
  'SETTING', 'SCENE', 'ACT', 'TIME', 'PLACE', 'NOTE', 'NOTES', 'PROLOGUE',
  'EPILOGUE', 'CAST', 'CHARACTERS', 'SYNOPSIS', 'AUTHOR', 'TITLE', 'ENTER',
  'EXIT', 'EXEUNT', 'CURTAIN', 'END', 'AT RISE', 'PRODUCTION', 'RUNTIME',
])

// Known title-page fields; anything else with a colon is body, not a header.
const TITLE_KEYS = new Set([
  'title', 'credit', 'author', 'authors', 'writer', 'source', 'draft date',
  'date', 'contact', 'copyright', 'revision', 'notes',
])

/** True if any token of the candidate name is a stage word or a bare number,
 *  which rules out multi-word labels like "SCENE 1" or "ENTER HAMLET". */
function hasNonCharToken(name: string): boolean {
  return name.split(/\s+/).some((w) => NON_CHARACTER.has(w.toUpperCase()) || /^\d+$/.test(w))
}

function isBlank(l: string): boolean {
  return l.trim().length === 0
}

/** A standalone character-cue line in proper Fountain: mostly upper-case,
 *  no lower-case words, not a scene heading. */
function looksLikeCue(line: string): boolean {
  const t = line.trim()
  if (!t || t.length > 45) return false
  if (SCENE_RE.test(t)) return false
  const core = t.replace(/\(.*?\)/g, '').replace(/[.:^]/g, '').trim()
  if (!core) return false
  if (hasNonCharToken(core)) return false
  return /\p{Lu}/u.test(core) && !/\p{Ll}/u.test(core)
}

function matchInlineName(line: string): { name: string; text: string } | null {
  const m = line.match(INLINE_NAME_RE)
  if (!m) return null
  const name = m[1].trim()
  const bare = name.replace(/\(.*?\)/g, '').trim()
  if (hasNonCharToken(bare)) return null
  const words = bare.split(/\s+/)
  if (words.length > 4) return null
  const isUpper = !/\p{Ll}/u.test(bare)
  const isTitle = words.every((w) => /^[\p{Lu}]/u.test(w)) && bare.length <= 24
  if (!isUpper && !isTitle) return null
  return { name, text: m[2].trim() }
}

export function parseScript(raw: string): ParsedScript {
  // Strip Fountain boneyard /* */ and normalise line endings.
  const text = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\r\n?/g, '\n')
  const lines = text.split('\n')

  let title: string | undefined
  let author: string | undefined
  const beats: Beat[] = []
  const charByKey = new Map<string, Character>()
  let pendingCharId: string | undefined // character whose dialogue we're inside
  let pendingParenthetical: string | undefined
  // The dialogue beat currently open for continuation. Consecutive dialogue
  // lines (a speech wrapped across lines, with no blank line between) merge into
  // it, so a multi-line speech is ONE beat — not one beat per wrapped line.
  let openBeat: Beat | null = null

  const ensureCharacter = (name: string): Character => {
    const key = characterKey(name)
    let c = charByKey.get(key)
    if (!c) {
      c = { id: uid('c_'), name: cleanName(name) }
      charByKey.set(key, c)
    }
    return c
  }
  const takeParenthetical = (): string | undefined => {
    const p = pendingParenthetical
    pendingParenthetical = undefined
    return p
  }

  // --- Title page: leading "Key: Value" block before the first blank line ---
  let i = 0
  if (looksLikeTitlePage(lines)) {
    let lastKey = ''
    for (; i < lines.length; i++) {
      const l = lines[i]
      if (isBlank(l)) {
        i++
        break
      }
      const m = l.match(/^([A-Za-z][A-Za-z ]*?):\s*(.*)$/)
      if (m && TITLE_KEYS.has(m[1].toLowerCase().trim())) {
        lastKey = m[1].toLowerCase().trim()
        const val = m[2].trim()
        if (lastKey === 'title') title = val || title
        else if (lastKey === 'author' || lastKey === 'authors' || lastKey === 'writer')
          author = val || author
      } else if (m) {
        // A "Name:" line that isn't a title field (e.g. "HAMLET: ...") — the
        // body starts here. Don't consume it.
        break
      } else if (lastKey === 'title' && !title) {
        title = l.trim()
      } else {
        // Non key:value line and not a title continuation — body starts here.
        break
      }
    }
  }

  // --- Body ---
  for (; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()

    if (isBlank(line)) {
      pendingCharId = undefined
      pendingParenthetical = undefined
      openBeat = null // blank line ends the speech
      continue
    }

    // Forced elements.
    if (trimmed.startsWith('!')) {
      beats.push(action(trimmed.slice(1).trim()))
      pendingCharId = undefined
      openBeat = null
      continue
    }
    if (trimmed.startsWith('.') && !trimmed.startsWith('..')) {
      beats.push({ id: uid('b_'), kind: 'heading', text: trimmed.slice(1).trim() })
      pendingCharId = undefined
      openBeat = null
      continue
    }
    if (trimmed.startsWith('>') || /\bTO:$/.test(trimmed)) {
      beats.push(action(trimmed.replace(/^>/, '').replace(/<$/, '').trim()))
      pendingCharId = undefined
      openBeat = null
      continue
    }
    if (trimmed.startsWith('#') || trimmed.startsWith('=')) {
      openBeat = null
      continue // section / synopsis — not rehearsed
    }
    if (trimmed.startsWith('@')) {
      pendingCharId = ensureCharacter(trimmed.slice(1).trim()).id
      openBeat = null
      continue
    }

    // Scene heading.
    if (SCENE_RE.test(trimmed)) {
      beats.push({ id: uid('b_'), kind: 'heading', text: trimmed })
      pendingCharId = undefined
      openBeat = null
      continue
    }

    // Parenthetical while inside a dialogue block → stash for the next line,
    // which starts a fresh beat (a parenthetical breaks the run).
    if (pendingCharId && PAREN_RE.test(trimmed)) {
      pendingParenthetical = trimmed.replace(PAREN_RE, '$1').trim()
      openBeat = null
      continue
    }

    // "NAME: dialogue on the same line" — the common pasted-play shape.
    const inline = matchInlineName(line)
    if (inline) {
      const c = ensureCharacter(inline.name)
      openBeat = dialogue(c.id, inline.text, takeParenthetical())
      beats.push(openBeat)
      pendingCharId = c.id
      continue
    }

    // Proper Fountain cue: an all-caps line followed by dialogue.
    if (!pendingCharId && looksLikeCue(line) && hasFollowingDialogue(lines, i)) {
      const nameOnly = trimmed.replace(/\^$/, '').replace(/:$/, '').trim()
      pendingCharId = ensureCharacter(nameOnly).id
      openBeat = null
      continue
    }

    // Inside a dialogue block → this line is dialogue for pendingCharId. Merge
    // it into the open speech unless a parenthetical just started a new one.
    if (pendingCharId) {
      if (openBeat && openBeat.characterId === pendingCharId && !pendingParenthetical) {
        openBeat.text += ' ' + trimmed
      } else {
        openBeat = dialogue(pendingCharId, trimmed, takeParenthetical())
        beats.push(openBeat)
      }
      continue
    }

    // Otherwise: action / stage direction.
    beats.push(action(trimmed))
    openBeat = null
  }

  // Pull any inline delivery directions out of each dialogue line into segments.
  for (const b of beats) applySegments(b)

  return { title, author, characters: [...charByKey.values()], beats }
}

function hasFollowingDialogue(lines: string[], idx: number): boolean {
  const next = lines[idx + 1]
  return next != null && next.trim().length > 0
}

function looksLikeTitlePage(lines: string[]): boolean {
  const first = lines.find((l) => l.trim().length > 0)
  return !!first && /^(title|author|authors|credit|source|draft date|contact)\s*:/i.test(first.trim())
}

function cleanName(name: string): string {
  const base = name.replace(/\(.*?\)/g, '').replace(/[:.^]+$/g, '').trim()
  if (!/\p{Ll}/u.test(base) && /\p{Lu}/u.test(base)) {
    return base.toLowerCase().replace(/\b\p{L}/gu, (m) => m.toUpperCase())
  }
  return base
}

function dialogue(characterId: string, text: string, parenthetical?: string): Beat {
  return { id: uid('b_'), kind: 'dialogue', characterId, text, parenthetical }
}

/** Join consecutive dialogue beats by the same character (nothing else between,
 *  and no parenthetical on the later beat) into a single speech. Fixes plays
 *  imported from double-spaced sources, where each wrapped line — separated by a
 *  blank line — became its own beat and so cued mid-speech. Returns a new array;
 *  the count difference tells the caller how many beats were absorbed. */
export function mergeConsecutiveDialogue(beats: Beat[]): Beat[] {
  const out: Beat[] = []
  for (const b of beats) {
    const last = out[out.length - 1]
    if (
      b.kind === 'dialogue' &&
      last &&
      last.kind === 'dialogue' &&
      last.characterId === b.characterId &&
      !b.parenthetical
    ) {
      // Merge the spoken text, and the delivery segments alongside it so inline
      // directions survive a tidy of a double-spaced import.
      last.text = `${last.text} ${b.text}`.replace(/\s+/g, ' ').trim()
      if (last.segments || b.segments) {
        last.segments = [...beatSegments(last), ...beatSegments(b)]
        // beatSegments folded any whole-line parenthetical into the first
        // segment's direction — drop the original so it isn't shown twice.
        last.parenthetical = undefined
      }
    } else {
      out.push({ ...b })
    }
  }
  return out
}

function action(text: string): Beat {
  return { id: uid('b_'), kind: 'action', text }
}

/** Re-adopt an existing play's character and beat ids onto a freshly re-parsed
 *  script. parseScript mints new ids on every round-trip; without this, saving
 *  a play (even unedited) would orphan everything keyed by those ids — e.g. the
 *  remembered rehearsal section. Characters match by name; beats match by
 *  (kind, character, text), consumed first-come so repeated lines pair up in
 *  order. Edited beats simply keep their new ids. */
export function adoptExistingIds(
  characters: Character[],
  beats: Beat[],
  existing: { characters: Character[]; beats: Beat[] },
): { characters: Character[]; beats: Beat[] } {
  // Characters: reuse the existing id for the same (normalised) name.
  const existingCharByKey = new Map(existing.characters.map((c) => [characterKey(c.name), c]))
  const charIdRemap = new Map<string, string>()
  const outChars = characters.map((c) => {
    const prev = existingCharByKey.get(characterKey(c.name))
    if (!prev) return c
    charIdRemap.set(c.id, prev.id)
    return { ...c, id: prev.id }
  })

  // Beats: reuse ids for identical (kind | character | text) beats, in order.
  const beatKey = (kind: string, characterId: string | undefined, text: string) =>
    `${kind}|${characterId ?? ''}|${text.replace(/\s+/g, ' ').trim()}`
  const pool = new Map<string, string[]>()
  for (const b of existing.beats) {
    const k = beatKey(b.kind, b.characterId, b.text)
    const ids = pool.get(k) ?? []
    ids.push(b.id)
    pool.set(k, ids)
  }
  const outBeats = beats.map((b) => {
    const characterId = b.characterId ? (charIdRemap.get(b.characterId) ?? b.characterId) : undefined
    const ids = pool.get(beatKey(b.kind, characterId, b.text))
    const id = ids?.shift() ?? b.id
    return { ...b, id, characterId }
  })
  return { characters: outChars, beats: outBeats }
}

// ---------------------------------------------------------------------------
// Export back to Fountain for editing / portability.
// ---------------------------------------------------------------------------
export function toFountain(opts: {
  title?: string
  author?: string
  characters: Character[]
  beats: Beat[]
}): string {
  const nameById = new Map(opts.characters.map((c) => [c.id, c.name]))
  const out: string[] = []
  if (opts.title) out.push(`Title: ${opts.title}`)
  if (opts.author) out.push(`Author: ${opts.author}`)
  if (out.length) out.push('')

  for (const b of opts.beats) {
    if (b.kind === 'heading') {
      const up = b.text.toUpperCase()
      out.push('', up.startsWith('INT') || up.startsWith('EXT') ? b.text : `.${b.text}`)
    } else if (b.kind === 'action') {
      out.push('', b.text)
    } else {
      const name = (nameById.get(b.characterId!) ?? 'UNKNOWN').toUpperCase()
      out.push('', name)
      if (b.segments && b.segments.length) {
        // Re-emit inline directions so a round-trip preserves the emotion shifts.
        out.push(b.segments.map((s) => (s.direction ? `(${s.direction}) ${s.text}` : s.text)).join(' '))
      } else {
        if (b.parenthetical) out.push(`(${b.parenthetical})`)
        out.push(b.text)
      }
    }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n'
}
