// ---------------------------------------------------------------------------
// Best-effort gender guess from a character name, for casting the auto voices.
// ---------------------------------------------------------------------------
// This is a heuristic, not a truth: it reads honorifics ("Mr", "Lady"), role
// words ("King", "Nurse"), and a compact list of common given names. Anything
// unknown returns undefined and the caller falls back to any free voice.

export type Gender = 'f' | 'm'

// Honorifics / titles — checked first and trusted most.
const TITLES: Record<string, Gender> = {
  mr: 'm', mister: 'm', sir: 'm', lord: 'm', master: 'm', fr: 'm', father: 'm', br: 'm', brother: 'm',
  mrs: 'f', ms: 'f', miss: 'f', mistress: 'f', madam: 'f', madame: 'f', lady: 'f', dame: 'f', sister: 'f', sr: 'f',
}

// Role / relationship words that imply a gender, checked anywhere in the name.
// Includes the classic stage roles ("FIRST MURDERER", "LORDS") that plays use
// for unnamed parts — these were falling through to "any voice" and getting
// mis-gendered.
const ROLES: Record<string, Gender> = {
  king: 'm', prince: 'm', duke: 'm', earl: 'm', baron: 'm', knight: 'm', son: 'm', boy: 'm', man: 'm',
  husband: 'm', groom: 'm', widower: 'm', waiter: 'm', butler: 'm', footman: 'm', huntsman: 'm', watchman: 'm',
  gentleman: 'm', gentlemen: 'm', priest: 'm', monk: 'm', friar: 'm', bishop: 'm', emperor: 'm', soldier: 'm',
  soldiers: 'm', guard: 'm', guards: 'm', lord: 'm', lords: 'm', murderer: 'm', murderers: 'm', captain: 'm',
  sergeant: 'm', porter: 'm', officer: 'm', apothecary: 'm', shepherd: 'm', clown: 'm', fool: 'm', page: 'm',
  herald: 'm', uncle: 'm', father: 'm', brother: 'm', grandfather: 'm', prophet: 'm', wizard: 'm',
  queen: 'f', princess: 'f', duchess: 'f', countess: 'f', baroness: 'f', daughter: 'f', girl: 'f', woman: 'f',
  wife: 'f', bride: 'f', widow: 'f', maid: 'f', maiden: 'f', nurse: 'f', governess: 'f', waitress: 'f',
  gentlewoman: 'f', nun: 'f', abbess: 'f', empress: 'f', mother: 'f', aunt: 'f', mrs: 'f', witch: 'f',
  witches: 'f', ladies: 'f', grandmother: 'f', shepherdess: 'f', sister: 'f',
}

const FEMALE_NAMES = new Set(
  (
    'mary patricia jennifer linda elizabeth barbara susan jessica sarah karen nancy lisa margaret betty ' +
    'sandra ashley dorothy kimberly emily donna michelle carol amanda helen anna rose grace alice ellen ' +
    'emma olivia sophia isabella mia charlotte amelia harper evelyn abigail ella scarlett victoria juliet ' +
    'cecily gwendolen gwendoline cordelia ophelia desdemona rosalind viola bianca beatrice hero portia ' +
    'katherine catherine cathy kate katie kitty nora nell peggy polly fanny lydia jane joan jean joanna ' +
    'clara cora edith florence gertrude hattie ida martha maud minnie nellie bertha blanche flora estelle ' +
    'agnes gladys hazel irene marion mabel marguerite pauline sylvia vera violet winifred beth diana ' +
    'eve celia miranda regan goneril lavinia tamora calpurnia hermia helena marina imogen perdita'
  ).split(/\s+/),
)

const MALE_NAMES = new Set(
  (
    'james john robert michael william david richard joseph thomas charles christopher daniel matthew ' +
    'anthony mark donald steven paul andrew joshua kenneth kevin brian george edward ronald timothy jason ' +
    'jack henry harry frank arthur ernest algernon lane oscar romeo mercutio benvolio tybalt paris peter ' +
    'hamlet horatio laertes claudius polonius othello iago cassio roderigo lear kent edgar edmund gloucester ' +
    'macbeth banquo duncan malcolm lennox ross fleance caesar brutus cassius antony octavius casca ' +
    'walter albert alfred herbert samuel simon philip stephen martin lewis lawrence leonard raymond roy ' +
    'ralph carl louis clarence eugene fred gilbert harold howard hugh isaac jacob leo max nathaniel ' +
    'nicholas oliver oscar percy reginald sidney sydney theodore victor vincent wallace wilfred ' +
    'prospero caliban ariel ferdinand sebastian gonzalo antonio orlando jaques duke touchstone'
  ).split(/\s+/),
)

/** Guess a character's gender from their name, or undefined if unknown. */
export function guessGender(name: string): Gender | undefined {
  const tokens = name
    .toLowerCase()
    .replace(/[^\p{L}.\s]/gu, ' ')
    .split(/\s+/)
    .map((t) => t.replace(/\.$/, ''))
    .filter(Boolean)
  if (!tokens.length) return undefined

  // 1. An honorific anywhere is the strongest signal.
  for (const t of tokens) if (TITLES[t]) return TITLES[t]
  // 2. A recognised given name (any token, since "Old Gobbo" etc. lead with a role).
  for (const t of tokens) {
    if (FEMALE_NAMES.has(t)) return 'f'
    if (MALE_NAMES.has(t)) return 'm'
  }
  // 3. A role / relationship word.
  for (const t of tokens) if (ROLES[t]) return ROLES[t]
  return undefined
}
