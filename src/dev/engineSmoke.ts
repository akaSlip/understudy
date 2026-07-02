// Headless test of the rehearsal engine's scoring + attempt-recording + session
// summary, using a mock recognizer/speaker (no browser, no Whisper). Run:
//   npx esbuild src/dev/engineSmoke.ts --bundle --format=esm --platform=node \
//     --outfile=/tmp/eng.mjs && node /tmp/eng.mjs

import { RehearsalEngine, type RehearsalState } from '../rehearsal/engine'
import { detectSections, resolveSection, summarizeSection } from '../lib/sections'
import { DEFAULT_SETTINGS } from '../store/settings'
import type { Play } from '../types'

let fail = 0
const check = (n: string, c: unknown, x?: unknown) => {
  if (!c) {
    fail++
    console.error('  ✗', n, x ?? '')
  } else console.log('  ✓', n)
}
const tick = () => new Promise((r) => setTimeout(r, 10))

const play: Play = {
  id: 'p',
  title: 't',
  characters: [
    { id: 'A', name: 'A' },
    { id: 'B', name: 'B' },
  ],
  beats: [
    { id: 'b1', kind: 'dialogue', characterId: 'A', text: 'hello there friend' },
    { id: 'b2', kind: 'dialogue', characterId: 'B', text: 'well met indeed' },
    { id: 'b3', kind: 'dialogue', characterId: 'A', text: 'farewell for now' },
  ],
  source: 'seed',
  createdAt: 0,
  updatedAt: 0,
}

let handlers: { onFinal: (t: string) => void } | undefined
const recognizer = {
  kind: 'whisper' as const,
  async init() {},
  async start(h: { onFinal: (t: string) => void }) {
    handlers = h
  },
  setActive() {},
  async stop() {},
  dispose() {},
}
const pregenerated: string[] = []
const speaker = {
  async speak() {},
  async speakSegments() {},
  stop() {},
  async pregenerate(text: string) {
    pregenerated.push(text)
  },
  async pregenerateSegments(segments: { text: string }[]) {
    pregenerated.push(segments.map((s) => s.text).join(' '))
  },
}

let last: RehearsalState = {} as RehearsalState
const settings = { ...DEFAULT_SETTINGS, autoAdvance: false, stuckTimeoutMs: 0, keepFlowTimeoutMs: 0 }

const engine = new RehearsalEngine({
  play,
  myCharacterId: 'A',
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  speaker: speaker as any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  recognizer: recognizer as any,
  voiceMap: new Map(),
  narratorVoice: { engine: 'webspeech' },
  settings,
  onUpdate: (s) => {
    last = s
  },
})

console.log('— rehearsal engine —')
await engine.start()
await tick()
check('starts on my line b1, listening', last.phase === 'listening' && last.beat?.id === 'b1', last.phase)
check('pre-generates the upcoming partner line', pregenerated.includes('well met indeed'), pregenerated)

handlers!.onFinal('hello there friend')
await tick()
check('b1 scored and passed', !!last.score?.passed, last.score?.accuracy)
check('b1 recorded as an attempt', last.attempts.length === 1 && last.attempts[0].passed)

engine.next()
await tick()
check('advanced through partner b2 to my line b3', last.beat?.id === 'b3' && last.isMyLine, last.beat?.id)

handlers!.onFinal('completely wrong words')
await tick()
check('b3 did not pass', last.score && !last.score.passed, last.score?.accuracy)

engine.next()
await tick()
check('session reached done', last.phase === 'done', last.phase)
check('summary has BOTH lines (pass + fail)', last.attempts.length === 2, last.attempts.map((a) => a.passed))
check('one passed, one failed', last.attempts.filter((a) => a.passed).length === 1, last.attempts.map((a) => Math.round(a.accuracy * 100)))
const avg = last.attempts.reduce((s, a) => s + a.accuracy, 0) / last.attempts.length
check('avg accuracy computed (0..1)', avg > 0 && avg < 1, avg)

