// Standalone smoke test for the core (parser + scorer). Not part of the app
// bundle. Run with:
//   npx esbuild src/dev/smoke.ts --bundle --format=esm --platform=node \
//     --outfile=/tmp/understudy-smoke.mjs && node /tmp/understudy-smoke.mjs

import { adoptExistingIds, mergeConsecutiveDialogue, parseScript, toFountain } from '../lib/fountain'
import { directionToProsody, segmentsToTaggedText } from '../lib/directions'
import { guessGender } from '../lib/gender'
import { cleanEditionArtifacts, isImage, isPdf, needsExtraction, reconstructLines } from '../lib/ingest'
import { scoreLine } from '../lib/scorer'
import { azureStyle, buildAzureSSML, directionsInstruction, elevenLabsText, geminiPrompt, isPremiumEngine, pcmToWav } from '../tts/premium'
import { buildVoiceMap, listVoicesForEngine } from '../tts/voices'
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

console.log('\n— PDF text reconstruction —')
// Synthetic positioned text items (word = one item; y is the baseline). Rows at
// 180 and 150 are one speech; the row at 100 is a bigger gap → new paragraph.
function row(y: number, words: string[], x0 = 20): { str: string; transform: number[] }[] {
  return words.map((w, i) => ({ str: w + (i < words.length - 1 ? ' ' : ''), transform: [1, 0, 0, 1, x0 + i * 30, y] }))
}
const items = [
  ...row(180, ['ALGERNON:', 'Hello', 'there.']),
  ...row(150, ['How', 'are', 'you?']),
  ...row(100, ['JACK:', 'Fine,', 'thanks.']),
]
const rebuilt = reconstructLines(items)
check('rows become separate lines', rebuilt.split('\n').filter((l) => l.trim()).length === 3, JSON.stringify(rebuilt))
check('a larger vertical gap inserts a blank line', /you\?\n\nJACK/.test(rebuilt), JSON.stringify(rebuilt))
const reparsed = parseScript(rebuilt)
check('reconstructed PDF text parses to 2 characters', reparsed.characters.length === 2, reparsed.characters.map((c) => c.name))
const asFile = (name: string, type = '') => ({ name, type }) as unknown as File
check(
  'isPdf / isImage / needsExtraction detect by extension',
  isPdf(asFile('a.pdf')) && isImage(asFile('b.jpg')) && needsExtraction(asFile('c.png')) && !needsExtraction(asFile('d.txt')),
)

console.log('\n— edition apparatus cleanup (Folger FTLN) —')
const folger = [
  '101 Macbeth ACT 3. SC. 4',
  'MACBETH',
  'FTLN 1234 Whole as the marble, founded as the rock,',
  'FTLN 1235 As broad and general as the casing air. 25',
  'FILN 1236 But now I am cabined, cribbed, confined,', // OCR misread of FTLN
  '46',
].join('\n')
const cleanedF = cleanEditionArtifacts(folger)
check('FTLN prefixes stripped', !/F[TI]LN/.test(cleanedF), cleanedF)
check('trailing margin numbers stripped', !/air\. 25/.test(cleanedF) && /casing air\./.test(cleanedF))
check('page-number-only lines dropped', !/^\s*46\s*$/m.test(cleanedF))
check('the spoken words survive', /cabined, cribbed, confined/.test(cleanedF))
// The non-Folger case must include a standalone-number line — the exact input
// the cleanup must NOT touch without the FTLN signature.
const normalScript = 'JACK: I have 25 pounds.\n\n42\n\nALGERNON: Lend me 5.'
check('non-Folger text untouched (incl. standalone-number lines)', cleanEditionArtifacts(normalScript) === normalScript)

console.log('\n— inline delivery directions —')
const shift = parseScript('LEAR: (bewildered) Who is it can tell me who I am? (angrily) Does any here know me? (defeated) I should be false persuaded I had daughters.')
const lear = shift.beats.find((b) => b.kind === 'dialogue')
check('inline directions split into segments', lear?.segments?.length === 3, lear?.segments?.map((s) => s.direction))
check('segment directions captured in order', JSON.stringify(lear?.segments?.map((s) => s.direction)) === JSON.stringify(['bewildered', 'angrily', 'defeated']), lear?.segments?.map((s) => s.direction))
check('plain text drops the direction tags', !/[()]/.test(lear?.text ?? '(') && /Who is it/.test(lear?.text ?? ''), lear?.text)
check('segment text concatenates back to the line', lear?.segments?.map((s) => s.text).join(' ') === lear?.text, lear?.text)

// A single-tone line gets no segments (falls back to whole-line delivery).
const plainLine = parseScript('JACK: I believe it is customary to take some refreshment.')
check('single-tone line has no segments', !plainLine.beats.find((b) => b.kind === 'dialogue')?.segments)

