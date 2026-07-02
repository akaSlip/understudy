# Understudy

An offline-first **line-rehearsal web app**. You pick the character you're playing;
Understudy performs every *other* part with text-to-speech, waits for your lines,
listens, and **scores each line in real time** — highlighting wrong or missing words,
revealing the correct text when you're stuck, and letting you keep the flow going past
a fumble. Add and edit your own plays. Runs on any modern browser, installable as a PWA,
and works with **no accounts, no API keys, and no server**.

---

## Why it's built this way

- **The scene partner's lines are known ahead of time**, so instead of real-time TTS,
  audio is *pre-generated once per line and cached* — that's what lets the best (slowest)
  voices be used, plays back instantly, and works offline. In v1 the free voices are
  used; the premium seam is ready (see below).
- **Scoring exploits the known target line.** It isn't open transcription — it's
  *constrained verification*. The recognizer transcript is aligned to the script line
  with **Needleman–Wunsch** word alignment + **phonetic matching** (Double Metaphone),
  so "their/there/they're" count as correct and one dropped word doesn't cascade into a
  wall of red. That single alignment yields the 0–100% score *and* the per-word
  green/amber/red map.
- **Portable = a static PWA.** No backend to run. On-device Whisper (in a Web Worker)
  scores your lines privately and offline; IndexedDB stores plays; the Cache API stores
  generated audio.

## Running it

```bash
npm install
npm run dev        # http://localhost:5173
# or a production build:
npm run build
npm run preview
```

Open it, allow the microphone when you start a rehearsal, and go. The first rehearsal
downloads the on-device Whisper model (~40 MB for `tiny`), then it's cached for offline use.

Other scripts: `npm run typecheck`. Core logic has a standalone smoke test:

```bash
npx esbuild src/dev/smoke.ts --bundle --format=esm --platform=node --outfile=/tmp/smoke.mjs && node /tmp/smoke.mjs
```

## Using it

1. **Library** — the two seed plays (public-domain Wilde & Shakespeare) are there to
   start. Create a **New play**, or **Import** a `.fountain`/`.txt` file.
2. **Editor** — paste or type your script. Two formats are accepted: `NAME: line` or
   standard [Fountain](https://fountain.io) (character name in CAPS on its own line).
   Detected characters appear in **Cast & voices**, where you can assign a voice and a
   delivery note per character.
3. **Rehearse** — choose which character *you* play; Understudy performs the rest.
   Say your lines from memory; watch them light up. Controls: **Reveal** (show the line),
   **Retry**, **Keep going** (skip/flow past), **Pause**, **Prev**.
4. **Settings** — recognizer (Whisper on-device vs Web Speech), voice engine (system vs
   the neural **Kokoro** voice), pass threshold, strictness, auto-advance, and the
   "reveal after N s / keep-flow after N s" timers.

## Enabling expressive premium voices (later)

v1 ships free on-device voices (flat but zero-setup). To get true acting inflection
(ElevenLabs v3 audio tags, or Hume Octave natural-language direction), the wiring already
exists in [`src/tts/premium.ts`](src/tts/premium.ts):

1. Add an API key (store it locally; never commit it). ElevenLabs needs a tiny CORS relay
   (a ~50-line Cloudflare Worker) — point `PremiumConfig.proxyUrl` at it. OpenAI/Hume can
   be called directly.
2. Pass a `premium` config into `new Speaker({ rate, premium })` and set the character
   voices' `engine` to the premium engine.

Because audio is generated once per line and cached, a whole play costs a few dollars of
generation *once*, then replays instantly and offline.

## Architecture

```
src/
  lib/            fountain parser, text normalize, NW align, phonetics, scorer, seed
  audio/          MicVAD, recognizer interface, Whisper worker + wrapper, Web Speech
  tts/            Speaker facade, Web Speech + Kokoro + premium engines, voice pool
  store/          Dexie (IndexedDB) plays + settings, Cache-API audio cache
  rehearsal/      the beat-walking state machine (engine.ts)
  ui/             React components (Library, Editor, Rehearsal, Settings)
```

Stack: React + Vite + TypeScript, `vite-plugin-pwa` (Workbox), Dexie, `@huggingface/transformers`
(Whisper), `kokoro-js` (optional neural voice), `double-metaphone`.

## Known limitations (v1)

- Free voices are emotionally flat by design — premium is the upgrade path above.
- Whisper is chunk-based, so scoring is **line-grained** (lands when you finish a line),
  not word-by-word mid-speech. A streaming recognizer can drop in behind the same interface.
- Web Speech recognizer is Chrome/Edge/Safari only (no Firefox) and cloud-backed; Whisper
  is the portable default.
- WebGPU acceleration is inconsistent on stable Linux browsers, so Whisper/Kokoro fall back
  to (slower) WASM there.
- PDF import isn't wired yet (paste text or import `.fountain`/`.txt`); it's a documented
  next step (pdf.js → editable text).
