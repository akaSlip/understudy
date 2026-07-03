import { type CSSProperties, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { Route } from '../App'
import type { Beat, Character, Play, TTSEngine, VoiceAssignment } from '../types'
import { createRecognizer } from '../audio/recognizerFactory'
import type { Recognizer } from '../audio/recognizer'
import { compatibilityReport, detectCapabilities, hasBlockingIssue, type CompatIssue } from '../lib/capabilities'
import { getPlay } from '../store/playsRepo'
import { getFlag, setFlag } from '../store/flags'
import { loadSection, saveSection } from '../store/rangeMemory'
import {
  DEFAULT_SECTION,
  detectSections,
  resolveSection,
  summarizeSection,
  type SectionSpec,
  type SectionSummary,
  type SectionUnit,
} from '../lib/sections'
import type { AppSettings } from '../store/settings'
import { Speaker } from '../tts/speaker'
import { warmupKokoro } from '../tts/kokoro'
import { buildVoiceMap, listVoicesForEngine } from '../tts/voices'
import { fetchElevenVoices, isPremiumEngine, type PremiumConfig } from '../tts/premium'
import type { TTSVoice } from '../tts/webspeech'
import { RehearsalEngine, type RehearsalState } from '../rehearsal/engine'
import { CompatBanner } from './CompatBanner'
import { useApp } from './useApp'
import { WordDiff } from './WordDiff'

export function Rehearsal({ playId, go }: { playId: string; go: (r: Route) => void }) {
  const { settings, updateSettings } = useApp()
  const [play, setPlay] = useState<Play | null>(null)
  const [myCharId, setMyCharId] = useState('')
  const [spec, setSpec] = useState<SectionSpec | null>(null)
  const [started, setStarted] = useState(false)
  const [starting, setStarting] = useState(false)
  const [loadMsg, setLoadMsg] = useState('')
  const [state, setState] = useState<RehearsalState | null>(null)
  const [showSoundCheck, setShowSoundCheck] = useState(false)
  const soundCheckDoneRef = useRef<boolean | null>(null)
  // Mic level updates ~15×/s while listening — kept OUT of React state so only
  // the MicMeter (which subscribes) re-renders per tick, not this whole tree.
  const levelStore = useRef(createLevelStore()).current
  const [voiceAssignments, setVoiceAssignments] = useState<Map<string, VoiceAssignment>>(new Map())

  const engineRef = useRef<RehearsalEngine | null>(null)
  const recognizerRef = useRef<Recognizer | null>(null)
  const startingRef = useRef(false)

  useEffect(() => {
    ;(async () => {
      const p = await getPlay(playId)
      if (!p) return
      setPlay(p)
      setMyCharId(defaultCharacter(p))
    })()
  }, [playId])

  // The remembered-section key: derived ONCE so the save and load paths can
  // never drift apart (a mismatch would silently stop sections round-tripping).
  const myName = useMemo(
    () => play?.characters.find((c) => c.id === myCharId)?.name ?? myCharId,
    [play, myCharId],
  )

  // Load the remembered section for this play + part (falls back to whole play).
  useEffect(() => {
    if (!play || !myCharId) return
    let cancelled = false
    ;(async () => {
      const saved = await loadSection(play.id, myName, myCharId)
      if (!cancelled) setSpec(saved ?? DEFAULT_SECTION)
    })()
    return () => {
      cancelled = true
    }
  }, [play, myCharId, myName])

  // Tear down on unmount.
  useEffect(() => {
    return () => {
      engineRef.current?.dispose()
      recognizerRef.current?.dispose()
    }
  }, [])

  const lineCounts = useMemo(() => countLines(play), [play])
  const sections = useMemo(() => (play ? detectSections(play) : []), [play])
  const effSpec = spec ?? DEFAULT_SECTION
  const order = useMemo(() => (play ? resolveSection(play, myCharId, effSpec) : []), [play, myCharId, effSpec])
  const summary = useMemo<SectionSummary>(
    () => (play ? summarizeSection(play, myCharId, order) : { beats: 0, myLines: 0, clusters: 0 }),
    [play, myCharId, order],
  )
  const compat = useMemo(() => compatibilityReport(detectCapabilities(), settings), [settings])
  const blocked = hasBlockingIssue(compat)

  function teardown() {
    engineRef.current?.dispose()
    recognizerRef.current?.dispose()
    engineRef.current = null
    recognizerRef.current = null
  }

  /** First-time users get a sound check before the first rehearsal; the same
   *  recognizer (and its loaded model) is then reused by begin(). */
  async function onStartPressed() {
    if (soundCheckDoneRef.current === null) soundCheckDoneRef.current = await getFlag('soundcheck')
    if (!soundCheckDoneRef.current) setShowSoundCheck(true)
    else void begin()
  }

  function finishSoundCheck(startNow: boolean) {
    soundCheckDoneRef.current = true
    void setFlag('soundcheck')
    setShowSoundCheck(false)
    if (startNow) void begin()
  }

  async function begin() {
    if (!play || started || startingRef.current) return
    startingRef.current = true
    setStarting(true)
    engineRef.current?.dispose() // clear any straggler from a prior attempt
    engineRef.current = null
    try {
      setLoadMsg('Preparing speech recognition…')
      // Reuse a recognizer the sound check already loaded/warmed, if present.
      let recognizer = recognizerRef.current
      if (!recognizer) {
        recognizer = createRecognizer(settings)
        recognizerRef.current = recognizer
      }
      // The recognizer model load (seconds) and the TTS voice prep are
      // independent — run them concurrently instead of back-to-back.
      const recognizerReady = recognizer.init((p) =>
        setLoadMsg(`Loading speech model… ${p.progress != null ? Math.round(p.progress * 100) + '%' : ''}`),
      )
      const premium: PremiumConfig | null = isPremiumEngine(settings.tts)
        ? { engine: settings.tts, ...(settings.premium[settings.tts] ?? {}) }
        : null
      const speaker = new Speaker({ rate: settings.ttsRate, premium })
      if (settings.tts === 'kokoro') void warmupKokoro().catch(() => {}) // pre-load so line 1 doesn't stall
      const voiceMapReady = (async () => {
        // ElevenLabs: refresh the account's usable voices BEFORE casting, so the
        // auto-cast pool can't contain voices the plan is not allowed to speak.
        if (settings.tts === 'elevenlabs' && premium) await fetchElevenVoices(premium).catch(() => {})
        return buildVoiceMap(play.characters, settings.tts, settings.ttsRate, myCharId)
      })()
      await recognizerReady
      const voiceMap = await voiceMapReady
      setVoiceAssignments(new Map(voiceMap))
      const narratorVoice = { engine: settings.tts, rate: settings.ttsRate }
      // Persist this section for one-click repeat rehearsal of the same scene.
      void saveSection(play.id, myName, effSpec)
      const engine = new RehearsalEngine({
        play,
        myCharacterId: myCharId,
        speaker,
        recognizer,
        voiceMap,
        narratorVoice,
        settings,
        onUpdate: (s) => {
          setState(s)
          if (!s.listening) levelStore.reset() // let the meter settle between lines
        },
        onLevel: (l) => levelStore.set(l),
        beatOrder: order,
      })
      engineRef.current = engine
      setLoadMsg('Requesting microphone…')
      await engine.start() // throws on recognizer failure → error flow below
      setStarted(true)
    } catch (e) {
      teardown()
      setStarted(false)
      const msg = e instanceof Error ? e.message : String(e)
      alert(
        `Couldn’t start rehearsal.\n\n${msg}\n\nIf the on-device speech model failed to load, try switching the speech recognition or Whisper model in Settings, or use a Chromium-based browser.`,
      )
    } finally {
      startingRef.current = false
      setStarting(false)
      setLoadMsg('')
    }
  }

  function restart() {
    teardown()
    startingRef.current = false
    setState(null)
    setStarted(false)
  }

  if (!play) return <div className="app-loading"><p>Loading…</p></div>

  if (starting) {
    return (
      <div className="loading-overlay">
        <div className="spinner" />
        <p>{loadMsg || 'Starting…'}</p>
        <p className="muted small">First run downloads the on-device model, then it's cached for offline use.</p>
      </div>
    )
  }

  if (showSoundCheck) {
    return (
      <SoundCheckView
        levelStore={levelStore}
        tts={settings.tts}
        ensureRecognizer={() => {
          if (!recognizerRef.current) recognizerRef.current = createRecognizer(settings)
          return recognizerRef.current
        }}
        onDone={finishSoundCheck}
      />
    )
  }

  if (!started) {
    return (
      <SetupView
        play={play}
        myCharId={myCharId}
        setMyCharId={setMyCharId}
        lineCounts={lineCounts}
        sections={sections}
        spec={effSpec}
        setSpec={setSpec}
        summary={summary}
        onStart={() => void onStartPressed()}
        onSoundCheck={() => setShowSoundCheck(true)}
        onBack={() => go({ view: 'library' })}
        recognizer={settings.recognizer}
        whisperModel={settings.whisperModel}
        tts={settings.tts}
        compat={compat}
        blocked={blocked}
      />
    )
  }

  if (state?.phase === 'done') {
    return (
      <SummaryView
        play={play}
        state={state}
        showProjection={settings.projectionCoaching}
        target={settings.projectionTarget}
        totalLines={summary.myLines}
        onAgain={restart}
        onBack={() => go({ view: 'library' })}
      />
    )
  }

  if (!state) return <div className="app-loading"><p>Starting…</p></div>

  return (
    <RunningView
      play={play}
      state={state}
      settings={settings}
      levelStore={levelStore}
      engine={engineRef.current!}
      myCharId={myCharId}
      onUpdateSettings={updateSettings}
      voiceAssignments={voiceAssignments}
      onChangeVoice={(charId, voiceId) => {
        engineRef.current?.setVoice(charId, voiceId)
        setVoiceAssignments((prev) => {
          const next = new Map(prev)
          const base = next.get(charId)
          next.set(charId, { engine: settings.tts, rate: settings.ttsRate, ...base, voiceId })
          return next
        })
      }}
      onStop={() => engineRef.current?.endSession()}
      onExit={() => go({ view: 'library' })}
    />
  )
}

// ---------------------------------------------------------------------------

function SetupView(props: {
  play: Play
  myCharId: string
  setMyCharId: (id: string) => void
  lineCounts: Map<string, number>
  sections: SectionUnit[]
  spec: SectionSpec
  setSpec: (s: SectionSpec) => void
  summary: SectionSummary
  onStart: () => void
  onSoundCheck: () => void
  onBack: () => void
  recognizer: string
  whisperModel: string
  tts: string
  compat: CompatIssue[]
  blocked: boolean
}) {
  const { play, myCharId, setMyCharId, lineCounts, sections, spec, setSpec, summary } = props
  const totalMyLines = lineCounts.get(myCharId) ?? 0
  const canStart = totalMyLines > 0 && summary.myLines > 0 && !props.blocked

  const startLabel =
    totalMyLines === 0
      ? 'This character has no lines'
      : props.blocked
        ? 'Not supported in this browser'
        : summary.myLines === 0
          ? 'No of your lines in this selection'
          : 'Start rehearsal'

  return (
    <section className="setup">
      <div className="section-head">
        <h1>{play.title}</h1>
        <button onClick={props.onBack}>Back</button>
      </div>
      <CompatBanner issues={props.compat} />
      <p className="muted">Which part are you playing? Understudy will perform everyone else and score your lines.</p>
      <ul className="char-picker">
        {play.characters.map((c) => (
          <li key={c.id}>
            <label className={myCharId === c.id ? 'selected' : ''}>
              <input type="radio" name="mychar" checked={myCharId === c.id} onChange={() => setMyCharId(c.id)} />
              <span className="char-name">{c.name}</span>
              <span className="muted small">{lineCounts.get(c.id) ?? 0} lines</span>
            </label>
          </li>
        ))}
      </ul>

      <SectionBuilder play={play} sections={sections} spec={spec} setSpec={setSpec} summary={summary} />

      <div className="setup-foot">
        <p className="muted small">
          Speech recognition: <strong>{props.recognizer === 'whisper' ? `Whisper (${props.whisperModel}, on-device)` : 'Web Speech'}</strong>
          {' · '}Voices: <strong>{props.tts}</strong>. Change these in Settings.
        </p>
        <div className="start-row">
          <button className="ghost" onClick={props.onSoundCheck} title="Test your microphone and voice detection">
            🎙 Sound check
          </button>
          <button className="primary big" onClick={props.onStart} disabled={!canStart}>
            {startLabel}
          </button>
        </div>
      </div>
    </section>
  )
}

/** Pre-rehearsal sound check: exercises the REAL pipeline (mic → level meter →
 *  recogniser), which both reassures the user and pre-loads/warms the speech
 *  model so the first line of the rehearsal is fast. Shown automatically the
 *  first time ever; re-runnable from the setup screen. */
function SoundCheckView(props: {
  levelStore: LevelStore
  tts: TTSEngine
  ensureRecognizer: () => Recognizer
  onDone: (startNow: boolean) => void
}) {
  const { levelStore, ensureRecognizer, onDone } = props
  const [phase, setPhase] = useState<'loading' | 'listening' | 'error'>('loading')
  const [msg, setMsg] = useState('')
  const [heard, setHeard] = useState<string[]>([])

  useEffect(() => {
    let alive = true
    const rec = ensureRecognizer()
    ;(async () => {
      try {
        await rec.init((p) => {
          if (alive) setMsg(`Loading the speech model… ${p.progress != null ? Math.round(p.progress * 100) + '%' : ''}`)
        })
        if (!alive) return
        setMsg('')
        await rec.start({
          onFinal: (t) => {
            if (alive && t.trim()) setHeard((h) => [...h, t.trim()])
          },
          onLevel: (l) => levelStore.set(l),
          onError: (e) => {
            if (alive) setMsg(e.message)
          },
        })
        rec.setActive(true)
        if (alive) setPhase('listening')
      } catch (e) {
        if (alive) {
          setPhase('error')
          setMsg(e instanceof Error ? e.message : String(e))
        }
      }
    })()
    return () => {
      alive = false
      // Release the mic but KEEP the recogniser instance — its loaded, warmed
      // model is reused when the rehearsal starts.
      void rec.stop()
      levelStore.set(0)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <section className="soundcheck">
      <div className="section-head">
        <h1>Sound check</h1>
      </div>
      {phase === 'loading' && (
        <div className="loading-overlay inline">
          <div className="spinner" />
          <p>{msg || 'Preparing speech recognition…'}</p>
          <p className="muted small">First time only — the model is saved for offline use afterwards.</p>
        </div>
      )}
      {phase === 'error' && <div className="banner error">{msg}</div>}
      {phase === 'listening' && (
        <>
          <div className="sc-listen">
            <LevelMeter store={levelStore} className="sc-meter" />
            <p className="sc-prompt">Say a line — any line — and watch the meter move.</p>
          </div>
          {heard.length === 0 ? (
            <p className="muted">Listening…</p>
          ) : (
            <div className="sc-heard">
              <p className="ok">✓ Heard you loud and clear:</p>
              <p className="heard muted">“{heard[heard.length - 1]}”</p>
            </div>
          )}
        </>
      )}
      <div className="banner warn sc-note">
        <strong>Heads-up for your first run-through:</strong> the scene-partner voices are generated as each line is
        first reached{props.tts === 'kokoro' ? ' (and the voice model downloads once)' : ''}, so you may notice short
        pauses before some lines. Every generated line is saved — your second time through the same play is instant.
      </div>
      <div className="setup-foot">
        <div className="start-row">
          <button className="ghost" onClick={() => onDone(false)}>
            Back to setup
          </button>
          <button className="primary big" onClick={() => onDone(true)}>
            {heard.length > 0 ? 'Sounds good — start rehearsal' : 'Start rehearsal anyway'}
          </button>
        </div>
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------

type SectionMode = SectionSpec['mode']

function SectionBuilder(props: {
  play: Play
  sections: SectionUnit[]
  spec: SectionSpec
  setSpec: (s: SectionSpec) => void
  summary: SectionSummary
}) {
  const { play, sections, spec, setSpec, summary } = props
  const nameById = useMemo(() => new Map(play.characters.map((c) => [c.id, c.name])), [play])
  const last = Math.max(0, play.beats.length - 1)
  const hasScenes = sections.length > 0

  const modes: { mode: SectionMode; label: string; show: boolean }[] = [
    { mode: 'whole', label: 'Whole play', show: true },
    { mode: 'mine', label: 'My lines', show: true },
    { mode: 'scene', label: 'By scene', show: hasScenes },
    { mode: 'custom', label: 'Custom', show: true },
  ]

  function selectMode(mode: SectionMode) {
    if (mode === spec.mode) return
    if (mode === 'whole') setSpec({ mode: 'whole' })
    else if (mode === 'mine') setSpec({ mode: 'mine', before: 1, after: 1 })
    else if (mode === 'scene') setSpec({ mode: 'scene', headingId: sections[0]?.id ?? '' })
    else setSpec({ mode: 'custom', startBeatId: play.beats[0]?.id ?? '', endBeatId: play.beats[last]?.id ?? '' })
  }

  const beatOptions = play.beats.map((b, i) => (
    <option key={b.id} value={b.id}>
      {beatLabel(b, i, nameById)}
    </option>
  ))

  const presets: { label: string; spec: SectionSpec }[] = [
    { label: '▶ Whole play', spec: { mode: 'whole' } },
    { label: '★ Just my lines', spec: { mode: 'mine', before: 1, after: 1 } },
    ...sections.map((s) => ({ label: s.label, spec: { mode: 'scene', headingId: s.id } as SectionSpec })),
  ]
  const isActivePreset = (p: SectionSpec): boolean => {
    if (p.mode !== spec.mode) return false
    if (p.mode === 'scene' && spec.mode === 'scene') return p.headingId === spec.headingId
    if (p.mode === 'mine' && spec.mode === 'mine') return spec.before === 1 && spec.after === 1 && !spec.scopeId
    return p.mode === 'whole'
  }

  return (
    <div className="section-builder">
      <h3>Rehearse a section</h3>

      <div className="presets">
        <span className="muted small">Quick picks:</span>
        {presets.map((p, i) => (
          <button key={i} className={`chip-btn ${isActivePreset(p.spec) ? 'active' : ''}`} onClick={() => setSpec(p.spec)}>
            {p.label}
          </button>
        ))}
      </div>

      <details className="fine-tune">
        <summary className="muted small">Fine-tune…</summary>
      <div className="seg">
        {modes
          .filter((m) => m.show)
          .map((m) => (
            <button key={m.mode} className={spec.mode === m.mode ? 'active' : ''} onClick={() => selectMode(m.mode)}>
              {m.label}
            </button>
          ))}
      </div>

      {spec.mode === 'whole' && <p className="muted small">The entire play, start to finish.</p>}

      {spec.mode === 'mine' && (
        <div className="section-panel">
          <p className="muted small">Just your lines and their cues — everything else is skipped.</p>
          <div className="stepper-row">
            <Stepper label="Lines before" value={spec.before} onChange={(v) => setSpec({ ...spec, before: v })} />
            <Stepper label="Lines after" value={spec.after} onChange={(v) => setSpec({ ...spec, after: v })} />
          </div>
          {hasScenes && (
            <label className="field">
              <span>Within</span>
              <select
                value={spec.scopeId ?? ''}
                onChange={(e) => setSpec({ ...spec, scopeId: e.target.value || undefined })}
              >
                <option value="">Whole play</option>
                {sections.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      )}

      {spec.mode === 'scene' && (
        <label className="field">
          <span>Scene / act</span>
          <select value={spec.headingId} onChange={(e) => setSpec({ mode: 'scene', headingId: e.target.value })}>
            {sections.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
      )}

      {spec.mode === 'custom' && (
        <div className="range-selects">
          <label className="field">
            <span>From</span>
            <select
              value={spec.startBeatId}
              onChange={(e) => {
                const startBeatId = e.target.value
                const s = play.beats.findIndex((b) => b.id === startBeatId)
                const eIdx = play.beats.findIndex((b) => b.id === spec.endBeatId)
                const endBeatId = eIdx >= 0 && eIdx >= s ? spec.endBeatId : play.beats[Math.max(s, last)]?.id ?? startBeatId
                setSpec({ mode: 'custom', startBeatId, endBeatId })
              }}
            >
              {beatOptions}
            </select>
          </label>
          <label className="field">
            <span>To</span>
            <select
              value={spec.endBeatId}
              onChange={(e) => {
                const endBeatId = e.target.value
                const eIdx = play.beats.findIndex((b) => b.id === endBeatId)
                const sIdx = play.beats.findIndex((b) => b.id === spec.startBeatId)
                const startBeatId = sIdx >= 0 && sIdx <= eIdx ? spec.startBeatId : play.beats[Math.min(sIdx < 0 ? 0 : sIdx, eIdx)]?.id ?? endBeatId
                setSpec({ mode: 'custom', startBeatId, endBeatId })
              }}
            >
              {beatOptions}
            </select>
          </label>
        </div>
      )}

      </details>

      <p className="muted small section-summary">
        {summary.beats} steps · <strong>{summary.myLines}</strong> of your lines
        {summary.clusters > 1 ? ` · ${summary.clusters} sections` : ''} · saved for next time.
      </p>
    </div>
  )
}

function Stepper({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  const clampV = (v: number) => Math.max(0, Math.min(5, v))
  return (
    <div className="stepper">
      <span className="stepper-label">{label}</span>
      <div className="stepper-ctl">
        <button className="ghost" onClick={() => onChange(clampV(value - 1))} disabled={value <= 0} aria-label={`fewer ${label}`}>
          −
        </button>
        <span className="stepper-val">{value}</span>
        <button className="ghost" onClick={() => onChange(clampV(value + 1))} disabled={value >= 5} aria-label={`more ${label}`}>
          +
        </button>
      </div>
    </div>
  )
}

function beatLabel(b: Beat, i: number, nameById: Map<string, string>): string {
  const text = b.text.replace(/\s+/g, ' ').trim()
  const snippet = text.length > 42 ? text.slice(0, 40) + '…' : text
  if (b.kind === 'dialogue') {
    const who = b.characterId ? nameById.get(b.characterId) ?? '?' : '?'
    return `${i + 1}. ${who}: ${snippet}`
  }
  return `${i + 1}. ${b.kind === 'heading' ? '❖' : '¶'} ${snippet}`
}

// ---------------------------------------------------------------------------

function RunningView(props: {
  play: Play
  state: RehearsalState
  settings: AppSettings
  levelStore: LevelStore
  engine: RehearsalEngine
  myCharId: string
  voiceAssignments: Map<string, VoiceAssignment>
  onChangeVoice: (characterId: string, voiceId?: string) => void
  onUpdateSettings: (patch: Partial<AppSettings>) => void
  onStop: () => void
  onExit: () => void
}) {
  const { play, state, settings, engine, levelStore } = props
  const nameById = useMemo(() => new Map(play.characters.map((c) => [c.id, c.name])), [play])
  const [autoCue, setAutoCue] = useState(settings.autoAdvance)
  // One-of-three panel state — a single field can't have two panels open.
  const [panel, setPanel] = useState<'none' | 'voices' | 'tune'>('none')
  const [scoring, setScoring] = useState(true)
  const beat = state.beat
  const speaker = beat?.characterId ? nameById.get(beat.characterId) : undefined
  const paused = state.phase === 'paused'
  const direction = settings.showDirections ? directionFor(beat, play.characters) : undefined
  const showMine = settings.alwaysShowMyLines || state.revealed

  const accuracyPct = state.score ? Math.round(state.score.accuracy * 100) : undefined

  return (
    <section className="stage">
      <div className="stage-top">
        <div className="progress-track">
          <div className="progress-fill" style={{ width: `${state.progressPct}%` }} />
        </div>
        <button className="ghost" onClick={props.onExit}>
          Exit
        </button>
      </div>

      {state.error && <div className="banner error">{state.error}</div>}

      <div className={`beat-card ${state.isMyLine ? 'mine' : ''} ${state.phase}`}>
        {beat?.kind !== 'dialogue' ? (
          <>
            <div className="beat-role stage-dir">STAGE</div>
            <p className="beat-text stage-text">{beat?.text}</p>
          </>
        ) : state.isMyLine ? (
          <>
            <div className="beat-role you">
              YOU — {speaker}
              {state.listening && <span className="listening-tag">🎙 listening</span>}
            </div>
            {state.listening && (
              <LevelMeter
                className="in-card"
                store={levelStore}
                coaching={settings.projectionCoaching}
                target={settings.projectionTarget}
              />
            )}
            {direction && <div className="direction-note">{direction}</div>}
            {state.score ? (
              <WordDiff words={state.score.words} revealed={showMine} score={state.score} />
            ) : showMine ? (
              <LineText beat={beat} showDirections={settings.showDirections} />
            ) : (
              <p className="beat-text prompt-hidden">Your line — say it from memory.</p>
            )}
            {accuracyPct != null && (
              <div className={`accuracy ${state.score?.passed ? 'pass' : ''}`}>
                <span className="acc-num">{accuracyPct}%</span>
                <span className="acc-label">{state.score?.passed ? 'nailed it' : 'accuracy'}</span>
              </div>
            )}
            {state.transcript && <p className="heard muted small">heard: “{state.transcript}”</p>}
            {state.phase === 'listening' && state.transcript && !state.score?.passed && (
              <p className="hint small">Take your time — waiting for you to finish the line.</p>
            )}
            {state.phase === 'stuck' && !state.score?.passed && (
              <p className="hint small">The line is shown — read it, or press Next to move on.</p>
            )}
            {settings.projectionCoaching && state.listening && (
              <p className="hint small">🎙 Projection coaching on — push the level past the marker.</p>
            )}
          </>
        ) : (
          <>
            <div className="beat-role partner">
              {speaker}
              {state.phase === 'partner' &&
                (state.partnerSpeaking ? (
                  <span className="speaking-dot" title="speaking" />
                ) : (
                  <span className="prep-voice" role="status">
                    <span className="spinner" aria-hidden="true" /> preparing voice…
                  </span>
                ))}
            </div>
            {direction && <div className="direction-note">{direction}</div>}
            <LineText beat={beat} showDirections={settings.showDirections} />
          </>
        )}
      </div>

      <p className="muted small center beat-counter">
        Step {state.beatIndex + 1} of {state.totalBeats}
      </p>

      {/* Fixed toolbar: every control keeps its slot line-to-line (disabled when
          not applicable) so nothing shifts under the mouse; docks to the screen
          bottom, icon-only on small screens. */}
      <div className="controls">
        <div className="controls-inner">
          <button className="ctl" onClick={() => engine.prev()} title="Previous line">
            <span className="ctl-icon">⏮</span>
            <span className="ctl-label">Prev</span>
          </button>
          {paused ? (
            <button className="ctl primary" onClick={() => engine.resume()} title="Resume">
              <span className="ctl-icon">▶</span>
              <span className="ctl-label">Resume</span>
            </button>
          ) : (
            <button className="ctl" onClick={() => engine.pause()} title="Pause">
              <span className="ctl-icon">⏸</span>
              <span className="ctl-label">Pause</span>
            </button>
          )}
          <button
            className="ctl"
            onClick={() => engine.reveal()}
            disabled={!state.isMyLine || state.revealed || paused}
            title="Show the words of this line"
          >
            <span className="ctl-icon">👁</span>
            <span className="ctl-label">Show line</span>
          </button>
          <button
            className="ctl"
            onClick={() => engine.retryLine()}
            disabled={!state.isMyLine || paused}
            title="Say this line again from the start"
          >
            <span className="ctl-icon">↺</span>
            <span className="ctl-label">Try again</span>
          </button>
          <button className="ctl" onClick={() => engine.next()} title="Move on to the next line">
            <span className="ctl-icon">⏭</span>
            <span className="ctl-label">Next</span>
          </button>
          <button
            className={`ctl ${autoCue ? 'active' : ''}`}
            title="Automatically cue the next line when you finish yours"
            aria-pressed={autoCue}
            onClick={() => {
              const v = !autoCue
              setAutoCue(v)
              engine.setAutoCue(v)
            }}
          >
            <span className="ctl-icon">⏩</span>
            <span className="ctl-label">{autoCue ? 'Auto-cue' : 'Auto-cue off'}</span>
          </button>
          <button
            className={`ctl ${panel === 'voices' ? 'active' : ''}`}
            onClick={() => setPanel((p) => (p === 'voices' ? 'none' : 'voices'))}
            title="Change the scene-partner voices"
            aria-pressed={panel === 'voices'}
          >
            <span className="ctl-icon">🎭</span>
            <span className="ctl-label">Voices</span>
          </button>
          <button
            className={`ctl ${panel === 'tune' ? 'active' : ''}`}
            onClick={() => setPanel((p) => (p === 'tune' ? 'none' : 'tune'))}
            title="Scoring and projection controls"
            aria-pressed={panel === 'tune'}
          >
            <span className="ctl-icon">🎚</span>
            <span className="ctl-label">Tune</span>
          </button>
          <button className="ctl danger" onClick={props.onStop} title="Finish and see your results">
            <span className="ctl-icon">■</span>
            <span className="ctl-label">Finish</span>
          </button>
        </div>
      </div>

      {panel === 'tune' && (
        <div
          className="voice-panel tune-panel"
          role="dialog"
          aria-label="Scoring and projection"
          onKeyDown={(e) => {
            if (e.key === 'Escape') setPanel('none')
          }}
        >
          <div className="voice-panel-head">
            <strong>Scoring &amp; projection</strong>
            <button className="ghost" onClick={() => setPanel('none')} autoFocus>
              Done
            </button>
          </div>
          <label className="opt">
            <input
              type="checkbox"
              checked={scoring}
              onChange={(e) => {
                setScoring(e.target.checked)
                engine.setScoring(e.target.checked)
              }}
            />
            <span>
              <strong>Score my lines</strong> — untick to read along without the mic (advance with Next)
            </span>
          </label>
          <label className="range">
            <span>Accuracy needed to pass: {Math.round(settings.passThreshold * 100)}%</span>
            <input
              type="range"
              min={0.5}
              max={1}
              step={0.05}
              value={settings.passThreshold}
              onChange={(e) => {
                const v = Number(e.target.value)
                props.onUpdateSettings({ passThreshold: v })
                engine.setPassThreshold(v)
              }}
            />
          </label>
          <label className="opt">
            <input
              type="checkbox"
              checked={settings.projectionCoaching}
              onChange={(e) => props.onUpdateSettings({ projectionCoaching: e.target.checked })}
            />
            <span>
              <strong>Projection meter</strong> — show a loudness target on the listening meter
            </span>
          </label>
          {settings.projectionCoaching && (
            <label className="range">
              <span>Projection target: {Math.round(settings.projectionTarget * 100)}%</span>
              <input
                type="range"
                min={0.2}
                max={0.9}
                step={0.05}
                value={settings.projectionTarget}
                onChange={(e) => props.onUpdateSettings({ projectionTarget: Number(e.target.value) })}
              />
            </label>
          )}
        </div>
      )}

      {panel === 'voices' && (
        <VoicePanel
          play={play}
          myCharId={props.myCharId}
          engine={settings.tts}
          assignments={props.voiceAssignments}
          speakingCharId={state.phase === 'partner' ? beat?.characterId : undefined}
          onChange={props.onChangeVoice}
          onClose={() => setPanel('none')}
        />
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------

function SummaryView(props: {
  play: Play
  state: RehearsalState
  showProjection: boolean
  target: number
  totalLines: number
  onAgain: () => void
  onBack: () => void
}) {
  const { attempts } = props.state
  const { showProjection, target, totalLines } = props
  const attempted = attempts.length
  const avg = attempted ? Math.round((attempts.reduce((s, a) => s + a.accuracy, 0) / attempted) * 100) : 0
  const passed = attempts.filter((a) => a.passed).length
  // Denominator is the character's lines in the chosen section, not just those
  // reached — so ending early doesn't read as a perfect score.
  const denom = Math.max(totalLines, attempted)
  const endedEarly = attempted < denom
  const projAttempts = attempts.filter((a) => (a.projection ?? 0) > 0)
  const avgProj = projAttempts.length
    ? Math.round((projAttempts.reduce((s, a) => s + (a.projection ?? 0), 0) / projAttempts.length) * 100)
    : 0
  const targetPct = Math.round(target * 100)

  return (
    <section className="summary">
      <div className="section-head">
        <h1>Your results</h1>
        <div className="actions">
          <button className="primary" onClick={props.onAgain}>
            Rehearse again
          </button>
          <button onClick={props.onBack}>Back to plays</button>
        </div>
      </div>

      <div className="summary-stats">
        <Stat big label="Average accuracy" value={attempted ? `${avg}%` : '—'} />
        <Stat label="Lines correct" value={`${passed} / ${denom}`} />
        {showProjection && projAttempts.length > 0 && (
          <Stat label={`Average projection (aim ${targetPct}%)`} value={`${avgProj}%`} />
        )}
      </div>

      {endedEarly && attempted > 0 && (
        <p className="muted small">
          You rehearsed {attempted} of your {denom} lines in this section — ended early.
        </p>
      )}
      {attempted === 0 && (
        <p className="muted">
          No lines were scored this session{totalLines > 0 ? ` — this section has ${totalLines} of your lines to rehearse.` : '.'}
        </p>
      )}
      <ul className="attempt-list">
        {attempts.map((a, i) => {
          const proj = Math.round((a.projection ?? 0) * 100)
          return (
            <li key={i} className={a.passed ? 'pass' : 'fail'}>
              <div className="attempt-head">
                <span className="acc-num small">{Math.round(a.accuracy * 100)}%</span>
                <span className="target">{a.target}</span>
                {showProjection && (a.projection ?? 0) > 0 && (
                  <span className={`proj-chip ${proj >= targetPct ? 'ok' : 'low'}`} title="projection">
                    🔊 {proj}%
                  </span>
                )}
              </div>
              {!a.passed && a.transcript && <p className="heard muted small">heard: “{a.transcript}”</p>}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

/** Live listening indicator. Bars gently pulse whenever the mic is armed (so a
 *  pause still reads as "listening"), and swell with your actual voice level.
 *  With projection coaching on, a target marker appears and the bars turn green
 *  once you're projecting past it. */
/** Tiny external store for the live mic level (+ a decaying peak hold):
 *  updated ~15×/s by the VAD, read only by the LevelMeter via
 *  useSyncExternalStore — so the frequent ticks never re-render the rest of
 *  the rehearsal tree. */
interface LevelStore {
  get(): number
  getPeak(): number
  set(l: number): void
  reset(): void
  subscribe(fn: () => void): () => void
}
function createLevelStore(): LevelStore {
  let level = 0
  let peak = 0
  let lastAt = 0
  const listeners = new Set<() => void>()
  const notify = () => listeners.forEach((fn) => fn())
  return {
    get: () => level,
    getPeak: () => peak,
    set(l: number) {
      const now = Date.now()
      const prevPeak = peak
      if (lastAt) peak = Math.max(0, peak - (now - lastAt) * 0.0004) // ~0.4/s decay
      lastAt = now
      if (l > peak) peak = l
      if (l === level && Math.abs(peak - prevPeak) < 0.004) return
      level = l
      notify()
    },
    reset() {
      level = 0
      peak = 0
      lastAt = 0
      notify()
    },
    subscribe(fn: () => void) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
  }
}

/** Console-style vertical level meter: a green→amber→red column that fills to
 *  the live level, with a decaying peak-hold line and (when projection
 *  coaching) a target notch. Deliberately driven ONLY by inline style values —
 *  no CSS keyframes: `var()` inside @keyframes is snapshotted when an
 *  animation starts (why the old meter sat dead on the first line). */
function LevelMeter({
  store,
  coaching,
  target = 0.5,
  className = '',
}: {
  store: LevelStore
  coaching?: boolean
  target?: number
  className?: string
}) {
  const level = useSyncExternalStore(store.subscribe, store.get)
  const peak = useSyncExternalStore(store.subscribe, store.getPeak)
  const lvl = Math.max(0, Math.min(1, level))
  const pk = Math.max(lvl, Math.min(1, peak))
  const over = coaching ? lvl >= target : false
  return (
    <span
      className={`level-meter ${coaching ? 'coaching' : ''} ${over ? 'over' : ''} ${className}`}
      role="img"
      aria-label={coaching ? `projection ${Math.round(lvl * 100)}%` : 'microphone level'}
      title={coaching ? 'projection' : 'listening'}
      style={{ '--level': String(lvl), '--peak': String(pk), '--target': String(target) } as CSSProperties}
    >
      <span className="lm-scale" aria-hidden />
      <span className="lm-cover" aria-hidden />
      <span className="lm-segments" aria-hidden />
      <span className="lm-peak" aria-hidden />
      {coaching && <span className="lm-target" aria-hidden />}
    </span>
  )
}

function Stat({ label, value, big }: { label: string; value: string; big?: boolean }) {
  return (
    <div className={`stat ${big ? 'big' : ''}`}>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  )
}

// ---------------------------------------------------------------------------

function defaultCharacter(p: Play): string {
  const counts = countLines(p)
  let best = p.characters[0]?.id ?? ''
  let max = -1
  for (const c of p.characters) {
    const n = counts.get(c.id) ?? 0
    if (n > max) {
      max = n
      best = c.id
    }
  }
  return best
}

function countLines(p: Play | null): Map<string, number> {
  const m = new Map<string, number>()
  if (!p) return m
  for (const b of p.beats) {
    if (b.kind === 'dialogue' && b.characterId) m.set(b.characterId, (m.get(b.characterId) ?? 0) + 1)
  }
  return m
}

/** The delivery manner for a line: its per-line parenthetical, else the
 *  character's default delivery note from the editor. */
function directionFor(beat: Beat | undefined, characters: Character[]): string | undefined {
  if (!beat) return undefined
  if (beat.parenthetical) return beat.parenthetical
  const c = characters.find((ch) => ch.id === beat.characterId)
  return c?.voice?.direction
}

/** In-rehearsal voice casting: change any scene-partner's voice on the fly. A
 *  voice already given to another character is greyed out so no two partners
 *  share one — the actor's own character is not listed. */
function VoicePanel(props: {
  play: Play
  myCharId: string
  engine: TTSEngine
  assignments: Map<string, VoiceAssignment>
  speakingCharId?: string
  onChange: (characterId: string, voiceId?: string) => void
  onClose: () => void
}) {
  const { play, myCharId, engine, assignments, speakingCharId, onChange } = props
  const [options, setOptions] = useState<TTSVoice[]>([])

  useEffect(() => {
    let alive = true
    ;(async () => {
      const opts = await listVoicesForEngine(engine)
      if (alive) setOptions(opts)
    })()
    return () => {
      alive = false
    }
  }, [engine])

  const partners = play.characters.filter((c) => c.id !== myCharId)
  // voiceId → characterId, so we can grey out a voice taken by someone else.
  const takenBy = new Map<string, string>()
  for (const c of partners) {
    const vid = assignments.get(c.id)?.voiceId
    if (vid) takenBy.set(vid, c.id)
  }

  return (
    <div
      className="voice-panel"
      role="dialog"
      aria-label="Scene-partner voices"
      onKeyDown={(e) => {
        if (e.key === 'Escape') props.onClose()
      }}
    >
      <div className="voice-panel-head">
        <strong>Scene-partner voices</strong>
        <button className="ghost" onClick={props.onClose} autoFocus>
          Done
        </button>
      </div>
      {options.length === 0 ? (
        <p className="muted small">No selectable voices for this engine on this device.</p>
      ) : (
        <ul className="voice-list">
          {partners.map((c) => {
            const current = assignments.get(c.id)?.voiceId ?? ''
            return (
              <li key={c.id} className={speakingCharId === c.id ? 'speaking' : ''}>
                <span className="voice-char">
                  {c.name}
                  {speakingCharId === c.id && <span className="speaking-dot" title="speaking now" />}
                </span>
                <select
                  value={current}
                  aria-label={`Voice for ${c.name}`}
                  onChange={(e) => onChange(c.id, e.target.value || undefined)}
                >
                  {current === '' && (
                    <option value="" disabled>
                      Default voice
                    </option>
                  )}
                  {options.map((o) => {
                    const owner = takenBy.get(o.id)
                    const takenByOther = owner && owner !== c.id
                    return (
                      <option key={o.id} value={o.id} disabled={!!takenByOther}>
                        {o.label}
                        {takenByOther ? ` — used by ${nameOf(play, owner)}` : ''}
                      </option>
                    )
                  })}
                </select>
              </li>
            )
          })}
        </ul>
      )}
      <p className="muted small">A voice in use elsewhere is greyed out, so every character stays distinct.</p>
    </div>
  )
}

function nameOf(play: Play, id?: string): string {
  return play.characters.find((c) => c.id === id)?.name ?? '—'
}

/** Render a line's words with its inline cues: {vocal} cues in accent italics,
 *  (performance) cues in muted italics. Neither is spoken or scored. */
function LineText({ beat, showDirections }: { beat: Beat; showDirections: boolean }) {
  const segments = beat.segments
  if (!showDirections || !segments || segments.length === 0) {
    return <p className="beat-text">{beat.text}</p>
  }
  return (
    <p className="beat-text">
      {segments.map((s, i) => (
        <span key={i}>
          {s.cue && <em className="seg-cue">({s.cue})</em>}
          {s.direction && <em className="seg-direction">{`{${s.direction}}`}</em>}
          {s.text}
          {i < segments.length - 1 ? ' ' : ''}
        </span>
      ))}
    </p>
  )
}
