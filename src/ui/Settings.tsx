import { useEffect, useRef, useState } from 'react'
import type { PremiumEngine } from '../types'
import { webSpeechSupported } from '../audio/webSpeechRecognizer'
import { compatibilityReport, detectCapabilities } from '../lib/capabilities'
import { synthesisSupported } from '../tts/webspeech'
import { isPremiumEngine } from '../tts/premium'
import { ENGINE_INFO, PREMIUM_VOICES } from '../tts/premiumVoices'
import { Speaker } from '../tts/speaker'
import type { PremiumSettings } from '../store/settings'
import { audioCacheStats, clearAudioCache } from '../store/audioCache'
import { CompatBanner } from './CompatBanner'
import { useApp } from './useApp'

const BUILD_STAMP = typeof __BUILD_STAMP__ === 'string' ? __BUILD_STAMP__ : 'dev'

export function Settings() {
  const { settings, updateSettings } = useApp()
  const [cleared, setCleared] = useState(false)
  const [usage, setUsage] = useState<{ count: number; bytes: number } | null>(null)

  useEffect(() => {
    let alive = true
    void audioCacheStats().then((s) => {
      if (alive) setUsage(s)
    })
    return () => {
      alive = false
    }
  }, [cleared])

  const webSpeechOk = webSpeechSupported()
  const synthOk = synthesisSupported()
  const compat = compatibilityReport(detectCapabilities(), settings)
  // Narrowed once so it's usable inside callbacks (a guard on settings.tts alone
  // wouldn't survive into the onPatch closure).
  const premiumEngine = isPremiumEngine(settings.tts) ? settings.tts : null

  return (
    <section className="settings">
      <div className="section-head">
        <h1>Settings</h1>
      </div>

      <div className="settings-grid">
        <fieldset>
          <legend>Browser compatibility</legend>
          <CompatBanner issues={compat} />
        </fieldset>

        <fieldset>
          <legend>Appearance</legend>
          <div className="theme-row">
            {(['system', 'light', 'dark'] as const).map((t) => (
              <label key={t} className={`theme-choice ${settings.theme === t ? 'selected' : ''}`}>
                <input
                  type="radio"
                  name="theme"
                  checked={settings.theme === t}
                  onChange={() => updateSettings({ theme: t })}
                />
                <span>{t === 'system' ? 'System' : t === 'light' ? 'Light' : 'Dark'}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset>
          <legend>Scoring — speech recognition</legend>
          <label className="opt">
            <input
              type="radio"
              name="recognizer"
              checked={settings.recognizer === 'whisper'}
              onChange={() => updateSettings({ recognizer: 'whisper' })}
            />
            <span>
              <strong>Whisper (on-device)</strong> — private &amp; offline. Downloads once, then cached.
            </span>
          </label>
          {settings.recognizer === 'whisper' && (
            <div className="sub-opt">
              <label>
                Model:{' '}
                <select
                  value={settings.whisperModel}
                  onChange={(e) => updateSettings({ whisperModel: e.target.value as 'tiny' | 'base' })}
                >
                  <option value="tiny">tiny — fastest (~40 MB)</option>
                  <option value="base">base — more accurate (~150 MB)</option>
                </select>
              </label>
            </div>
          )}
          <label className="opt">
            <input
              type="radio"
              name="recognizer"
              checked={settings.recognizer === 'webspeech'}
              disabled={!webSpeechOk}
              onChange={() => updateSettings({ recognizer: 'webspeech' })}
            />
            <span>
              <strong>Web Speech API</strong> — real-time, cloud-backed. {webSpeechOk ? '' : 'Not available in this browser.'}
            </span>
          </label>
        </fieldset>

        <fieldset>
          <legend>Scene-partner voice</legend>
          <label className="opt">
            <input
              type="radio"
              name="tts"
              checked={settings.tts === 'webspeech'}
              disabled={!synthOk}
              onChange={() => updateSettings({ tts: 'webspeech' })}
            />
            <span>
              <strong>System voice</strong> — free, instant, offline. Quality varies by device.
            </span>
          </label>
          <label className="opt">
            <input
              type="radio"
              name="tts"
              checked={settings.tts === 'kokoro'}
              onChange={() => updateSettings({ tts: 'kokoro' })}
            />
            <span>
              <strong>Kokoro (neural, on-device)</strong> — free, offline, less robotic. Downloads a model on first use.
            </span>
          </label>

          <p className="muted small" style={{ margin: '0.5rem 0 0.25rem' }}>
            Expressive cloud voices — paste your own API key (kept only on this device, called straight from your browser,
            no server to set up):
          </p>
          {(['elevenlabs', 'openai', 'azure', 'gemini'] as PremiumEngine[]).map((eng) => (
            <label className="opt" key={eng}>
              <input type="radio" name="tts" checked={settings.tts === eng} onChange={() => updateSettings({ tts: eng })} />
              <span>
                <strong>{ENGINE_INFO[eng].label}</strong>
                {settings.premium[eng]?.apiKey ? ' — key set ✓' : ' — needs a key'}
              </span>
            </label>
          ))}

          {premiumEngine && (
            <PremiumVoiceConfig
              key={premiumEngine}
              engine={premiumEngine}
              cfg={settings.premium[premiumEngine] ?? {}}
              rate={settings.ttsRate}
              onPatch={(patch) =>
                updateSettings({
                  premium: { ...settings.premium, [premiumEngine]: { ...settings.premium[premiumEngine], ...patch } },
                })
              }
            />
          )}

          <label className="range">
            <span>Voice speed: {settings.ttsRate.toFixed(2)}×</span>
            <input
              type="range"
              min={0.6}
              max={1.4}
              step={0.05}
              value={settings.ttsRate}
              onChange={(e) => updateSettings({ ttsRate: Number(e.target.value) })}
            />
          </label>
          <label className="opt">
            <input
              type="checkbox"
              checked={settings.speakStageDirections}
              onChange={(e) => updateSettings({ speakStageDirections: e.target.checked })}
            />
            <span>Read stage directions aloud</span>
          </label>
        </fieldset>

        <fieldset>
          <legend>Scoring behaviour</legend>
          <label className="range">
            <span>Accuracy needed to pass: {Math.round(settings.passThreshold * 100)}%</span>
            <input
              type="range"
              min={0.5}
              max={1}
              step={0.05}
              value={settings.passThreshold}
              onChange={(e) => updateSettings({ passThreshold: Number(e.target.value) })}
            />
          </label>
          <label className="opt">
            <input
              type="checkbox"
              checked={settings.strict}
              onChange={(e) => updateSettings({ strict: e.target.checked })}
            />
            <span>Strict — exact words only (sound-alike words won’t count)</span>
          </label>
          <label className="opt">
            <input
              type="checkbox"
              checked={settings.waitForCompletion}
              onChange={(e) => updateSettings({ waitForCompletion: e.target.checked })}
            />
            <span>
              <strong>Wait until I finish the line</strong> — don't accept a line until I've spoken through to its end, so a
              mid-line pause never scores a half-said line.
            </span>
          </label>
          <label className="opt">
            <input
              type="checkbox"
              checked={settings.autoAdvance}
              onChange={(e) => updateSettings({ autoAdvance: e.target.checked })}
            />
            <span>
              <strong>Auto-cue the next line</strong> — move on automatically once you finish a line (you can also toggle
              this during rehearsal). Turn off to advance at your own pace.
            </span>
          </label>
          <label className="range">
            <span>Wait {(settings.endSilenceMs / 1000).toFixed(1)}s after I stop speaking before scoring</span>
            <input
              type="range"
              min={600}
              max={2500}
              step={100}
              value={settings.endSilenceMs}
              onChange={(e) => updateSettings({ endSilenceMs: Number(e.target.value) })}
            />
          </label>
          <label className="range">
            <span>Show the line if I’m stuck after: {(settings.stuckTimeoutMs / 1000).toFixed(1)}s</span>
            <input
              type="range"
              min={1500}
              max={8000}
              step={500}
              value={settings.stuckTimeoutMs}
              onChange={(e) => updateSettings({ stuckTimeoutMs: Number(e.target.value) })}
            />
          </label>
        </fieldset>

        <fieldset>
          <legend>Rehearsal display</legend>
          <label className="opt">
            <input
              type="checkbox"
              checked={settings.alwaysShowMyLines}
              onChange={(e) => updateSettings({ alwaysShowMyLines: e.target.checked })}
            />
            <span>
              <strong>Always show my lines</strong> — untick to rehearse from memory: your lines stay hidden until you say them or press “Show line”.
            </span>
          </label>
          <label className="opt">
            <input
              type="checkbox"
              checked={settings.showDirections}
              onChange={(e) => updateSettings({ showDirections: e.target.checked })}
            />
            <span>
              <strong>Show delivery directions</strong> — the manner a line is said (e.g. “exasperated, then bewildered”), from a
              line’s parenthetical or a character’s delivery note.
            </span>
          </label>
        </fieldset>

        <fieldset>
          <legend>Projection coaching</legend>
          <label className="opt">
            <input
              type="checkbox"
              checked={settings.projectionCoaching}
              onChange={(e) => updateSettings({ projectionCoaching: e.target.checked })}
            />
            <span>
              <strong>Coach my projection</strong> — the listening meter shows a loudness target and turns green when you
              project past it, and the summary scores it. Great for building volume; leave off when you need to be quiet
              (e.g. late at night).
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
                onChange={(e) => updateSettings({ projectionTarget: Number(e.target.value) })}
              />
            </label>
          )}
          <p className="muted small">
            Mic sensitivity varies by device — adjust the target so a comfortable, well-projected delivery fills the bars.
          </p>
        </fieldset>

        <fieldset>
          <legend>Storage</legend>
          <p className="muted small">
            Cached scene-partner audio:{' '}
            {usage ? `${usage.count} clip${usage.count === 1 ? '' : 's'}, ${(usage.bytes / (1024 * 1024)).toFixed(1)} MB` : '…'}
            . Capped at 50 MB — the oldest clips are removed automatically, so it can’t fill your device.
          </p>
          <button
            onClick={async () => {
              await clearAudioCache()
              setCleared(true)
              setTimeout(() => setCleared(false), 1500)
            }}
          >
            {cleared ? 'Cleared ✓' : 'Clear cached voice audio'}
          </button>
          <p className="muted small" style={{ marginTop: '0.75rem' }}>
            Build {BUILD_STAMP} · If a change you expect is missing, you’re likely on a cached older build — see “A new
            version is ready” or clear the site’s service worker, then reload.
          </p>
        </fieldset>

        <fieldset className="premium-note">
          <legend>About the expressive voices</legend>
          <p className="muted small">
            ElevenLabs, OpenAI, Azure and Gemini give true acting inflection and follow your inline “(emotion)”
            directions. Pick one above and paste your own API key — it’s stored only on this device and called straight
            from your browser, so there’s nothing to host. Each line is generated once, then cached and replays offline.
            OpenAI, Gemini and Azure work directly; ElevenLabs may need a relay in some browsers (that one field is
            optional and only shown for ElevenLabs).
          </p>
        </fieldset>
      </div>
    </section>
  )
}

/** Per-engine cloud voice config: API key (+ region for Azure), a default
 *  voice, optional model, and a live "Test voice" that proves the key works. */
function PremiumVoiceConfig(props: {
  engine: PremiumEngine
  cfg: PremiumSettings
  rate: number
  onPatch: (patch: Partial<PremiumSettings>) => void
}) {
  const { engine, cfg, rate, onPatch } = props
  const info = ENGINE_INFO[engine]
  const [test, setTest] = useState<'idle' | 'testing' | 'ok' | string>('idle')
  const speakerRef = useRef<Speaker | null>(null)

  // A changed key/voice invalidates a previous "Sounds good ✓" — and any test
  // playback still talking is now stale too, so stop it.
  useEffect(() => {
    setTest('idle')
    speakerRef.current?.stop()
  }, [cfg.apiKey, cfg.region, cfg.voiceId, cfg.proxyUrl])

  // Stop any test playback when the panel unmounts or the engine changes.
  useEffect(() => {
    return () => speakerRef.current?.stop()
  }, [])

  async function testVoice() {
    setTest('testing')
    try {
      speakerRef.current?.stop() // never overlap two test playbacks
      const speaker = new Speaker({ rate, premium: { engine, ...cfg } })
      speakerRef.current = speaker
      await speaker.speak('Hello — this is your scene partner, ready to rehearse.', {
        engine,
        voiceId: cfg.voiceId,
        rate,
      })
      setTest('ok')
    } catch (e) {
      setTest(e instanceof Error ? e.message : 'Test failed.')
    }
  }

  return (
    <div className="premium-config">
      <label className="field">
        <span>API key</span>
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder="Paste your key"
          value={cfg.apiKey ?? ''}
          onChange={(e) => onPatch({ apiKey: e.target.value.trim() || undefined })}
        />
      </label>
      {info.needsRegion && (
        <label className="field">
          <span>Region</span>
          <input
            placeholder="e.g. uksouth"
            value={cfg.region ?? ''}
            onChange={(e) => onPatch({ region: e.target.value.trim() || undefined })}
          />
        </label>
      )}
      <label className="field">
        <span>Default voice</span>
        <select value={cfg.voiceId ?? ''} onChange={(e) => onPatch({ voiceId: e.target.value || undefined })}>
          <option value="">Engine default</option>
          {PREMIUM_VOICES[engine].map((v) => (
            <option key={v.id} value={v.id}>
              {v.label}
            </option>
          ))}
        </select>
      </label>
      <div className="premium-actions">
        <button type="button" onClick={() => void testVoice()} disabled={!cfg.apiKey || test === 'testing'}>
          {test === 'testing' ? 'Testing…' : 'Test voice'}
        </button>
        {test === 'ok' && <span className="ok small">Sounds good ✓</span>}
        {test !== 'idle' && test !== 'testing' && test !== 'ok' && <span className="import-error small">{test}</span>}
        <a href={info.keysUrl} target="_blank" rel="noreferrer" className="muted small">
          Get a key →
        </a>
      </div>
      <p className="muted small">
        Your key is stored only in this browser and sent directly to {info.label}
        {engine === 'elevenlabs' ? ' (if your browser blocks it, add a relay URL under Advanced).' : ' — no server needed.'}{' '}
        Each line is generated once, then cached and replays offline.
      </p>
      {engine === 'elevenlabs' && (
        <label className="field">
          <span>Relay URL (optional)</span>
          <input
            placeholder="Only if direct calls are CORS-blocked"
            value={cfg.proxyUrl ?? ''}
            onChange={(e) => onPatch({ proxyUrl: e.target.value.trim() || undefined })}
          />
        </label>
      )}
    </div>
  )
}
