// In-app help: user-facing (the README on GitHub is the developer-facing doc).
// Static, offline like everything else. Written for the youngest plausible
// reader without talking down to adults.

export function Help() {
  return (
    <section className="help">
      <div className="section-head">
        <h1>Help</h1>
      </div>

      <section className="help-block">
        <h3>Quick start</h3>
        <ol className="help-steps">
          <li>Open a play in the <strong>Library</strong> (or create/import your own).</li>
          <li>Press <strong>Rehearse</strong> and choose which part <em>you</em> are playing.</li>
          <li>Pick what to rehearse — the whole play, one scene, or just your lines.</li>
          <li>Press <strong>Start rehearsal</strong>. Understudy speaks everyone else, then waits for you.</li>
        </ol>
        <p className="muted small">
          The first time ever, a quick sound check makes sure your microphone works. The first time you rehearse a
          play, there can be short pauses while each partner voice is prepared — the second time through is instant.
        </p>
      </section>

      <section className="help-block">
        <h3>Reading your score</h3>
        <p>As you speak, each word of your line lights up:</p>
        <ul className="help-legend">
          <li>
            <span className="word match">green</span> — you said it right (close sound-alikes count too)
          </li>
          <li>
            <span className="word near">amber</span> — close enough to accept, but not exact
          </li>
          <li>
            <span className="word sub">red</span> — a different word came out in its place
          </li>
          <li>
            <span className="word missing">grey</span> — a word you skipped (or haven't reached yet)
          </li>
        </ul>
        <p className="muted small">
          A line passes when enough of it is right — set the bar with “Accuracy needed to pass” in Settings, or from
          the 🎚 Tune panel mid-rehearsal. Pause as long as you like mid-line: nothing moves on until you finish it.
        </p>
      </section>

      <section className="help-block">
        <h3>Cues in the script</h3>
        <p>Two kinds of cue can sit anywhere inside a line:</p>
        <ul>
          <li>
            <em className="seg-direction">{'{braces}'}</em> are <strong>vocal cues</strong> — they shape <em>how</em>{' '}
            the voice says the words after them: <code>{'{angrily}'}</code> Does any here know me?
          </li>
          <li>
            <em className="seg-cue">(parentheses)</em> are <strong>performance cues</strong> — shown to the actor,
            never spoken or scored: <code>(draws his sword)</code>
          </li>
        </ul>
        <p className="muted small">
          In the editor there's a palette of ready-made vocal cues to click or drag into the script — but any{' '}
          <code>{'{word or phrase}'}</code> works.
        </p>
      </section>

      <section className="help-block">
        <h3>Voices</h3>
        <p>
          The free voices (System and Kokoro) work offline with no setup. For truly expressive acting voices, Settings
          lets you add your own API key for ElevenLabs, OpenAI, Azure, or Google Gemini — the key stays on this device
          and each line's audio is generated once, then cached, so it replays instantly and offline.
        </p>
        <p className="muted small">
          Every character can have their own voice, personality, and age in the play editor — or swap voices
          mid-rehearsal from the 🎭 Voices panel.
        </p>
      </section>

      <section className="help-block">
        <h3>During rehearsal</h3>
        <p>The toolbar at the bottom of the stage holds everything you need mid-scene:</p>
        <ul>
          <li>
            <strong>Show line / Try again / Next</strong> — reveal the words when stuck, redo a line, or move on.
          </li>
          <li>
            <strong>Auto-cue</strong> — move on automatically when you finish a line, or turn it off to go at your
            own pace.
          </li>
          <li>
            <strong>🎭 Voices</strong> — swap any character's voice mid-rehearsal.
          </li>
          <li>
            <strong>🎚 Tune</strong> — turn scoring off to read along without the mic, adjust the accuracy needed to
            pass, switch on <strong>auto-scroll</strong> for long speeches (off by default; your lines crawl at a
            speed you choose, the partner's follow the voice), and show the projection meter.
          </li>
        </ul>
        <p className="muted small">
          While you speak, a level meter runs down the right edge of the screen. With projection coaching on it shows
          a loudness target to push past — great for building stage volume. On tablets and computers, Settings can
          also show a one-line peek of the next line and who speaks it.
        </p>
      </section>

      <section className="help-block">
        <h3>Your privacy</h3>
        <p>
          Everything stays on this device: your plays, edits, scores, settings, and any API keys. There are no
          accounts, no server, and no tracking. With the default (Whisper) recognition, your voice never leaves this
          device. Two things do use the internet, both your choice: cloud voices are sent the <em>script text</em> of
          partner lines, and the optional Web Speech recogniser sends your microphone audio to your browser's vendor.
        </p>
        <p className="muted small">
          Understudy is open source —{' '}
          <a href="https://github.com/akaSlip/understudy" target="_blank" rel="noreferrer">
            view the code on GitHub
          </a>
          .
        </p>
      </section>
    </section>
  )
}
