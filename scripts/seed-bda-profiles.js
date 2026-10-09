/**
 * Seed the BDA registry (plan 2.8). The same logic is exposed as an admin route,
 * POST /api/crm/admin/attendance/setup/seed-profiles, which is the preferred way to run it.
 *
 *   node scripts/seed-bda-profiles.js            # DRY RUN: prints what would be written, touches no database
 *   node scripts/seed-bda-profiles.js --apply    # writes to the database MONGODB_URI points at
 *
 * --apply needs bsc's OK: the local .env points at the production database. The script prints the database
 * name before it writes. Re-running is safe (see Utils/BdaSeed.js).
 */
import { SEED_PROFILES } from '../Utils/BdaSeed.js';

const apply = process.argv.includes('--apply');

if (!apply) {
  console.log('DRY RUN. Would ensure these BDA profiles exist (no database was contacted):');
  for (const s of SEED_PROFILES) console.log(`  ${s.email}  ${s.displayName}  aliases: ${s.aliases.join(', ')}  tracked: true`);
  console.log('Run with --apply to write them.');
  process.exit(0);
}

const { default: dotenv } = await import('dotenv');
dotenv.config({ quiet: true });
const { default: mongoose } = await import('mongoose');
const { applySeed } = await import('../Utils/BdaSeed.js');

const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
if (!uri) {
  console.error('No MONGODB_URI or MONGO_URI in the environment');
  process.exit(1);
}
try {
  await mongoose.connect(uri);
  console.log(`Connected to database "${mongoose.connection.name}"`);
  for (const r of await applySeed()) console.log(`  ${r.email}: ${r.action}`);
} catch (err) {
  console.error('Seed failed:', err?.message);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
