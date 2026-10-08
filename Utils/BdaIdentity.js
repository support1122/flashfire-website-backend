// Who is a BDA, whatever name a system shows for them (plan 2.8).
// Pure functions only: no database, no clock, so they are cheap to unit test and safe to call anywhere.
//
// Rule: stable IDs first (email, Calendly user URI, Zoom user ID, Google user ID). Names are a fallback.
// Bots and the shared FLASHFIRE account are removed before any name matching, and a name match must be
// unique, otherwise the answer is "unknown" and never a guess.

// Cyrillic and Greek letters that look Latin. Written as code points so the file stays readable and
// no editor can quietly "fix" a look-alike into the real letter.
const CONFUSABLE_PAIRS = [
  // Cyrillic lowercase
  [0x0430, 'a'], [0x0435, 'e'], [0x043e, 'o'], [0x0440, 'p'], [0x0441, 'c'], [0x0443, 'y'],
  [0x0445, 'x'], [0x0456, 'i'], [0x0458, 'j'], [0x04bb, 'h'], [0x0455, 's'],
  // Cyrillic uppercase
  [0x0410, 'a'], [0x0412, 'b'], [0x0415, 'e'], [0x041a, 'k'], [0x041c, 'm'], [0x041d, 'h'],
  [0x041e, 'o'], [0x0420, 'p'], [0x0421, 'c'], [0x0422, 't'], [0x0425, 'x'], [0x0406, 'i'],
  [0x0408, 'j'], [0x0405, 's'],
  // Greek lowercase
  [0x03bf, 'o'], [0x03b1, 'a'], [0x03b5, 'e'], [0x03b9, 'i'], [0x03ba, 'k'], [0x03bd, 'v'],
  [0x03c1, 'p'], [0x03c4, 't'], [0x03c5, 'u'],
  // Greek uppercase
  [0x0391, 'a'], [0x0392, 'b'], [0x0395, 'e'], [0x0396, 'z'], [0x0397, 'h'], [0x0399, 'i'],
  [0x039a, 'k'], [0x039c, 'm'], [0x039d, 'n'], [0x039f, 'o'], [0x03a1, 'p'], [0x03a4, 't'],
  [0x03a5, 'y'], [0x03a7, 'x'],
];
const CONFUSABLES = new Map(CONFUSABLE_PAIRS.map(([cp, latin]) => [String.fromCodePoint(cp), latin]));

/** Fold text so look-alike letters, accents, punctuation and odd spacing cannot break a match. */
export function foldName(raw) {
  return String(raw ?? '')
    .normalize('NFKD') // 𝙎𝙖𝙝𝙞𝙡 -> Sahil, splits accents off their letters
    .replace(/\p{M}/gu, '') // drop the accent marks
    .replace(/./gu, (ch) => CONFUSABLES.get(ch) ?? ch)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ') // dots, dashes and @ become spaces; emails are matched exactly, never here
    .replace(/\s+/g, ' ')
    .trim();
}

// Meeting bots, checked on the folded name.
const NON_HUMAN = /\b(notetaker|note taker|fireflies( ai)?|otter( ai)?|read ai|fathom|tl ?dv|meetgeek|zoom ai companion)\b/;
// The feedback.flashfire@gmail.com Calendly user. It is not a person (open decision D8).
const SHARED = /^(flashfire|flash fire)$/;

export const isNonHuman = (name) => NON_HUMAN.test(foldName(name));
export const isShared = (name) => SHARED.test(foldName(name));

function escapeRe(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * One word-boundary regex per BDA, built from the first name.
 * Matches "Kalpataru", "Kalpataru S", "Kalpataru Samal", "Samal Kalpataru", "kalpataru.samal".
 * Never matches "Kalpataruu", and never a name that only contains the letters.
 * Run it on a folded name.
 */
export function bdaNameRegex(profile) {
  const first = escapeRe(foldName(profile?.firstName));
  if (!first) return null;
  return new RegExp(`(^|\\s)${first}(\\s|$)`);
}

const normEmail = (e) => String(e ?? '').trim().toLowerCase();
const normId = (v) => String(v ?? '').trim();

// Order matters: the first hint field that matches a profile decides.
const STABLE_ID_FIELDS = [
  ['email', 'email', normEmail, 'email'],
  ['calendlyUserUri', 'calendlyUserUri', normId, 'calendly'],
  ['zoomUserId', 'zoomUserId', normId, 'zoom'],
  ['googleUserId', 'googleUserId', normId, 'google'],
];

/** Names a profile answers to exactly, besides its explicit aliases. */
function fullNameKeys(profile) {
  const first = foldName(profile.firstName);
  const last = foldName(profile.lastName);
  const keys = [foldName(profile.displayName), first];
  if (first && last) keys.push(`${first} ${last}`, `${last} ${first}`);
  return keys.filter(Boolean);
}

function canBeNameMatched(profile) {
  return profile && profile.active !== false && profile.tracked !== false;
}

/**
 * Resolve any identity hint to one registry BDA.
 * hint = { email?, calendlyUserUri?, zoomUserId?, googleUserId?, name? }
 * Returns { bda, via } with via one of email|calendly|zoom|google|alias|name, or null when unknown.
 * Callers log the null case (BdaRegistry.logUnknownName) so an admin can add an alias.
 */
export function resolveBda(hint, registry) {
  const profiles = Array.isArray(registry) ? registry.filter(Boolean) : [];
  if (!hint || profiles.length === 0) return null;

  // a) Stable IDs: exact match, done. An ID beats whatever name came with it.
  for (const [hintKey, profileKey, norm, via] of STABLE_ID_FIELDS) {
    const wanted = norm(hint[hintKey]);
    if (!wanted) continue;
    const bda = profiles.find((p) => norm(p[profileKey]) === wanted);
    if (bda) return { bda, via };
  }

  // b) Name fallback. Bots and the shared account never reach it.
  const folded = foldName(hint.name);
  if (!folded || isNonHuman(folded) || isShared(folded)) return null;

  const candidates = profiles.filter(canBeNameMatched);

  // Explicit alias wins; two profiles claiming the same alias means unknown.
  const aliasHits = candidates.filter((p) => (p.aliases || []).some((a) => foldName(a) === folded));
  if (aliasHits.length === 1) return { bda: aliasHits[0], via: 'alias' };
  if (aliasHits.length > 1) return null;

  // Exact display or full name next.
  const exactHits = candidates.filter((p) => fullNameKeys(p).includes(folded));
  if (exactHits.length === 1) return { bda: exactHits[0], via: 'name' };
  if (exactHits.length > 1) return null;

  // Finally the first-name regex, which must hit exactly one BDA.
  const regexHits = candidates.filter((p) => {
    const re = bdaNameRegex(p);
    return re && re.test(folded);
  });
  if (regexHits.length === 1) return { bda: regexHits[0], via: 'name' };
  return null;
}

/** True when a match was made by a stable ID, the only kind allowed to decide a verdict (plan 2.8). */
export const isStableVia = (via) => ['email', 'calendly', 'zoom', 'google'].includes(via);
