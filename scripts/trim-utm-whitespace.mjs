import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '..', '.env') });

import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';
import { CampaignModel } from '../Schema_Models/Campaign.js';

/**
 * Strip leading/trailing whitespace from utm* fields on CampaignBooking and Campaign docs.
 *
 * Only touches records that actually have whitespace — unaffected docs are left alone.
 *
 *   node scripts/trim-utm-whitespace.mjs           # dry-run
 *   node scripts/trim-utm-whitespace.mjs --apply   # apply
 */

const APPLY = process.argv.includes('--apply');
const UTM_FIELDS = ['utmSource', 'utmMedium', 'utmCampaign', 'utmContent', 'utmTerm'];
const WHITESPACE_REGEX = /^\s|\s$/;

async function processCollection(Model, label) {
  console.log(`\n=== ${label} ===`);
  const orConditions = UTM_FIELDS.map((f) => ({ [f]: { $regex: WHITESPACE_REGEX } }));
  const matches = await Model.find({ $or: orConditions }).lean();
  console.log(`Found ${matches.length} doc(s) with whitespace in utm fields`);

  let changes = 0;
  for (const doc of matches) {
    const $set = {};
    for (const f of UTM_FIELDS) {
      if (typeof doc[f] === 'string' && WHITESPACE_REGEX.test(doc[f])) {
        const trimmed = doc[f].trim();
        $set[f] = trimmed === '' ? null : trimmed;
      }
    }
    if (Object.keys($set).length === 0) continue;
    changes++;

    const id = doc.bookingId || doc.campaignId || doc._id;
    console.log(`  [${id}]`, Object.fromEntries(
      Object.entries($set).map(([k, v]) => [k, `"${doc[k]}" -> "${v}"`])
    ));

    if (APPLY) {
      // Bypass Mongoose middleware to avoid double-trim / hook side effects; direct
      // $set is sufficient and deterministic here.
      await Model.collection.updateOne({ _id: doc._id }, { $set });
    }
  }
  console.log(`Updates needed: ${changes}`);
  console.log(APPLY ? 'Applied.' : '(dry-run)');
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY-RUN'}`);

  await processCollection(CampaignBookingModel, 'CampaignBooking');
  await processCollection(CampaignModel, 'Campaign');

  await mongoose.disconnect();
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
