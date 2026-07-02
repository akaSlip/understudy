import { type CSSProperties, useEffect, useMemo, useRef, useState } from 'react'
import type { Route } from '../App'
import type { Beat, Character, Play } from '../types'
import { createRecognizer } from '../audio/recognizerFactory'
import type { Recognizer } from '../audio/recognizer'
import { compatibilityReport, detectCapabilities, hasBlockingIssue, type CompatIssue } from '../lib/capabilities'
import { getPlay } from '../store/playsRepo'
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
import { buildVoiceMap } from '../tts/voices'
import { RehearsalEngine, type RehearsalState } from '../rehearsal/engine'
import { CompatBanner } from './CompatBanner'
import { useApp } from './useApp'
import { WordDiff } from './WordDiff'

export function Rehearsal({ playId, go }: { playId: string; go: (r: Route) => void }) {
  const { settings } = useApp()
  const [play, setPlay] = useState<Play | null>(null)
  const [myCharId, setMyCharId] = useState('')
  const [spec, setSpec] = useState<SectionSpec | null>(null)
  const [started, setStarted] = useState(false)
  const [starting, setStarting] = useState(false)
  const [loadMsg, setLoadMsg] = useState('')
  const [state, setState] = useState<RehearsalState | null>(null)
  const [micLevel, setMicLevel] = useState(0)

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

  // Load the remembered section for this play + part (falls back to whole play).
  useEffect(() => {
    if (!play || !myCharId) return
    let cancelled = false
    ;(async () => {
      const saved = await loadSection(play.id, myCharId)
      if (!cancelled) setSpec(saved ?? DEFAULT_SECTION)
    })()
    return () => {
      cancelled = true
    }
  }, [play, myCharId])

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

  async function begin() {
    if (!play || started || startingRef.current) return
    startingRef.current = true
    setStarting(true)
    teardown() // clear any stragglers from a prior attempt
    try {
      setLoadMsg('Preparing speech recognition…')
      const recognizer = createRecognizer(settings)
      recognizerRef.current = recognizer
      await recognizer.init((p) =>
        setLoadMsg(`Loading speech model… ${p.progress != null ? Math.round(p.progress * 100) + '%' : ''}`),
      )
      const speaker = new Speaker({ rate: settings.ttsRate, premium: null })
      const voiceMap = await buildVoiceMap(play.characters, settings.tts, settings.ttsRate)
      const narratorVoice = { engine: settings.tts, rate: settings.ttsRate }
      // Persist this section for one-click repeat rehearsal of the same scene.
      void saveSection(play.id, myCharId, effSpec)
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
          if (!s.listening) setMicLevel(0) // let the meter settle between lines
        },
        onLevel: setMicLevel,
        beatOrder: order,
      })
      engineRef.current = engine
      setStarted(true)
      setLoadMsg('Requesting microphone…')
      await engine.start()
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
        onStart={() => void begin()}
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
      micLevel={micLevel}
      engine={engineRef.current!}
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
        <button className="primary big" onClick={props.onStart} disabled={!canStart}>
          {startLabel}
        </button>
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
  micLevel: number
  engine: RehearsalEngine
  onStop: () => void
  onExit: () => void
}) {
  const { play, state, settings, engine, micLevel } = props
  const nameById = useMemo(() => new Map(play.characters.map((c) => [c.id, c.name])), [play])
  const [autoCue, setAutoCue] = useState(settings.autoAdvance)
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
              {state.listening && (
                <MicMeter level={micLevel} coaching={settings.projectionCoaching} target={settings.projectionTarget} />
              )}
            </div>
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
              <p className="hint small">🎙 Projection coaching on — fill the bars past the marker.</p>
            )}
          </>
        ) : (
          <>
            <div className="beat-role partner">
              {speaker}
              {state.phase === 'partner' && <span className="speaking-dot" title="speaking" />}
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
          <button className="ctl danger" onClick={props.onStop} title="Finish and see your results">
            <span className="ctl-icon">■</span>
            <span className="ctl-label">Finish</span>
          </button>
        </div>
      </div>
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
function MicMeter({ level, coaching, target = 0.5 }: { level: number; coaching?: boolean; target?: number }) {
  const lvl = Math.max(0, Math.min(1, level))
  const over = coaching ? lvl >= target : false
  return (
    <span
      className={`mic-meter ${coaching ? 'coaching' : ''} ${over ? 'over' : ''}`}
      role="img"
      aria-label={coaching ? 'projection meter' : 'listening'}
      title={coaching ? 'projection' : 'listening'}
      style={{ '--level': String(lvl), '--target': String(target) } as CSSProperties}
    >
      {Array.from({ length: 5 }, (_, i) => (
        <span key={i} className="mic-bar" />
      ))}
      {coaching && <span className="mic-target" aria-hidden />}
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

/** Render a line's words, optionally showing inline delivery directions before
 *  each segment when the line shifts emotion partway through. */
function LineText({ beat, showDirections }: { beat: Beat; showDirections: boolean }) {
  const segments = beat.segments
  if (!showDirections || !segments || segments.length === 0) {
    return <p className="beat-text">{beat.text}</p>
  }
  return (
    <p className="beat-text">
      {segments.map((s, i) => (
        <span key={i}>
          {s.direction && <em className="seg-direction">({s.direction})</em>}
          {s.text}
          {i < segments.length - 1 ? ' ' : ''}
        </span>
      ))}
    </p>
  )
}
