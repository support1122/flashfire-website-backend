// The BDAs the system tracks from day one (plan 2.8), and the idempotent seeding of them.
// Used by POST /api/crm/admin/attendance/setup/seed-profiles and by scripts/seed-bda-profiles.js, so the route and
// the script can never drift apart.
import { BdaProfileModel } from '../Schema_Models/BdaProfile.js';
import { invalidateRegistryCache } from './BdaRegistry.js';

export const SEED_PROFILES = Object.freeze([
  {
    email: 'siddhartha@flashfirehq.com',
    displayName: 'Siddhartha',
    firstName: 'siddhartha',
    lastName: 'basaveni',
    aliases: ['siddhartha b', 'basaveni siddhartha'],
  },
  {
    email: 'kalpataru@flashfirehq.com',
    displayName: 'Kalpataru',
    firstName: 'kalpataru',
    lastName: 'samal',
    aliases: ['kalpataru s', 'kalpataru samal'],
  },
]);

/**
 * Work out what seeding would do to each profile, from the database as it is right now. Read-only.
 *   create     the profile does not exist yet
 *   update     it exists but is missing some seed aliases
 *   unchanged  it exists and has every seed alias
 * Existing profiles are never overwritten apart from adding missing aliases: an admin who switched `tracked` off,
 * set a Discord id, or added leave days keeps all of it, and IDs the system learned (Google, Zoom) are untouched.
 */
export async function planSeed() {
  const existing = await BdaProfileModel.find({ email: { $in: SEED_PROFILES.map((s) => s.email) } }).lean();
  const byEmail = new Map(existing.map((p) => [p.email, p]));
  return SEED_PROFILES.map((seed) => {
    const found = byEmail.get(seed.email);
    if (!found) return { email: seed.email, action: 'create', addAliases: [...seed.aliases], tracked: true };
    const missing = seed.aliases.filter((a) => !(found.aliases || []).includes(a));
    return {
      email: seed.email,
      action: missing.length ? 'update' : 'unchanged',
      addAliases: missing,
      tracked: Boolean(found.tracked),
    };
  });
}

/**
 * Write the seed. Safe to run any number of times. Only profiles the plan says need a change are written, so a repeat
 * run touches nothing (a blind update would bump updatedAt every time and report "updated" for no real change).
 */
export async function applySeed() {
  const plan = await planSeed();
  const results = [];
  for (const step of plan) {
    if (step.action === 'unchanged') {
      results.push({ email: step.email, action: 'unchanged' });
      continue;
    }
    const seed = SEED_PROFILES.find((s) => s.email === step.email);
    const { aliases, email, ...identity } = seed;
    // $setOnInsert so an existing profile keeps its tracked and active flags and every field an admin edited.
    await BdaProfileModel.updateOne(
      { email },
      {
        $setOnInsert: { email, ...identity, tracked: true, active: true },
        $addToSet: { aliases: { $each: aliases } },
      },
      { upsert: true }
    );
    results.push({ email, action: step.action === 'create' ? 'created' : 'updated' });
  }
  invalidateRegistryCache();
  return results;
}