// --- range selection ------------------------------------------------------
console.log('— range (beats 3–4 of 5) —')
const play2: Play = {
  id: 'p2',
  title: 't2',
  characters: play.characters,
  beats: [
    { id: 'c1', kind: 'dialogue', characterId: 'A', text: 'alpha one' },
    { id: 'c2', kind: 'dialogue', characterId: 'B', text: 'bravo two' },
    { id: 'c3', kind: 'dialogue', characterId: 'A', text: 'charlie three' },
    { id: 'c4', kind: 'dialogue', characterId: 'B', text: 'delta four' },
    { id: 'c5', kind: 'dialogue', characterId: 'A', text: 'echo five' },
  ],
  source: 'seed',
  createdAt: 0,
  updatedAt: 0,
}
let h2: { onFinal: (t: string) => void } | undefined
const rec2 = { ...recognizer, async start(h: { onFinal: (t: string) => void }) { h2 = h } }
let last2: RehearsalState = {} as RehearsalState
const engine2 = new RehearsalEngine({
  play: play2,
  myCharacterId: 'A',
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  speaker: speaker as any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  recognizer: rec2 as any,
  voiceMap: new Map(),
  narratorVoice: { engine: 'webspeech' },
  settings,
  onUpdate: (s) => {
    last2 = s
  },
  rangeStart: 2,
  rangeEnd: 3,
})
await engine2.start()
await tick()
check('range starts at beat index 2 (c3)', last2.beat?.id === 'c3', last2.beat?.id)
check('counter is 1 / 2 within range', last2.beatIndex === 0 && last2.totalBeats === 2, `${last2.beatIndex}/${last2.totalBeats}`)
h2!.onFinal('charlie three')
await tick()
engine2.next() // advances into partner c4, which auto-plays then runs past rangeEnd
await tick()
await tick()
check('range finishes after beat 3 (does not spill to c5)', last2.phase === 'done', last2.phase)
check('only in-range line recorded', last2.attempts.length === 1 && last2.attempts[0].target === 'charlie three', last2.attempts.map((a) => a.target))

// --- completion gating ----------------------------------------------------
async function runLine(waitForCompletion: boolean, feed: (h: { onFinal: (t: string) => void }) => void, thenFeed?: (h: { onFinal: (t: string) => void }) => void) {
  const p: Play = {
    id: 'pg',
    title: 'g',
    characters: play.characters,
    beats: [{ id: 'g1', kind: 'dialogue', characterId: 'A', text: 'one two three four five' }],
    source: 'seed',
    createdAt: 0,
    updatedAt: 0,
  }
  let hh: { onFinal: (t: string) => void } | undefined
  const r = { ...recognizer, async start(h: { onFinal: (t: string) => void }) { hh = h } }
  let st: RehearsalState = {} as RehearsalState
  const eng = new RehearsalEngine({
    play: p,
    myCharacterId: 'A',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    speaker: speaker as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    recognizer: r as any,
    voiceMap: new Map(),
    narratorVoice: { engine: 'webspeech' },
    settings: { ...settings, waitForCompletion, autoAdvance: false, passThreshold: 0.8 },
    onUpdate: (s) => { st = s },
  })
  await eng.start()
  await tick()
  feed(hh!)
  await tick()
  const afterFirst = st
  if (thenFeed) {
    thenFeed(hh!)
    await tick()
  }
  return { afterFirst, final: st }
}

console.log('— completion gating —')
const gated = await runLine(
  true,
  (h) => h.onFinal('one two three four'), // 4/5 = 0.8 → passes threshold but end not reached
  (h) => h.onFinal('five'),
)
check('gated: partial (0.8) does NOT advance while end unsaid', gated.afterFirst.phase === 'listening' && !!gated.afterFirst.score?.passed, `${gated.afterFirst.phase}/${gated.afterFirst.score?.passed}`)
check('gated: accepts once the last word is said', gated.final.phase === 'scored' && gated.final.attempts.length === 1, gated.final.phase)

const ungated = await runLine(false, (h) => h.onFinal('one two three four'))
check('ungated: partial (0.8) passes immediately', ungated.afterFirst.phase === 'scored', ungated.afterFirst.phase)

