// Text normalisation shared by both sides of the comparison. The target line
// and the recognizer hypothesis are put through the same pipeline so that
// casing, punctuation, contractions and digits never cause spurious mismatches.

const CONTRACTIONS: Record<string, string> = {
  "i'm": 'i am', "im": 'i am',
  "you're": 'you are', "youre": 'you are',
  "we're": 'we are', "they're": 'they are', "theyre": 'they are',
  "he's": 'he is', "she's": 'she is', "it's": 'it is', "its": 'it is',
  "that's": 'that is', "thats": 'that is', "what's": 'what is', "whats": 'what is',
  "who's": 'who is', "there's": 'there is', "theres": 'there is', "here's": 'here is',
  "let's": 'let us', "lets": 'let us',
  "don't": 'do not', "dont": 'do not', "doesn't": 'does not', "didn't": 'did not',
  "isn't": 'is not', "aren't": 'are not', "wasn't": 'was not', "weren't": 'were not',
  "haven't": 'have not', "hasn't": 'has not', "hadn't": 'had not',
  "won't": 'will not', "wouldn't": 'would not', "can't": 'can not', "cant": 'can not',
  "cannot": 'can not', "couldn't": 'could not', "shouldn't": 'should not',
  "mustn't": 'must not', "shan't": 'shall not',
  "i'll": 'i will', "you'll": 'you will', "he'll": 'he will', "she'll": 'she will',
  "we'll": 'we will', "they'll": 'they will', "it'll": 'it will',
  "i've": 'i have', "you've": 'you have', "we've": 'we have', "they've": 'they have',
  "i'd": 'i would', "you'd": 'you would', "he'd": 'he would', "she'd": 'she would',
  "we'd": 'we would', "they'd": 'they would',
  "gonna": 'going to', "wanna": 'want to', "gotta": 'got to', "gimme": 'give me',
  "'tis": 'it is', "'twas": 'it was', "o'er": 'over', "ne'er": 'never', "e'er": 'ever',
}

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen',
  'eighteen', 'nineteen']
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety']

function numberToWords(n: number): string {
  if (n < 0) return 'minus ' + numberToWords(-n)
  if (n < 20) return ONES[n]
  if (n < 100) return (TENS[Math.floor(n / 10)] + (n % 10 ? ' ' + ONES[n % 10] : '')).trim()
  if (n < 1000)
    return (ONES[Math.floor(n / 100)] + ' hundred' + (n % 100 ? ' ' + numberToWords(n % 100) : '')).trim()
  if (n < 1_000_000)
    return (numberToWords(Math.floor(n / 1000)) + ' thousand' + (n % 1000 ? ' ' + numberToWords(n % 1000) : '')).trim()
  return String(n)
}

function stripEdges(w: string): string {
  // Drop surrounding punctuation but keep intra-word apostrophes for the
  // contraction lookup; those are removed afterwards.
  return w.replace(/^[^\p{L}\p{N}']+/u, '').replace(/[^\p{L}\p{N}']+$/u, '')
}

/** Normalise a single raw word into 0+ comparison tokens. */
export function normalizeWord(rawWord: string): string[] {
  let w = stripEdges(rawWord).toLowerCase().replace(/[’‘]/g, "'")
  if (!w) return []
  if (CONTRACTIONS[w]) return CONTRACTIONS[w].split(' ')
  if (/^\d+$/.test(w)) {
    const n = Number(w)
    if (Number.isFinite(n) && n < 1_000_000) return numberToWords(n).split(' ')
  }
  // Remove remaining apostrophes/possessives so "hamlet's" ~ "hamlets".
  w = w.replace(/'/g, '')
  return w ? [w] : []
}

export interface TargetToken {
  text: string
  /** Index of the display word this token was derived from. */
  rawIndex: number
}

/** Split a target line into display words plus normalised tokens carrying the
 *  display-word index (so a 1→many expansion like "don't"→"do not" still maps
 *  back to a single highlightable word). */
export function tokenizeTarget(text: string): { rawWords: string[]; tokens: TargetToken[] } {
  const rawWords = text.split(/\s+/).filter(Boolean)
  const tokens: TargetToken[] = []
  rawWords.forEach((raw, rawIndex) => {
    for (const t of normalizeWord(raw)) tokens.push({ text: t, rawIndex })
  })
  return { rawWords, tokens }
}

/** Flatten a recognizer hypothesis into normalised comparison tokens. */
export function tokenizeHypothesis(text: string): string[] {
  const out: string[] = []
  for (const raw of text.split(/\s+/)) out.push(...normalizeWord(raw))
  return out
}
