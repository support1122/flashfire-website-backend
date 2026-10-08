import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  foldName,
  isNonHuman,
  isShared,
  bdaNameRegex,
  resolveBda,
  isStableVia,
} from '../Utils/BdaIdentity.js';

// Pure functions, no database. Table comes from plan section 2.8 (Tests).

const SIDDHARTHA = {
  email: 'siddhartha@flashfirehq.com',
  displayName: 'Siddhartha',
  firstName: 'siddhartha',
  lastName: 'basaveni',
  aliases: ['siddhartha b', 'basaveni siddhartha'],
  calendlyUserUri: 'https://api.calendly.com/users/74015a2f-aaaa',
  zoomUserId: 'zoom-sid-1',
  googleUserId: 'users/111',
  active: true,
  tracked: true,
};
const KALPATARU = {
  email: 'kalpataru@flashfirehq.com',
  displayName: 'Kalpataru',
  firstName: 'kalpataru',
  lastName: 'samal',
  aliases: ['kalpataru s', 'kalpataru samal'],
  calendlyUserUri: 'https://api.calendly.com/users/0bf32c7c-bbbb',
  zoomUserId: 'zoom-kal-1',
  googleUserId: 'users/222',
  active: true,
  tracked: true,
};
const REGISTRY = [SIDDHARTHA, KALPATARU];

// Cyrillic look-alikes, written as escapes so this file stays readable: o, e, a, e.
const CYRILLIC_NOTETAKER = 'Calendly Nоtеtаkеr';

const emailOf = (hint) => resolveBda(hint, REGISTRY)?.bda.email ?? null;

describe('foldName', () => {
  it('lowercases, strips accents and collapses punctuation and spacing', () => {
    assert.equal(foldName('  Siddhartha.B  '), 'siddhartha b');
    assert.equal(foldName('Kalpatarú   S'), 'kalpataru s');
    assert.equal(foldName(null), '');
  });

  it('turns fancy unicode forms into plain letters', () => {
    assert.equal(foldName('\u{1D5E6}\u{1D5EE}\u{1D5F5}\u{1D5F6}\u{1D5F9}'), 'sahil');
  });

  it('maps Cyrillic and Greek look-alikes to Latin', () => {
    assert.equal(foldName(CYRILLIC_NOTETAKER), 'calendly notetaker');
    assert.equal(foldName('Kαlpαtαru'), 'kalpataru');
  });
});

describe('bots and shared accounts', () => {
  it('flags the Cyrillic Calendly Notetaker as non-human', () => {
    assert.equal(/notetaker/i.test(CYRILLIC_NOTETAKER), false, 'sanity: plain regex misses the look-alike');
    assert.equal(isNonHuman(CYRILLIC_NOTETAKER), true);
    assert.equal(resolveBda({ name: CYRILLIC_NOTETAKER }, REGISTRY), null);
  });

  it('flags Fireflies with a client name as non-human, never a BDA or the client', () => {
    const name = 'Fireflies.ai Notetaker Hemanth Dasu';
    assert.equal(isNonHuman(name), true);
    assert.equal(resolveBda({ name }, REGISTRY), null);
  });

  it('flags FLASHFIRE as the shared account, never a BDA', () => {
    assert.equal(isShared('FLASHFIRE'), true);
    assert.equal(isShared('Flash Fire'), true);
    assert.equal(isNonHuman('FLASHFIRE'), false);
    assert.equal(resolveBda({ name: 'FLASHFIRE' }, REGISTRY), null);
  });

  it('does not flag real people', () => {
    assert.equal(isNonHuman('Kalpataru S'), false);
    assert.equal(isShared('Kalpataru S'), false);
    assert.equal(isNonHuman('Hemanth Dasu'), false);
  });
});