// --- sections (resolve + non-contiguous walk) -----------------------------
console.log('— sections —')
const sp: Play = {
  id: 's',
  title: 's',
  characters: play.characters,
  beats: [
    { id: 's0', kind: 'dialogue', characterId: 'A', text: 'first line here' },
    { id: 's1', kind: 'dialogue', characterId: 'B', text: 'partner one' },
    { id: 's2', kind: 'dialogue', characterId: 'B', text: 'partner two' },
    { id: 's3', kind: 'dialogue', characterId: 'B', text: 'partner three' },
    { id: 's4', kind: 'dialogue', characterId: 'A', text: 'second line here' },
    { id: 's5', kind: 'dialogue', characterId: 'B', text: 'partner four' },
    { id: 's6', kind: 'dialogue', characterId: 'B', text: 'partner five' },
  ],
  source: 'seed',
  createdAt: 0,
  updatedAt: 0,
}
const mineOrder = resolveSection(sp, 'A', { mode: 'mine', before: 1, after: 1 })
check('mine(1,1) skips uninvolved beats', JSON.stringify(mineOrder) === JSON.stringify([0, 1, 3, 4, 5]), mineOrder)
const sum = summarizeSection(sp, 'A', mineOrder)
check('mine summary: 2 lines across 2 clusters', sum.myLines === 2 && sum.clusters === 2, JSON.stringify(sum))
check('whole = every beat', resolveSection(sp, 'A', { mode: 'whole' }).length === 7)
check('no headings → no scenes', detectSections(sp).length === 0)

let h4: { onFinal: (t: string) => void } | undefined
const rec4 = { ...recognizer, async start(h: { onFinal: (t: string) => void }) { h4 = h } }
let l4: RehearsalState = {} as RehearsalState
const eng4 = new RehearsalEngine({
  play: sp,
  myCharacterId: 'A',
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  speaker: speaker as any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  recognizer: rec4 as any,
  voiceMap: new Map(),
  narratorVoice: { engine: 'webspeech' },
  settings: { ...settings, autoAdvance: false },
  onUpdate: (s) => { l4 = s },
  beatOrder: mineOrder,
})
await eng4.start()
await tick()
check('non-contiguous starts at s0', l4.beat?.id === 's0', l4.beat?.id)
h4!.onFinal('first line here')
await tick()
eng4.next()
await tick()
await tick()
await tick()
check('walk jumps over skipped beat s2 to s4', l4.beat?.id === 's4' && l4.isMyLine, l4.beat?.id)
h4!.onFinal('second line here')
await tick()
eng4.next()
await tick()
await tick()
check('non-contiguous finishes after last cue', l4.phase === 'done', l4.phase)
check('recorded exactly my 2 lines', l4.attempts.length === 2, l4.attempts.length)

// --- keep-flow patience (protects intentional pauses) ---------------------
console.log('— keep-flow patience —')
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function runKeepFlow(feedPartial: boolean): Promise<RehearsalState> {
  const p: Play = {
    id: 'kf',
    title: 'kf',
    characters: play.characters,
    beats: [{ id: 'k1', kind: 'dialogue', characterId: 'A', text: 'one two three four five' }],
    source: 'seed',
    createdAt: 0,
    updatedAt: 0,
  }
  let hh: { onFinal: (t: string) => void } | undefined
  const r = { ...recognizer, async start(h: { onFinal: (t: string) => void }) { hh = h } }
  let st: RehearsalState = {} as RehearsalState
  const eng = new RehearsalEngine({
    play: p,
    myCharacterId: 'A',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    speaker: speaker as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    recognizer: r as any,
    voiceMap: new Map(),
    narratorVoice: { engine: 'webspeech' },
    settings: { ...settings, autoAdvance: true, stuckTimeoutMs: 0, keepFlowTimeoutMs: 40 },
    onUpdate: (s) => { st = s },
  })
  await eng.start()
  await tick()
  if (feedPartial) {
    hh!.onFinal('one two') // began the line, then falls silent (a pause)
    await tick()
  }
  await wait(90) // let the keep-flow timer fire
  return st
}
const midPause = await runKeepFlow(true)
check('keep-flow does NOT skip a line already in progress', midPause.phase !== 'done' && midPause.attempts.length === 0, midPause.phase)
const blank = await runKeepFlow(false)
check('keep-flow reveals a silent line and waits (never auto-skips the actor’s line)', blank.phase === 'stuck' && blank.attempts.length === 0, blank.phase)

