import { useEffect, useMemo, useRef, useState } from 'react'
import type { Route } from '../App'
import type { Character, Play, VoiceAssignment } from '../types'
import { adoptExistingIds, mergeConsecutiveDialogue, parseScript, toFountain } from '../lib/fountain'
import { extractText, needsExtraction } from '../lib/ingest'
import { characterKey, uid } from '../lib/util'
import { getPlay, savePlay } from '../store/playsRepo'
import { listVoicesForEngine } from '../tts/voices'
import type { TTSVoice } from '../tts/webspeech'
import { useApp } from './useApp'

interface Override {
  voiceId?: string
  direction?: string
  notes?: string
}

const PLACEHOLDER = `Paste or type your play here. Two accepted formats:

ROMEO: But soft, what light through yonder window breaks?

JULIET: O Romeo, Romeo, wherefore art thou Romeo?

…or standard Fountain (character name in CAPS on its own line):

ROMEO
(quietly, in awe)
It is the east, and Juliet is the sun.

Two kinds of cue, anywhere in a line:
  (parentheses) = performance cues — shown to the actor, never spoken or scored
  {braces}      = vocal cues — shape HOW the voice says the words that follow

LEAR: {bewildered} Who is it can tell me who I am? (rises) {angrily} Does any here know me? {defeated} I am a very foolish fond old man.

Or use “Load file” to import a .fountain/.txt/PDF script — or even a photo or scan of a page (it’s read with OCR).`

/** Starter vocal cues for the palette — click or drag into the script. Any
 *  word or phrase works in {braces}; these are just common ones. */
const VOCAL_SAMPLES = [
  'whispering',
  'shouting',
  'angry',
  'tearful',
  'joyful',
  'terrified',
  'sarcastic',
  'gentle',
  'excited',
  'weary',
  'urgent',
  'slowly',
]