describe('resolveBda by name', () => {
  it('maps every Siddhartha spelling to Siddhartha', () => {
    for (const name of ['siddhartha b', 'Basaveni siddhartha', 'SIDDHARTHA', 'siddhartha.b']) {
      assert.equal(emailOf({ name }), SIDDHARTHA.email, name);
    }
  });

  it('maps every Kalpataru spelling to Kalpataru', () => {
    for (const name of ['Kalpataru S', 'Kalpataru Samal', 'kalpataru']) {
      assert.equal(emailOf({ name }), KALPATARU.email, name);
    }
  });

  it('reports explicit aliases as alias and other name hits as name', () => {
    assert.equal(resolveBda({ name: 'siddhartha b' }, REGISTRY).via, 'alias');
    assert.equal(resolveBda({ name: 'SIDDHARTHA' }, REGISTRY).via, 'name');
  });

  it('treats near misses as unknown', () => {
    assert.equal(resolveBda({ name: 'Kalpataruu' }, REGISTRY), null);
    assert.equal(resolveBda({ name: 'Siddharthan Rao' }, REGISTRY), null);
    assert.equal(resolveBda({ name: '' }, REGISTRY), null);
    assert.equal(resolveBda({}, REGISTRY), null);
  });

  it('matches a client named Siddhartha to Siddhartha, so it cannot count as Kalpataru', () => {
    const hit = resolveBda({ name: 'Siddhartha Mehta' }, REGISTRY);
    assert.equal(hit.bda.email, SIDDHARTHA.email);
    assert.equal(hit.via, 'name');
    assert.equal(isStableVia(hit.via), false);
  });

  it('refuses an ambiguous name that hits two BDAs', () => {
    assert.equal(resolveBda({ name: 'Siddhartha Kalpataru' }, REGISTRY), null);
  });

  it('refuses an alias claimed by two profiles', () => {
    const twin = { ...KALPATARU, email: 'twin@flashfirehq.com', firstName: 'twin', aliases: ['siddhartha b'] };
    assert.equal(resolveBda({ name: 'siddhartha b' }, [SIDDHARTHA, twin]), null);
  });

  it('ignores untracked and inactive profiles for name matching', () => {
    const untracked = { ...KALPATARU, tracked: false };
    assert.equal(resolveBda({ name: 'kalpataru' }, [SIDDHARTHA, untracked]), null);
    const left = { ...KALPATARU, active: false };
    assert.equal(resolveBda({ name: 'kalpataru' }, [SIDDHARTHA, left]), null);
  });

  it('a third BDA with a clashing first name fails safe', () => {
    const second = { ...SIDDHARTHA, email: 'siddhartha.k@flashfirehq.com', lastName: 'kumar', aliases: [] };
    assert.equal(resolveBda({ name: 'Siddhartha' }, [SIDDHARTHA, second]), null);
    // and the fix is a surname alias
    const fixed = { ...second, aliases: ['siddhartha k'] };
    assert.equal(resolveBda({ name: 'siddhartha k' }, [SIDDHARTHA, fixed]).bda.email, fixed.email);
  });
});

describe('resolveBda by stable ID', () => {
  it('email beats name', () => {
    const hit = resolveBda({ email: 'kalpataru@flashfirehq.com', name: 'X' }, REGISTRY);
    assert.equal(hit.bda.email, KALPATARU.email);
    assert.equal(hit.via, 'email');
  });

  it('email beats a name that points at someone else', () => {
    const hit = resolveBda({ email: 'kalpataru@flashfirehq.com', name: 'Siddhartha' }, REGISTRY);
    assert.equal(hit.bda.email, KALPATARU.email);
  });

  it('matches emails case-insensitively and trimmed', () => {
    assert.equal(emailOf({ email: '  Kalpataru@FlashfireHQ.com ' }), KALPATARU.email);
  });

  it('matches Calendly URI, Zoom user ID and Google user ID', () => {
    assert.deepEqual(
      [
        resolveBda({ calendlyUserUri: SIDDHARTHA.calendlyUserUri }, REGISTRY).via,
        resolveBda({ zoomUserId: KALPATARU.zoomUserId }, REGISTRY).via,
        resolveBda({ googleUserId: 'users/111' }, REGISTRY).via,
      ],
      ['calendly', 'zoom', 'google']
    );
    assert.equal(emailOf({ googleUserId: 'users/222' }), KALPATARU.email);
  });

  it('prefers email over the other IDs when they disagree', () => {
    const hit = resolveBda({ email: SIDDHARTHA.email, zoomUserId: KALPATARU.zoomUserId }, REGISTRY);
    assert.equal(hit.bda.email, SIDDHARTHA.email);
  });

  it('stable IDs still resolve an untracked profile (the caller decides what counts)', () => {
    const untracked = { ...KALPATARU, tracked: false };
    assert.equal(resolveBda({ email: KALPATARU.email }, [untracked]).bda.email, KALPATARU.email);
  });

  it('only stable vias may decide a verdict', () => {
    for (const via of ['email', 'calendly', 'zoom', 'google']) assert.equal(isStableVia(via), true);
    for (const via of ['alias', 'name']) assert.equal(isStableVia(via), false);
  });

  it('returns null for an empty registry or unknown ID', () => {
    assert.equal(resolveBda({ email: KALPATARU.email }, []), null);
    assert.equal(resolveBda({ email: 'nobody@example.com' }, REGISTRY), null);
    assert.equal(resolveBda({ email: KALPATARU.email }, undefined), null);
  });
});

describe('bdaNameRegex', () => {
  it('matches the first name on word boundaries only', () => {
    const re = bdaNameRegex(KALPATARU);
    for (const ok of ['kalpataru', 'kalpataru s', 'samal kalpataru', 'a kalpataru b']) {
      assert.ok(re.test(ok), ok);
    }
    for (const bad of ['kalpataruu', 'xkalpataru', 'kalpatar']) {
      assert.equal(re.test(bad), false, bad);
    }
  });

  it('returns null when the profile has no usable first name', () => {
    assert.equal(bdaNameRegex({ firstName: '' }), null);
    assert.equal(bdaNameRegex({ firstName: '(.*)' }), null);
    assert.equal(bdaNameRegex({}), null);
  });
});
