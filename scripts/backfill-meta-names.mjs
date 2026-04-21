import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '..', '.env') });

import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';

/**
 * Populate metaCampaignName / metaAdName / metaAdsetName / metaPlatform / metaIsOrganic /
 * metaLeadStatus from existing metaRawData on CampaignBooking docs.
 *
 * By default (safe): only fills fields that are currently null/empty. Does NOT overwrite
 * existing utmCampaign/utmSource values.
 *
 * Pass --rewrite-utm to additionally overwrite utmCampaign from `meta_ad_*` to the human
 * campaign name, and utmSource from `meta_lead_ad` to the actual platform.
 *
 * Run:
 *   node scripts/backfill-meta-names.mjs                    # dry-run, names-only
 *   node scripts/backfill-meta-names.mjs --apply            # apply, names-only
 *   node scripts/backfill-meta-names.mjs --apply --rewrite-utm   # also rewrite utm
 */

const APPLY = process.argv.includes('--apply');
const REWRITE_UTM = process.argv.includes('--rewrite-utm');

function asBool(v) {
  if (typeof v === 'boolean') return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return null;
}

async function main() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI missing');
  await mongoose.connect(process.env.MONGODB_URI);
  console.log(`Connected. Mode: ${APPLY ? 'APPLY' : 'DRY-RUN'}\n`);

  const cursor = CampaignBookingModel.find({
    leadSource: 'meta_lead_ad',
    metaRawData: { $ne: null },
  }).lean().cursor();

  let scanned = 0;
  let toUpdate = 0;
  let updated = 0;

  for await (const doc of cursor) {
    scanned++;
    const raw = doc.metaRawData || {};
    const nameCandidates = {
      metaCampaignName: raw.campaign_name || null,
      metaAdName: raw.ad_name || null,
      metaAdsetName: raw.adset_name || null,
      metaPlatform: raw.platform || null,
      metaIsOrganic: asBool(raw.is_organic),
      metaLeadStatus: raw.lead_status || null,
    };

    const $set = {};
    for (const [k, v] of Object.entries(nameCandidates)) {
      if (v == null) continue;
      if (doc[k] == null || doc[k] === '') $set[k] = v;
    }

    if (REWRITE_UTM) {
      // Rewrite utmCampaign from meta_ad_* to the real campaign name if we have one
      if (
        nameCandidates.metaCampaignName &&
        typeof doc.utmCampaign === 'string' &&
        /^meta_ad_/.test(doc.utmCampaign)
      ) {
        $set.utmCampaign = nameCandidates.metaCampaignName;
      }
      // Also rewrite utmSource if still generic
      if (
        nameCandidates.metaPlatform &&
        (doc.utmSource === 'meta_lead_ad' || !doc.utmSource)
      ) {
        $set.utmSource = nameCandidates.metaPlatform;
      }
    }

    if (Object.keys($set).length === 0) continue;
    toUpdate++;

    if (scanned <= 5 || toUpdate <= 10) {
      console.log(`[${doc.bookingId}] ${doc.clientEmail} -> ${JSON.stringify($set)}`);
    }

    if (APPLY) {
      await CampaignBookingModel.updateOne({ _id: doc._id }, { $set });
      updated++;
    }
  }

  console.log(`\nScanned: ${scanned}`);
  console.log(`Need update: ${toUpdate}`);
  console.log(`Updated: ${updated}`);
  if (!APPLY) console.log('\n(dry-run — re-run with --apply to persist)');

  await mongoose.disconnect();
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
