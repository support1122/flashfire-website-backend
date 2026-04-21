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
 * Audit every utmSource / utmMedium / utmCampaign value across the Campaign collection
 * and CampaignBooking collection, flagging anything that will cause the CRM exact-match
 * filter to misbehave:
 *
 *   1. Whitespace anywhere (leading/trailing/internal extra spaces)
 *   2. URL-encoding artifacts (%20, +, %2F, etc.)
 *   3. Case-only differences between Campaign-registered and booking values
 *      (e.g. Campaign has "Instagram", booking has "instagram")
 *   4. Campaign-registered values with zero matching bookings (dead dropdown entries)
 *   5. Booking values not registered as a Campaign (orphans — OK now that dropdown
 *      pulls from booking distincts, but worth knowing)
 */

const UTM_FIELDS = ['utmSource', 'utmMedium', 'utmCampaign'];

function flagsFor(value) {
  const flags = [];
  if (typeof value !== 'string') return flags;
  if (value !== value.trim()) flags.push('whitespace-edges');
  if (/\s{2,}/.test(value)) flags.push('double-space');
  if (/%[0-9A-Fa-f]{2}/.test(value)) flags.push('url-encoded');
  if (/\+/.test(value) && !value.includes(' ')) flags.push('contains-plus');
  return flags;
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected\n');

  // Pull raw distincts (no trimming, no filtering) so we can see the DB as-is.
  const [bookingDistincts, registeredCampaigns] = await Promise.all([
    Promise.all(
      UTM_FIELDS.map((f) =>
        CampaignBookingModel.distinct(f).then((arr) => arr.filter((v) => typeof v === 'string'))
      )
    ),
    CampaignModel.find({}).select('campaignName utmSource utmMedium utmCampaign').lean(),
  ]);

  const [sourcesInBookings, mediumsInBookings, campaignsInBookings] = bookingDistincts;

  // --- 1. Value-level hygiene flags ---
  console.log('=== Value hygiene flags ===');
  for (const [field, values] of [
    ['utmSource', sourcesInBookings],
    ['utmMedium', mediumsInBookings],
    ['utmCampaign', campaignsInBookings],
  ]) {
    for (const v of values) {
      const flags = flagsFor(v);
      if (flags.length) {
        console.log(`  [${field}] "${v}" -> ${flags.join(', ')}`);
      }
    }
  }
  for (const rc of registeredCampaigns) {
    for (const f of UTM_FIELDS) {
      const flags = flagsFor(rc[f]);
      if (flags.length) {
        console.log(`  [Campaign.${f}] "${rc[f]}" (campaignName="${rc.campaignName}") -> ${flags.join(', ')}`);
      }
    }
  }

  // --- 2. Case-only differences (booking vs Campaign) ---
  console.log('\n=== Case-only differences between Campaign doc and booking values ===');
  for (const f of UTM_FIELDS) {
    const bookingValues = await CampaignBookingModel.distinct(f);
    const registeredValues = registeredCampaigns
      .map((c) => c[f])
      .filter((v) => typeof v === 'string' && v.trim() !== '');

    const lowerToBooking = new Map();
    for (const v of bookingValues) {
      if (typeof v !== 'string' || !v.trim()) continue;
      lowerToBooking.set(v.toLowerCase(), (lowerToBooking.get(v.toLowerCase()) || new Set()).add(v));
    }
    for (const rv of registeredValues) {
      const hits = lowerToBooking.get(rv.toLowerCase());
      if (!hits) continue;
      const exact = hits.has(rv);
      const variants = [...hits].filter((v) => v !== rv);
      if (!exact && variants.length) {
        console.log(`  [${f}] Campaign="${rv}" vs Booking=${JSON.stringify(variants)}`);
      } else if (exact && variants.length) {
        console.log(`  [${f}] Campaign="${rv}" also appears as ${JSON.stringify(variants)} on bookings`);
      }
    }
  }

  // --- 3. Dead dropdown entries: Campaign-registered value with zero booking match ---
  console.log('\n=== Registered Campaign values with ZERO matching bookings ===');
  for (const rc of registeredCampaigns) {
    for (const f of UTM_FIELDS) {
      const v = rc[f];
      if (typeof v !== 'string' || !v.trim()) continue;
      const count = await CampaignBookingModel.countDocuments({ [f]: v });
      if (count === 0) {
        console.log(`  [${f}] "${v}" (campaignName="${rc.campaignName}") -> 0 bookings`);
      }
    }
  }

  // --- 4. Booking values not registered anywhere ---
  console.log('\n=== Booking values NOT registered in any Campaign doc (informational) ===');
  for (const f of UTM_FIELDS) {
    const bookingValues = await CampaignBookingModel.distinct(f);
    const registeredSet = new Set(
      registeredCampaigns.map((c) => c[f]).filter((v) => typeof v === 'string' && v.trim())
    );
    const orphans = bookingValues
      .filter((v) => typeof v === 'string' && v.trim() !== '' && !registeredSet.has(v));
    console.log(`  [${f}] ${orphans.length} orphan(s)`);
    orphans.slice(0, 20).forEach((v) => console.log(`    "${v}"`));
    if (orphans.length > 20) console.log(`    ... +${orphans.length - 20} more`);
  }

  await mongoose.disconnect();
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
