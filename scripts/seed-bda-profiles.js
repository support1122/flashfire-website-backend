/**
 * Seed the BDA registry with the two tracked BDAs (plan 2.8).
 *
 *   node scripts/seed-bda-profiles.js            # DRY RUN: prints what would be written, touches no database
 *   node scripts/seed-bda-profiles.js --apply    # writes to the database MONGODB_URI points at
 *
 * --apply needs bsc's OK: the local .env points at the production database. The script prints the database
 * name before it writes. Re-running is safe: aliases are merged, and IDs the system learned on its own
 * (googleUserId, zoomUserId, discordUserId, leaveDays, calendlyUserUri) are never overwritten.
 */
const SEED = [
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
];

const apply = process.argv.includes('--apply');

function describe(seed) {
  return `${seed.email}  ${seed.displayName} (${seed.firstName} ${seed.lastName})  aliases: ${seed.aliases.join(', ')}  tracked: true  active: true`;
}

if (!apply) {
  console.log('DRY RUN. Would upsert these BDA profiles (no database was contacted):');
  for (const seed of SEED) console.log(`  ${describe(seed)}`);
  console.log('Run with --apply to write them.');
  process.exit(0);
}

const { default: dotenv } = await import('dotenv');
dotenv.config({ quiet: true });
const { default: mongoose } = await import('mongoose');
const { BdaProfileModel } = await import('../Schema_Models/BdaProfile.js');

const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
if (!uri) {
  console.error('No MONGODB_URI or MONGO_URI in the environment');
  process.exit(1);
}

try {
  await mongoose.connect(uri);
  console.log(`Connected to database "${mongoose.connection.name}"`);
  for (const seed of SEED) {
    const { aliases, ...identity } = seed;
    const res = await BdaProfileModel.updateOne(
      { email: seed.email },
      {
        $set: { ...identity, tracked: true, active: true },
        $addToSet: { aliases: { $each: aliases } },
      },
      { upsert: true }
    );
    const verdict = res.upsertedCount ? 'created' : res.modifiedCount ? 'updated' : 'unchanged';
    console.log(`  ${seed.email}: ${verdict}`);
  }
} catch (err) {
  console.error('Seed failed:', err?.message);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
