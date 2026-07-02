// Public-domain sample plays so the library is never empty. These also double
// as parser fixtures: Earnest uses the all-caps standalone-cue format, Romeo &
// Juliet uses the looser "NAME: line" format.

import type { Play } from '../types'
import { parseScript } from './fountain'
import { uid } from './util'

export interface SeedDef {
  title: string
  author: string
  fountain: string
}

const EARNEST = `Title: The Importance of Being Earnest — Act I (excerpt)
Author: Oscar Wilde

ALGERNON
Did you hear what I was playing, Lane?

LANE
I didn't think it polite to listen, sir.

ALGERNON
I'm sorry for that, for your sake. I don't play accurately — any one can play accurately — but I play with wonderful expression. As far as the piano is concerned, sentiment is my forte. I keep science for Life.

LANE
Yes, sir.

ALGERNON
And, speaking of the science of Life, have you got the cucumber sandwiches cut for Lady Bracknell?

LANE
Yes, sir.

JACK
How are you, my dear Ernest? What brings you up to town?

ALGERNON
Oh, pleasure, pleasure! What else should bring one anywhere? Eating as usual, I see, Jack!

JACK
I believe it is customary in good society to take some slight refreshment at five o'clock. Where have you been since last Thursday?

ALGERNON
Well, in the first place girls never marry the men they flirt with. Girls don't think it right.

JACK
Oh, that is nonsense!

ALGERNON
It isn't. It is a great truth. It accounts for the extraordinary number of bachelors that one sees all over the place.
`

const ROMEO = `Title: Romeo and Juliet — Act II, Scene II (excerpt)
Author: William Shakespeare

ROMEO: But soft, what light through yonder window breaks? It is the east, and Juliet is the sun.

JULIET: O Romeo, Romeo, wherefore art thou Romeo? Deny thy father and refuse thy name.

ROMEO: Shall I hear more, or shall I speak at this?

JULIET: 'Tis but thy name that is my enemy. Thou art thyself, though not a Montague.

ROMEO: I take thee at thy word. Call me but love, and I'll be new baptized. Henceforth I never will be Romeo.

JULIET: What man art thou that, thus bescreened in night, so stumblest on my counsel?
`

export const SEED_PLAYS: SeedDef[] = [
  { title: 'The Importance of Being Earnest — Act I (excerpt)', author: 'Oscar Wilde', fountain: EARNEST },
  { title: 'Romeo and Juliet — Act II, Scene II (excerpt)', author: 'William Shakespeare', fountain: ROMEO },
]

// Bump when the sample plays or the parser change how seeds should look, so
// existing installs reload the corrected samples (v2: multi-line speeches now
// parse as one beat, so a mid-speech pause no longer cues the next line).
export const SEED_VERSION = 2

export function buildSeedPlay(def: SeedDef, now: number): Play {
  const parsed = parseScript(def.fountain)
  return {
    id: uid('p_'),
    title: parsed.title ?? def.title,
    author: parsed.author ?? def.author,
    characters: parsed.characters,
    beats: parsed.beats,
    source: 'seed',
    createdAt: now,
    updatedAt: now,
  }
}
