/**
 * Backfill CampaignBooking.originalBda — the first BDA a lead was ever assigned to.
 *
 * Why: calendlyHost is overwritten every time a client rebooks, so a lead that was
 * cancelled and re-booked shows whoever hosts the LATEST meeting. Credit (Graphs 03,
 * paid conversions) followed that field, so the original BDA silently lost the lead.
 * originalBda is write-once; this script fills it for everything that already exists.
 *
 * Source of truth, best first:
 *   1. Earliest `invitee.created` webhook log for the booking — the real first host,
 *      even when calendlyHost has since been re-rolled.
 *   2. Current calendlyHost — correct for every lead that never rebooked.
 *   3. claimedBy — leads that only ever had a manual claim.
 *
 * Never overwrites an existing originalBda.
 *
 * Usage:
 *   node Scripts/backfill-original-bda.js            # dry run, prints what it would do
 *   node Scripts/backfill-original-bda.js --apply    # writes
 */
import dotenv from 'dotenv';
dotenv.config();
import mongoose from 'mongoose';

const APPLY = process.argv.includes('--apply');

async function main() {
  await mongoose.connect(process.env.MONGODB_URI || process.env.MONGO_URI);
  const db = mongoose.connection.db;
  const bookings = db.collection('campaignbookings');
  const logs = db.collection('calendlywebhooklogs');

  // 1. Earliest archived host per booking.
  const firstHostByBooking = new Map();
  const cursor = logs.find(
    { eventType: 'invitee.created', bookingId: { $nin: [null, ''] } },
    { projection: { bookingId: 1, createdAt: 1, 'payload.scheduled_event.event_memberships': 1 } },
  ).sort({ createdAt: 1 });
  for await (const log of cursor) {
    const membership = log.payload?.scheduled_event?.event_memberships?.[0];
    const email = String(membership?.user_email || '').toLowerCase().trim();
    if (!email) continue;
    // sorted oldest-first, so the first one wins
    if (!firstHostByBooking.has(log.bookingId)) {
      firstHostByBooking.set(log.bookingId, { email, name: membership?.user_name || null, at: log.createdAt });
    }
  }

  const todo = await bookings.find(
    {
      $or: [
        { 'originalBda.email': { $exists: false } },
        { 'originalBda.email': null },
        { 'originalBda.email': '' },
      ],
    },
    { projection: { bookingId: 1, calendlyHost: 1, claimedBy: 1, bookingCreatedAt: 1, bookingStatus: 1 } },
  ).toArray();

  const stats = { archive: 0, host: 0, claim: 0, none: 0, corrected: 0 };
  const corrections = [];
  const ops = [];

  for (const b of todo) {
    const archived = firstHostByBooking.get(b.bookingId);
    let patch = null;

    if (archived?.email) {
      patch = { email: archived.email, name: archived.name, source: 'backfill', assignedAt: archived.at || b.bookingCreatedAt || null };
      stats.archive++;
      const current = String(b.calendlyHost?.email || '').toLowerCase().trim();
      if (current && current !== archived.email) {
        stats.corrected++;
        corrections.push({ bookingId: b.bookingId, status: b.bookingStatus, was: current, now: archived.email });
      }
    } else if (b.calendlyHost?.email) {
      patch = { email: b.calendlyHost.email, name: b.calendlyHost.name || null, source: 'backfill', assignedAt: b.bookingCreatedAt || null };
      stats.host++;
    } else if (b.claimedBy?.email) {
      patch = { email: b.claimedBy.email, name: b.claimedBy.name || null, source: 'backfill', assignedAt: b.claimedBy.claimedAt || null };
      stats.claim++;
    } else {
      stats.none++;
      continue;
    }

    ops.push({
      updateOne: {
        // Re-assert "still unowned" so a concurrent write can never be clobbered.
        filter: {
          bookingId: b.bookingId,
          $or: [
            { 'originalBda.email': { $exists: false } },
            { 'originalBda.email': null },
            { 'originalBda.email': '' },
          ],
        },
        update: { $set: { originalBda: { ...patch, calendlyUserUri: null } } },
      },
    });
  }

  console.log(`candidates without originalBda : ${todo.length}`);
  console.log(`  from webhook archive (exact) : ${stats.archive}`);
  console.log(`  from current calendlyHost    : ${stats.host}`);
  console.log(`  from claimedBy               : ${stats.claim}`);
  console.log(`  no owner anywhere (skipped)  : ${stats.none}`);
  console.log(`  ATTRIBUTION CORRECTED        : ${stats.corrected}`);
  corrections.forEach((c) => console.log(`     ${c.bookingId} [${c.status}] ${c.was} -> ${c.now}`));

  if (!APPLY) {
    console.log('\nDRY RUN — nothing written. Re-run with --apply to write.');
  } else if (ops.length) {
    const res = await bookings.bulkWrite(ops, { ordered: false });
    console.log(`\napplied: ${res.modifiedCount} booking(s) updated`);
  }

  await mongoose.disconnect();
}

main().catch((err) => { console.error(err); process.exit(1); });