// --- auto-cue toggle ------------------------------------------------------
console.log('— auto-cue toggle —')
let h5: { onFinal: (t: string) => void } | undefined
const rec5 = { ...recognizer, async start(h: { onFinal: (t: string) => void }) { h5 = h } }
let l5: RehearsalState = {} as RehearsalState
const eng5 = new RehearsalEngine({
  play: { ...sp, beats: [{ id: 'z1', kind: 'dialogue', characterId: 'A', text: 'one two three four five' }] },
  myCharacterId: 'A',
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  speaker: speaker as any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  recognizer: rec5 as any,
  voiceMap: new Map(),
  narratorVoice: { engine: 'webspeech' },
  settings: { ...settings, autoAdvance: false },
  onUpdate: (s) => { l5 = s },
})
await eng5.start()
await tick()
h5!.onFinal('one two three four five')
await tick()
check('auto-cue off → stays on the scored line', l5.phase === 'scored', l5.phase)
eng5.setAutoCue(true)
await wait(500)
check('turning auto-cue on advances past the line', l5.phase === 'done', l5.phase)

// --- long line: a mid-speech pause must NOT cue (merged into one beat) ------
console.log('— long-line pause —')
const longText =
  "I'm sorry for that, for your sake. I don't play accurately — any one can play accurately — but I play with wonderful expression. As far as the piano is concerned, sentiment is my forte. I keep science for Life."
let h6: { onFinal: (t: string) => void } | undefined
const rec6 = { ...recognizer, async start(h: { onFinal: (t: string) => void }) { h6 = h } }
let l6: RehearsalState = {} as RehearsalState
const eng6 = new RehearsalEngine({
  play: { ...sp, beats: [{ id: 'L1', kind: 'dialogue', characterId: 'A', text: longText }] },
  myCharacterId: 'A',
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  speaker: speaker as any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  recognizer: rec6 as any,
  voiceMap: new Map(),
  narratorVoice: { engine: 'webspeech' },
  settings: { ...settings, autoAdvance: true, keepFlowTimeoutMs: 0 },
  onUpdate: (s) => { l6 = s },
})
await eng6.start()
await tick()
// Speak up to "…with wonderful expression." then pause (a natural break).
h6!.onFinal("I'm sorry for that for your sake I don't play accurately any one can play accurately but I play with wonderful expression")
await tick()
await wait(60)
check('mid-speech pause does not cue the next line', l6.phase !== 'done' && l6.beat?.id === 'L1', `${l6.phase}/${l6.beat?.id}`)
check('mid-speech pause records no completed attempt', l6.attempts.length === 0, l6.attempts.length)
// Finish the line → now it should complete.
h6!.onFinal('as far as the piano is concerned sentiment is my forte I keep science for life')
await tick()
check('line accepts once finished', l6.score?.passed === true, l6.score?.accuracy)

// --- in-rehearsal voice change -------------------------------------------
console.log('— voice change —')
{
  const vm = new Map([['B', { engine: 'webspeech' as const, rate: 1, voiceId: 'old' }]])
  const eng = new RehearsalEngine({
    play,
    myCharacterId: 'A',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    speaker: speaker as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    recognizer: recognizer as any,
    voiceMap: vm,
    narratorVoice: { engine: 'webspeech', rate: 1 },
    settings,
    onUpdate: () => {},
  })
  eng.setVoice('B', 'new')
  check('setVoice updates an existing character voice', vm.get('B')?.voiceId === 'new', vm.get('B'))
  eng.setVoice('B', undefined)
  check('setVoice can clear back to default', vm.get('B')?.voiceId === undefined)
}

console.log(`\n${fail === 0 ? 'ENGINE OK' : fail + ' FAILURE(S)'}`)
if (fail > 0 && typeof process !== 'undefined') process.exitCode = 1
