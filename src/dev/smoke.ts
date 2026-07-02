// Standalone smoke test for the core (parser + scorer). Not part of the app
// bundle. Run with:
//   npx esbuild src/dev/smoke.ts --bundle --format=esm --platform=node \
//     --outfile=/tmp/understudy-smoke.mjs && node /tmp/understudy-smoke.mjs

import { mergeConsecutiveDialogue, parseScript } from '../lib/fountain'
import { scoreLine } from '../lib/scorer'
import { SEED_PLAYS, buildSeedPlay } from '../lib/seed'

let failures = 0
function check(name: string, cond: unknown, extra?: unknown) {
  if (!cond) {
    failures++
    console.error(`  ✗ ${name}`, extra ?? '')
  } else {
    console.log(`  ✓ ${name}`)
  }
}

console.log('— parser —')
const earnest = parseScript(SEED_PLAYS[0].fountain)
check('earnest title parsed', earnest.title?.startsWith('The Importance'))
check('earnest has 3 characters (ALGERNON, LANE, JACK)', earnest.characters.length === 3, earnest.characters.map((c) => c.name))
check('earnest dialogue beats present', earnest.beats.filter((b) => b.kind === 'dialogue').length >= 10)
check('earnest first beat is ALGERNON dialogue', earnest.beats[0].kind === 'dialogue')

const romeo = parseScript(SEED_PLAYS[1].fountain)
check('romeo inline "NAME:" parsed to 2 characters', romeo.characters.length === 2, romeo.characters.map((c) => c.name))
check('romeo dialogue text has no leading name', !/^ROMEO/i.test(romeo.beats[0].text), romeo.beats[0].text)

// A tricky non-character label must NOT become a character.
const labelTest = parseScript('SETTING: A garden.\n\nHAMLET: To be or not to be.')
check('label "SETTING:" is not a character', labelTest.characters.length === 1 && labelTest.characters[0].name.toUpperCase() === 'HAMLET', labelTest.characters.map((c) => c.name))

console.log('\n— scorer —')
const target = 'But soft, what light through yonder window breaks?'

const perfect = scoreLine(target, 'but soft what light through yonder window breaks')
check('perfect delivery = 100%', perfect.accuracy === 1 && perfect.passed, perfect.accuracy)
check('perfect: all words match', perfect.words.every((w) => w.status === 'match'))

const homophone = scoreLine('Their house is over there.', 'there house is over their')
check('homophones accepted (their/there)', homophone.accuracy >= 0.8, homophone.words.map((w) => `${w.raw}:${w.status}`))

const missing = scoreLine(target, 'but soft what light through window breaks')
check('missing word detected', missing.words.some((w) => w.status === 'missing'), missing.words.map((w) => `${w.raw}:${w.status}`))
check('missing word is "yonder"', missing.words.find((w) => w.status === 'missing')?.raw === 'yonder')

const wrong = scoreLine(target, 'but hard what light through yonder window breaks')
check('substitution detected for "soft"->"hard"', wrong.words.find((w) => w.raw.toLowerCase().startsWith('soft'))?.status === 'sub', wrong.words.map((w) => `${w.raw}:${w.status}`))

const extra = scoreLine('I am here', 'i am really here')
check('extra word captured', extra.extras.length === 1 && extra.extras[0].heard === 'really', extra.extras)

const contraction = scoreLine("I don't play accurately", 'i do not play accurately')
check("contraction don't == do not", contraction.accuracy === 1, contraction.words.map((w) => `${w.raw}:${w.status}`))

const numbers = scoreLine('at five o clock', 'at 5 o clock')
check('digit 5 == five', numbers.accuracy >= 0.75, numbers.words.map((w) => `${w.raw}:${w.status}`))

console.log('\n— parser fixes —')
const noBlank = parseScript('Title: Hamlet\nHAMLET: To be or not to be.\nOPHELIA: Good my lord.')
check('title page w/o blank line keeps body', noBlank.beats.filter((b) => b.kind === 'dialogue').length === 2, noBlank.beats.map((b) => b.kind))
check('title parsed as Hamlet', noBlank.title === 'Hamlet', noBlank.title)
check('two characters after title page', noBlank.characters.length === 2, noBlank.characters.map((c) => c.name))