// A parenthetical aside that is NOT a direction stays in the spoken text.
const aside = parseScript('BEN: I saw him (the tall one, from before) yesterday morning.')
const benBeat = aside.beats.find((b) => b.kind === 'dialogue')
check('non-direction parenthetical kept as spoken text', /the tall one/.test(benBeat?.text ?? '') && !benBeat?.segments, benBeat?.text)

// Round-trip through Fountain preserves the inline directions.
const rt = parseScript(toFountain({ characters: shift.characters, beats: shift.beats }))
check('round-trip keeps 3 segments', rt.beats.find((b) => b.kind === 'dialogue')?.segments?.length === 3, rt.beats.find((b) => b.kind === 'dialogue')?.segments?.map((s) => s.direction))

// Premium tagging + prosody mapping.
check('premium tagged text uses [tags]', segmentsToTaggedText(lear!.segments!) === '[bewildered] Who is it can tell me who I am? [angrily] Does any here know me? [defeated] I should be false persuaded I had daughters.', segmentsToTaggedText(lear!.segments!))
check('angry ≠ neutral prosody', directionToProsody('angrily').pitch !== 1 && directionToProsody('angrily').rate > 1)
check('sad direction slows + lowers', directionToProsody('defeated').rate < 1 && directionToProsody('defeated').pitch < 1)
check('unknown direction is neutral', directionToProsody('quizzically-ish-xyz').rate === 1 && directionToProsody('quizzically-ish-xyz').pitch === 1)

console.log('\n— audit regressions —')
// M6: a short line delivered as an accepted homophone must still PASS.
const homoshort = scoreLine('There!', 'their')
check('one-word homophone line passes (near = full pass credit)', homoshort.passed === true, homoshort.accuracy)
check('…but displayed accuracy still shows the difference', homoshort.accuracy < 1, homoshort.accuracy)

// M4: a trailing "(sadly)" colours the previous segment instead of being scoreable text.
const trailing = parseScript('A: Goodbye then. (sadly)')
const tBeat = trailing.beats.find((b) => b.kind === 'dialogue')!
check('trailing direction removed from scoreable text', !tBeat.text.includes('('), tBeat.text)
check('trailing direction attached to the segment', tBeat.segments?.some((s) => s.direction === 'sadly') === true, tBeat.segments)

// M4b: a direction-only line becomes a parenthetical, not spoken/scored words.
const only = parseScript('A: (bewildered)\n\nB: hello')
const oBeat = only.beats.find((b) => b.kind === 'dialogue' && b.characterId === only.characters[0].id)!
check('direction-only line is not scoreable text', oBeat.text === '' && oBeat.parenthetical === 'bewildered', oBeat)

// M5: tidy-merge folds the parenthetical into segments WITHOUT leaving a duplicate.
const dbl2 = parseScript('A\n(coldly)\nFirst part.\n\nA\n(warmly) Second part.')
const merged2 = mergeConsecutiveDialogue(dbl2.beats).find((b) => b.kind === 'dialogue')!
check('merge clears the stale parenthetical (no double display)', merged2.parenthetical === undefined && merged2.segments?.[0]?.direction === 'coldly', {
  parenthetical: merged2.parenthetical,
  seg0: merged2.segments?.[0]?.direction,
})

// H3: re-parsing a play re-adopts existing character/beat ids where unchanged.
const orig = parseScript('Title: T\n\nHAMLET: To be or not to be.\n\nOPHELIA: Good my lord.')
const origPlay = { characters: orig.characters, beats: orig.beats }
const roundTripped = parseScript(toFountain({ title: 'T', characters: orig.characters, beats: orig.beats }))
const adopted = adoptExistingIds(roundTripped.characters, roundTripped.beats, origPlay)
check('adopt: unchanged characters keep their ids', adopted.characters.every((c, i) => c.id === orig.characters[i].id))
check('adopt: unchanged beats keep their ids', adopted.beats.filter((b) => b.kind === 'dialogue').every((b) => orig.beats.some((o) => o.id === b.id)))
const edited = parseScript('HAMLET: To be or not to be, that is the question.\n\nOPHELIA: Good my lord.')
const adopted2 = adoptExistingIds(edited.characters, edited.beats, origPlay)
const hamBeat = adopted2.beats.find((b) => b.kind === 'dialogue' && /question/.test(b.text))!
const ophBeat = adopted2.beats.find((b) => b.kind === 'dialogue' && /lord/.test(b.text))!
check('adopt: an edited beat gets a fresh id', !orig.beats.some((o) => o.id === hamBeat.id))
check('adopt: an untouched beat still keeps its id', orig.beats.some((o) => o.id === ophBeat.id))