export function Editor({ playId, go }: { playId?: string; go: (r: Route) => void }) {
  const { settings, reloadPlays } = useApp()
  const [title, setTitle] = useState('')
  const [author, setAuthor] = useState('')
  const [scriptText, setScriptText] = useState('')
  const [overrides, setOverrides] = useState<Record<string, Override>>({})
  const [existing, setExisting] = useState<Play | null>(null)
  const [voiceOptions, setVoiceOptions] = useState<TTSVoice[]>([])
  const [saved, setSaved] = useState(false)
  const [importing, setImporting] = useState<string | null>(null)
  const [importError, setImportError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const scriptRef = useRef<HTMLTextAreaElement>(null)

  /** Insert a cue at the caret (used by the palette chips; drag-drop is native). */
  function insertCue(snippet: string) {
    const ta = scriptRef.current
    if (!ta) return
    const at = ta.selectionStart ?? scriptText.length
    const end = ta.selectionEnd ?? at
    setScriptText(scriptText.slice(0, at) + snippet + scriptText.slice(end))
    requestAnimationFrame(() => {
      ta.focus()
      ta.setSelectionRange(at + snippet.length, at + snippet.length)
    })
  }

  useEffect(() => {
    ;(async () => {
      if (!playId) return
      const p = await getPlay(playId)
      if (!p) return
      setExisting(p)
      setTitle(p.title)
      setAuthor(p.author ?? '')
      setScriptText(toFountain({ characters: p.characters, beats: p.beats }))
      const ov: Record<string, Override> = {}
      for (const c of p.characters) {
        ov[characterKey(c.name)] = { voiceId: c.voice?.voiceId, direction: c.voice?.direction, notes: c.notes }
      }
      setOverrides(ov)
    })()
  }, [playId])

  useEffect(() => {
    ;(async () => {
      setVoiceOptions(await listVoicesForEngine(settings.tts))
    })()
  }, [settings.tts])

  const parsed = useMemo(() => parseScript(scriptText), [scriptText])

  function setOverride(key: string, patch: Partial<Override>) {
    setOverrides((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }))
  }

  async function save(thenRehearse: boolean) {
    const now = Date.now()
    // parseScript mints fresh ids on every round-trip; re-adopt the existing
    // play's character/beat ids where they still correspond, so remembered
    // sections and anything else keyed by id survive an edit.
    const { characters: stableChars, beats: stableBeats } = existing
      ? adoptExistingIds(parsed.characters, parsed.beats, existing)
      : { characters: parsed.characters, beats: parsed.beats }
    const characters: Character[] = stableChars.map((c) => {
      const key = characterKey(c.name)
      const ov = overrides[key]
      const voice: VoiceAssignment | undefined =
        ov && (ov.voiceId || ov.direction)
          ? { engine: settings.tts, voiceId: ov.voiceId || undefined, direction: ov.direction || undefined }
          : undefined
      return { ...c, voice, notes: ov?.notes }
    })
    const play: Play = {
      id: existing?.id ?? uid('p_'),
      title: title.trim() || parsed.title || 'Untitled play',
      author: author.trim() || undefined,
      characters,
      beats: stableBeats,
      // A play the user has saved is theirs — never leave it tagged 'seed', or
      // the next sample refresh would silently delete their edits.
      source: existing && existing.source !== 'seed' ? existing.source : 'manual',
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    await savePlay(play)
    await reloadPlays()
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
    if (thenRehearse) go({ view: 'rehearse', playId: play.id })
  }

  async function loadFile(file: File) {
    setImportError(null)
    try {
      setImporting(needsExtraction(file) ? 'Opening file…' : null)
      const text = await extractText(file, (p) => setImporting(p.message))
      const p = parseScript(text)
      setTitle(p.title || file.name.replace(/\.[^.]+$/, ''))
      if (p.author) setAuthor(p.author)
      setScriptText(toFountain({ characters: p.characters, beats: p.beats }))
    } catch (e) {
      setImportError(
        `Couldn't read “${file.name}”. ${e instanceof Error ? e.message : ''} If it's a scanned PDF or photo, OCR needs a connection the first time.`,
      )
    } finally {
      setImporting(null)
    }
  }

  const dialogueCount = parsed.beats.filter((b) => b.kind === 'dialogue').length
  // How many beats a "Tidy speeches" pass would absorb (0 = nothing to fix).
  const mergeableCount = useMemo(() => parsed.beats.length - mergeConsecutiveDialogue(parsed.beats).length, [parsed.beats])
  function tidySpeeches() {
    const beats = mergeConsecutiveDialogue(parsed.beats)
    setScriptText(toFountain({ characters: parsed.characters, beats }))
  }

  return (
    <section className="editor">
      <div className="section-head">
        <h1>{existing ? 'Edit play' : 'New play'}</h1>
        <div className="actions">
          <button onClick={() => go({ view: 'library' })}>Back</button>
          <button onClick={() => fileRef.current?.click()} disabled={!!importing}>
            {importing ? 'Reading…' : 'Load file'}
          </button>
          <button
            onClick={tidySpeeches}
            disabled={mergeableCount === 0}
            title={
              mergeableCount === 0
                ? 'Nothing to tidy — each character’s speeches are already whole.'
                : 'Join consecutive lines by the same character into one speech — fixes plays where a speech was split across lines.'
            }
          >
            {mergeableCount > 0 ? `Tidy speeches (${mergeableCount})` : 'Tidy speeches'}
          </button>
          <button onClick={() => void save(false)} disabled={parsed.characters.length === 0}>
            {saved ? 'Saved ✓' : 'Save'}
          </button>
          <button className="primary" onClick={() => void save(true)} disabled={parsed.characters.length === 0}>
            Save & rehearse
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".fountain,.txt,.md,text/plain,.pdf,application/pdf,image/*"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) void loadFile(f)
              e.target.value = ''
            }}
          />
        </div>
      </div>

      {importing && (
        <p className="import-status" role="status">
          <span className="spinner" aria-hidden="true" /> {importing}
        </p>
      )}
      {importError && (
        <p className="import-error" role="alert">
          {importError}
        </p>
      )}

      <div className="editor-grid">
        <div className="editor-main">
          <div className="field-row">
            <label className="field">
              <span>Title</span>
              <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Untitled play" />
            </label>
            <label className="field">
              <span>Author</span>
              <input value={author} onChange={(e) => setAuthor(e.target.value)} placeholder="Optional" />
            </label>
          </div>
          <div className="cue-palette">
            <span className="muted small">
              Vocal cues — click or drag one into the script, or type your own <code>{'{anything}'}</code>:
            </span>
            <div className="cue-chips">
              {VOCAL_SAMPLES.map((c) => (
                <button
                  key={c}
                  type="button"
                  className="cue-chip"
                  draggable
                  title={`Insert {${c}} — the voice ${c === 'slowly' ? 'delivers the next words slowly' : `sounds ${c}`}`}
                  onDragStart={(e) => e.dataTransfer.setData('text/plain', `{${c}} `)}
                  onClick={() => insertCue(`{${c}} `)}
                >
                  {`{${c}}`}
                </button>
              ))}
            </div>
          </div>
          <label className="field">
            <span>Script</span>
            <textarea
              ref={scriptRef}
              className="script-area"
              value={scriptText}
              onChange={(e) => setScriptText(e.target.value)}
              placeholder={PLACEHOLDER}
              spellCheck={false}
            />
          </label>
          <p className="muted small cue-legend">
            <em className="seg-cue">(parentheses)</em> are performance cues — shown to the actor, never spoken or scored ·{' '}
            <em className="seg-direction">{'{braces}'}</em> are vocal cues — they shape how the voice delivers the words
            after them.
          </p>
          <p className="muted">
            {parsed.characters.length} characters · {dialogueCount} lines detected
          </p>
        </div>

        <aside className="cast-panel">
          <h3>Cast &amp; voices</h3>
          <p className="muted small">
            Voices use the engine selected in Settings (<strong>{settings.tts}</strong>). Leave “Auto” to cast distinct,
            gender-matched voices automatically. Delivery notes guide the expressive cloud voices.
          </p>
          {parsed.characters.length === 0 && <p className="muted">Characters appear here as you type.</p>}
          {parsed.characters.map((c) => {
            const key = characterKey(c.name)
            const ov = overrides[key] ?? {}
            return (
              <div key={c.id} className="cast-row">
                <div className="cast-name">{c.name}</div>
                <select
                  value={ov.voiceId ?? ''}
                  aria-label={`Voice for ${c.name}`}
                  onChange={(e) => setOverride(key, { voiceId: e.target.value })}
                >
                  <option value="">Auto</option>
                  {voiceOptions.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.label}
                    </option>
                  ))}
                </select>
                <input
                  className="direction"
                  value={ov.direction ?? ''}
                  placeholder="delivery note (e.g. bitter, urgent)"
                  aria-label={`Delivery note for ${c.name}`}
                  onChange={(e) => setOverride(key, { direction: e.target.value })}
                />
              </div>
            )
          })}
        </aside>
      </div>
    </section>
  )
}