const sceneLabel = parseScript('SCENE 1: A castle at night\n\nHAMLET: To be.')
check('"SCENE 1" is not a character', sceneLabel.characters.length === 1 && sceneLabel.characters[0].name.toUpperCase() === 'HAMLET', sceneLabel.characters.map((c) => c.name))

const enterDir = parseScript('ENTER HAMLET\nTo be or not to be.')
check('"ENTER HAMLET" is not a character', !enterDir.characters.some((c) => /enter/i.test(c.name)), enterDir.characters.map((c) => c.name))

// A speech wrapped across lines (no blank line) must be ONE beat, not one per
// line — otherwise a mid-speech line-end cues the next line prematurely.
const wrapped = parseScript('ALGERNON\nI play with wonderful expression.\nSentiment is my forte. I keep science for Life.')
const algLines = wrapped.beats.filter((b) => b.kind === 'dialogue')
check('multi-line speech merges into one beat', algLines.length === 1, algLines.map((b) => b.text))
check('merged beat keeps all the words', algLines[0]?.text.endsWith('science for Life.'), algLines[0]?.text)

// A blank line still separates two speeches by the same character.
const twoSpeeches = parseScript('ALGERNON\nFirst speech here.\n\nALGERNON\nSecond speech here.')
check('blank line separates speeches', twoSpeeches.beats.filter((b) => b.kind === 'dialogue').length === 2, twoSpeeches.beats.length)

// Inline "NAME: text" with a wrapped continuation line also merges.
const inlineWrap = parseScript('ALGERNON: I play with wonderful expression.\nSentiment is my forte.')
check('inline speech + continuation merges', inlineWrap.beats.filter((b) => b.kind === 'dialogue').length === 1, inlineWrap.beats.map((b) => b.text))

// "Tidy speeches": a double-spaced import (blank line between every line) splits
// one speech into several beats — mergeConsecutiveDialogue rejoins them.
const dbl = parseScript('ALGERNON: First part.\n\nALGERNON: Second part.\n\nALGERNON: Third part.')
check('double-spaced splits into 3 beats', dbl.beats.filter((b) => b.kind === 'dialogue').length === 3, dbl.beats.length)
const tidied = mergeConsecutiveDialogue(dbl.beats)
check('tidy rejoins into one speech', tidied.filter((b) => b.kind === 'dialogue').length === 1, tidied.length)
check('tidy keeps all words in order', tidied[0]?.text === 'First part. Second part. Third part.', tidied[0]?.text)
const mixed = parseScript('A: one\n\nB: two\n\nA: three')
check('tidy never merges across characters', mergeConsecutiveDialogue(mixed.beats).filter((b) => b.kind === 'dialogue').length === 3)

// The built-in "Earnest" sample: the "wonderful expression" speech must be ONE
// beat running through to "science for Life." (else it cues mid-speech).
const earnestSeed = buildSeedPlay(SEED_PLAYS[0], 0)
const wonderful = earnestSeed.beats.find((b) => b.kind === 'dialogue' && b.text.includes('wonderful expression'))
check('seed: "wonderful expression" speech is one full beat', !!wonderful && wonderful.text.includes('science for Life'), wonderful?.text.slice(0, 32))

console.log('\n— scorer fixes —')
const dash = scoreLine('Well — no.', 'well no')
check('punctuation-only word not marked missing', dash.words.every((w) => w.status !== 'missing'), dash.words.map((w) => `${w.raw}:${w.status}`))
check('em-dash line scores 100%', dash.accuracy === 1, dash.accuracy)

console.log(`\n${failures === 0 ? 'ALL PASSED' : failures + ' FAILURE(S)'}`)
if (failures > 0 && typeof process !== 'undefined') process.exitCode = 1