console.log('\n— scorer fixes —')
const dash = scoreLine('Well — no.', 'well no')
check('punctuation-only word not marked missing', dash.words.every((w) => w.status !== 'missing'), dash.words.map((w) => `${w.raw}:${w.status}`))
check('em-dash line scores 100%', dash.accuracy === 1, dash.accuracy)

console.log('\n— voice casting —')
check('guess: honorific "Lady Bracknell" → f', guessGender('Lady Bracknell') === 'f')
check('guess: "Mr Worthing" → m', guessGender('Mr. Worthing') === 'm')
check('guess: name "Algernon" → m', guessGender('Algernon') === 'm')
check('guess: name "Gwendolen" → f', guessGender('Gwendolen') === 'f')
check('guess: role "Nurse" → f', guessGender('Nurse') === 'f')
check('guess: role "King" → m', guessGender('King') === 'm')
check('guess: unknown → undefined', guessGender('Xyzzq Blort') === undefined)

await (async () => {
  const chars = [
    { id: 'a', name: 'Lady Bracknell' },
    { id: 'b', name: 'Algernon' },
    { id: 'c', name: 'Jack' },
    { id: 'd', name: 'Cecily' },
  ] as unknown as import('../types').Character[]
  const map = await buildVoiceMap(chars, 'kokoro', 1, 'c') // Jack is the actor
  check('actor character excluded from casting', !map.has('c'))
  const ids = [...map.values()].map((v) => v.voiceId)
  check('every partner voice is unique', ids.every(Boolean) && new Set(ids).size === ids.length, ids)
  const g = (vid?: string) => vid?.[1] // kokoro id shape: af_/am_/bf_/bm_
  check('Lady Bracknell cast as a female voice', g(map.get('a')?.voiceId) === 'f', map.get('a')?.voiceId)
  check('Algernon cast as a male voice', g(map.get('b')?.voiceId) === 'm', map.get('b')?.voiceId)
  check('Cecily cast as a female voice', g(map.get('d')?.voiceId) === 'f', map.get('d')?.voiceId)
})()

console.log('\n— cloud voice engines —')
check(
  'isPremiumEngine identifies the cloud engines',
  isPremiumEngine('openai') && isPremiumEngine('azure') && isPremiumEngine('gemini') && isPremiumEngine('elevenlabs') && !isPremiumEngine('kokoro') && !isPremiumEngine('webspeech'),
)
const segs = [
  { text: 'What is this?', direction: 'bewildered' },
  { text: 'How dare you!', direction: 'angrily' },
  { text: 'I give up.', direction: 'defeated' },
]
check('OpenAI instruction summarises the shifts', directionsInstruction(segs) === 'Perform with shifting emotion — bewildered, then angrily, then defeated.', directionsInstruction(segs))
check('single-direction instruction reads naturally', directionsInstruction([{ text: 'hi', direction: 'sadly' }]) === 'Speak in a sadly tone.')
check('no direction → no instruction', directionsInstruction([{ text: 'hi' }]) === undefined)
check('Gemini prompt embeds instruction + spoken text', geminiPrompt(segs).includes('shifting emotion') && geminiPrompt(segs).includes('I give up.'))
check('azureStyle maps known emotions', azureStyle('angrily') === 'angry' && azureStyle('defeated') === 'sad')
check('azureStyle returns undefined when unmapped', azureStyle('bewildered') === undefined)
const ssml = buildAzureSSML(segs, 'en-US-AriaNeural')
check('SSML wraps mapped styles in express-as', ssml.includes('<mstts:express-as style="angry"') && ssml.includes('<mstts:express-as style="sad"'), ssml)
check('SSML names the voice and keeps the words', ssml.includes('name="en-US-AriaNeural"') && ssml.includes('How dare you!'))
const wav = pcmToWav(btoa('\x01\x02\x03\x04'), 24000)
check('pcmToWav builds a 44-byte-header WAV blob', wav.type === 'audio/wav' && wav.size === 44 + 4, wav.size)
const openaiVoices = await listVoicesForEngine('openai')
check('listVoicesForEngine returns the cloud voice pool', openaiVoices.length > 0 && !!openaiVoices[0].id)
check('elevenlabs v3 gets inline audio tags', elevenLabsText('eleven_v3', segs).startsWith('[bewildered]'))
check('elevenlabs non-v3 models get PLAIN text (no spoken brackets)', !elevenLabsText('eleven_multilingual_v2', segs).includes('['), elevenLabsText('eleven_multilingual_v2', segs))

console.log(`\n${failures === 0 ? 'ALL PASSED' : failures + ' FAILURE(S)'}`)
if (failures > 0 && typeof process !== 'undefined') process.exitCode = 1
