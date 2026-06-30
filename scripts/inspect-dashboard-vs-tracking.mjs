// Compare the Paid source (CLIENTS_TRACKING_MONGODB_URI) vs the live dashboard DB.
// Run: node scripts/inspect-dashboard-vs-tracking.mjs
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

dotenv.config();

// Pull the live dashboard URI straight from the dashboard backend .env.
function readEnv(file, key) {
  try {
    const txt = fs.readFileSync(file, 'utf8');
    const m = txt.match(new RegExp(`^${key}\\s*=\\s*"?([^"\\n]+)"?`, 'm'));
    return m && m[1].trim();
  } catch { return null; }
}

const TRACKING = process.env.CLIENTS_TRACKING_MONGODB_URI;
const DASHBOARD = readEnv(
  path.resolve('../../DASH/flashfire-dashboard-backend-main/.env'),
  'MONGODB_URI'
);

async function inspect(label, uri) {
  if (!uri) { console.log(`\n### ${label}: NO URI`); return; }
  const c = await mongoose.createConnection(uri).asPromise();
  const db = c.db;
  console.log(`\n### ${label}`);
  console.log('db name :', db.databaseName);
  const cols = (await db.listCollections().toArray()).map((x) => x.name);
  console.log('collections:', cols.join(', '));
  if (!cols.includes('users')) { await c.close(); return; }
  const users = db.collection('users');
  const total = await users.countDocuments();
  console.log('users total :', total);

  const byPlan = await users.aggregate([
    { $group: { _id: '$planType', n: { $sum: 1 } } }, { $sort: { n: -1 } },
  ]).toArray();
  console.log('by planType :', byPlan.map((p) => `${p._id || '(none)'}=${p.n}`).join('  '));

  // monthly counts: ALL users vs paid-only (planType != Free Trial), by createdAt
  const monthly = await users.aggregate([
    { $group: {
      _id: { $dateToString: { format: '%Y-%m', date: '$createdAt' } },
      all: { $sum: 1 },
      paid: { $sum: { $cond: [{ $in: ['$planType', [null, '', 'Free Trial']] }, 0, 1] } },
    } },
    { $sort: { _id: 1 } },
  ]).toArray();
  console.log('monthly (month: allUsers / paidOnly):');
  for (const m of monthly) console.log(`  ${m._id}:  all=${m.all}  paid=${m.paid}`);

  await c.close();
}

await inspect('CLIENTS_TRACKING (current Paid source)', TRACKING);
await inspect('LIVE DASHBOARD', DASHBOARD);
await mongoose.disconnect();
process.exit(0);
