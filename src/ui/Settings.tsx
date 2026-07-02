import { useEffect, useState } from 'react'
import { webSpeechSupported } from '../audio/webSpeechRecognizer'
import { compatibilityReport, detectCapabilities } from '../lib/capabilities'
import { synthesisSupported } from '../tts/webspeech'
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
              checked={settings.tts === 'webspeech'}
              disabled={!synthOk}
              onChange={() => updateSettings({ tts: 'webspeech' })}
            />
            <span>
              <strong>System voice</strong> — instant, zero download. Quality varies by device.
            </span>
          </label>
          <label className="opt">
            <input
              type="radio"
              checked={settings.tts === 'kokoro'}
              onChange={() => updateSettings({ tts: 'kokoro' })}
            />
            <span>
              <strong>Kokoro (neural, on-device)</strong> — noticeably less robotic, offline. Downloads a model on first use.
            </span>
          </label>
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
          <label className="range">
            <span>
              Reveal the whole line if I stay silent for:{' '}
              {settings.keepFlowTimeoutMs === 0 ? 'off' : (settings.keepFlowTimeoutMs / 1000).toFixed(0) + 's'}
            </span>
            <input
              type="range"
              min={0}
              max={20000}
              step={1000}
              value={settings.keepFlowTimeoutMs}
              onChange={(e) => updateSettings({ keepFlowTimeoutMs: Number(e.target.value) })}
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
          <legend>Expressive voices (premium)</legend>
          <p className="muted small">
            v1 uses free on-device voices. To enable true acting inflection later (ElevenLabs v3 / Hume Octave),
            add an API key — audio is generated once per line and cached, so it plays back instantly and offline.
            The wiring already exists in <code>src/tts/premium.ts</code>; only a key (and, for ElevenLabs, a small
            CORS relay) is needed.
          </p>
        </fieldset>
      </div>
    </section>
  )
}
