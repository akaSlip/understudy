# Understudy

An offline-first **line-rehearsal web app**. Pick the character you're playing;
Understudy performs every *other* part with text-to-speech, waits for your lines,
listens, and **scores each line in real time** — highlighting wrong or missing words
and revealing the correct text when you're stuck. Add and edit your own plays, or
import a PDF — even a photo of a script page. Runs in any modern browser, installable
as a PWA, and works with **no accounts and no server**. Free on-device voices work out
of the box; four expressive cloud voice engines are available bring-your-own-key.

---

## What it does

- **Rehearse any part**: choose your character, and the scene partner performs the
  rest — pausing for your lines and cueing you onward.
- **Real-time scoring**: each line you speak is scored 0–100% with a per-word
  green/amber/red map. Homophones count; one dropped word doesn't cascade into red.
- **Sound check & projection coaching**: a first-run mic check, a console-style level
  meter beside your line, and an optional loudness target for building projection.
- **Two kinds of inline cue**: `{braces}` are *vocal* cues — `{angrily}` shapes how
  the voice delivers the words after it; `(parentheses)` are *performance* cues —
  shown to the actor, never spoken or scored. A cue palette in the editor lets you
  click or drag common vocal cues into the script; any `{word or phrase}` works.
- **Import almost anything**: paste text, `NAME: line` format, standard
  [Fountain](https://fountain.io), `.txt`/`.md`, PDFs (embedded text reads offline),
  and photos/scans of pages via OCR (engine downloads once, ~12 MB). Folger-style
  edition line numbers are stripped automatically.
- **A real cast**: gender-aware auto-casting (UK voices first) assigns distinct
  voices; per-character **voice, personality, and age** (child → elderly) in the
  editor; swap voices mid-rehearsal from the 🎭 Voices panel.
- **Rehearse your way**: whole play, one scene, or just your lines with cue context;
  read-along mode (no mic); adjustable pass threshold from the 🎚 Tune panel; sections
  are remembered per play and part.

## Why it's built this way

- **The scene partner's lines are known ahead of time**, so audio is *generated once
  per line and cached* (Cache API, 50 MB LRU) — the slowest, best voices become
  instant on replay, and everything works offline after first use.
- **Scoring exploits the known target line.** It isn't open transcription — it's
  *constrained verification*: the recognizer transcript is aligned to the script line
  with **Needleman–Wunsch** word alignment + **Double Metaphone** phonetics. One
  alignment yields both the score and the per-word colour map.
- **Portable = a static PWA.** No backend. On-device Whisper (in a Web Worker) scores
  your lines privately; Kokoro synthesises neural voices in another worker so the UI
  never blocks; IndexedDB stores plays and settings.

## Voices

| Engine | Cost | Where it runs | Notes |
|---|---|---|---|
| System voice | free | on device¹ | instant, quality varies by platform |
| Kokoro (neural) | free | on device | less robotic; ~90 MB model on first use |
| ElevenLabs v3 | your key | cloud | best acting; `{vocal}` cues become audio tags |
| OpenAI | your key | cloud | cues become delivery instructions |
| Azure Speech | your key | cloud | cues map to expressive SSML styles |
| Google Gemini | your key | cloud | cues become a style prompt |

Cloud keys are pasted in Settings, stored **only in your browser's IndexedDB**, and
sent only to that vendor's API — there is no relay server to set up (ElevenLabs has an
*optional* relay field for CORS-restricted browsers). A "Test voice" button verifies a
key instantly. Because lines are cached after first generation, a whole play costs a
few pennies once, then replays free and offline.

¹ Some platforms ship network-backed system voices.

## Develop

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # typecheck + unit + engine suites
npm run build      # production build (typecheck gates it)
npm run preview    # serve the production build locally
```

The first rehearsal downloads the on-device Whisper model (~40 MB `tiny`), then it's
cached for offline use.

## Deploy

- **GitHub Pages** (recommended): push this repo to GitHub, then Repo → Settings →
  Pages → Source: **"GitHub Actions"**. The included workflow builds and deploys on
  every push. The build uses relative paths, so it works from any subpath.
- **Any static host**: `npm run package` produces `understudy-app.tar.gz` (~7 MB) —
  the complete app; unpack it onto any HTTPS static host. (HTTPS or localhost is
  required: service workers and the microphone need a secure context, so the app
  cannot run from `file://`.)

## Privacy

Everything user-specific stays in the user's own browser: plays, edits, settings,
scores, API keys (IndexedDB), generated audio (Cache API). There is no server, no
account, no analytics, and no telemetry. Data leaves the device only when:

- a **cloud voice engine you configured** is sent the scene-partner line text (with
  your key, direct to that vendor);
- the optional **Web Speech recognizer** is selected — your microphone audio is then
  transcribed by your browser vendor's servers (e.g. Google). The default, Whisper,
  runs entirely on-device;
- **models are downloaded** (Whisper/Kokoro from Hugging Face, OCR from jsDelivr) —
  downloads only, nothing is uploaded.

## Browser support

- **Whisper recognition**: any browser with WebAssembly (everywhere). WebGPU
  accelerates it on Chrome/Edge; elsewhere it falls back to slower WASM.
- **Web Speech recognition**: Chrome/Edge/Safari only (no Firefox) — optional.
- **PWA install**: Chromium browsers and iOS/Android; works as a normal site elsewhere.

## Architecture

```
src/
  lib/         fountain parser, ingest (PDF/OCR), cues, scorer, align, phonetics,
               gender casting, sections, capabilities, wav
  audio/       MicVAD, recognizer interface, Whisper worker + client, Web Speech
  tts/         Speaker facade, engine traits, Web Speech / Kokoro worker / 4 cloud
               engines, voice pools + auto-casting
  store/       Dexie (IndexedDB) plays + settings + flags, Cache-API audio cache
  rehearsal/   the beat-walking state machine (engine.ts)
  ui/          React components (Library, Editor, Rehearsal, Settings, meters)
  dev/         standalone smoke suites (run via npm test)
```

Stack: React + Vite + TypeScript, `vite-plugin-pwa` (Workbox), Dexie,
`@huggingface/transformers` (Whisper), `kokoro-js`, `pdfjs-dist`, `tesseract.js`,
`double-metaphone`.

## Known limitations

- Whisper is chunk-based, so scoring is **line-grained** (lands when you finish a
  line), not word-by-word mid-speech. A streaming recognizer can drop in behind the
  same `Recognizer` interface.
- Free voices are emotionally flatter than the cloud engines — vocal cues are
  approximated with pitch/rate/pause shifts.
- OCR of scans needs a connection the first time (engine download), and OCR output
  is worth a skim in the editor before rehearsing.
- A play's *first* run-through generates each partner line as it's reached (short
  pauses possible); the second run is instant from cache.

## Licence

[MIT](LICENSE) — use it, modify it, share it; keep the copyright notice.
