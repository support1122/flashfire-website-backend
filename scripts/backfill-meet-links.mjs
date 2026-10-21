/**
 * Fill missing Google Meet links on upcoming bookings from Calendly.
 *
 *   node scripts/backfill-meet-links.mjs            # DRY RUN, prints what would change
 *   node scripts/backfill-meet-links.mjs --apply    # writes
 *
 * A booking taken while its host had no Meet connected stores "Not Provided", and
 * Calendly sends no webhook when the link is added later. This asks Calendly for each
 * upcoming booking's current join_url and writes it to the booking plus its pending
 * WhatsApp, Discord and call reminders. Bookings Calendly still has no link for are
 * left alone and listed, so the host can fix them in Calendly.
 *
 * Only touches: calendlyMeetLink / meetingLink, on bookings that are scheduled or
 * rescheduled and start in the future.
 */
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { DateTime } from 'luxon';

dotenv.config({ quiet: true });

const APPLY = process.argv.includes('--apply');
const URI = process.env.MONGODB_URI;
if (!URI) { console.error('No MONGODB_URI'); process.exit(1); }
const HAS_TOKEN = !!process.env.CALENDLY_API_TOKEN;
if (APPLY && !HAS_TOKEN) { console.error('No CALENDLY_API_TOKEN, cannot apply'); process.exit(1); }

await mongoose.connect(URI, { serverSelectionTimeoutMS: 20000 });
const { fetchMeetLinkByEventUri } = await import('../Utils/CalendlyAPIHelper.js');

const db = mongoose.connection;
const B = db.collection('campaignbookings');
const WA = db.collection('scheduledwhatsappreminders');
const DC = db.collection('scheduleddiscordmeetreminders');
const CALL = db.collection('scheduledcalls');
const fmt = d => DateTime.fromJSDate(new Date(d)).setZone('Asia/Kolkata').toFormat('dd LLL HH:mm');

const MISSING = { $in: [null, '', 'Not Provided', 'not provided', 'N/A'] };
const rows = await B.find({
  bookingStatus: { $in: ['scheduled', 'rescheduled'] },
  scheduledEventStartTime: { $gt: new Date() },
  $or: [{ calendlyMeetLink: MISSING }, { calendlyMeetLink: { $exists: false } }],
}).project({ bookingId: 1, clientName: 1, calendlyEventUri: 1, scheduledEventStartTime: 1, calendlyHost: 1 })
  .sort({ scheduledEventStartTime: 1 }).toArray();

console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY RUN'}  |  upcoming bookings without a meet link: ${rows.length}\n`);

let fixed = 0, stillMissing = 0, noEvent = 0;
for (const b of rows) {
  const label = `${fmt(b.scheduledEventStartTime)} IST  ${String(b.clientName || '?').slice(0, 24).padEnd(25)} host=${b.calendlyHost?.email || 'none'}`;
  if (!b.calendlyEventUri) { noEvent++; console.log(`  NO EVENT URI  ${label}`); continue; }

  if (!HAS_TOKEN) { console.log(`  NEEDS CHECK   ${label}`); continue; }
  const link = await fetchMeetLinkByEventUri(b.calendlyEventUri);
  if (!link) { stillMissing++; console.log(`  STILL NONE    ${label}  (Calendly has no link; host must fix)`); continue; }

  if (APPLY) {
    await B.updateOne({ bookingId: b.bookingId }, { $set: { calendlyMeetLink: link } });
    const wa = await WA.updateMany({ 'metadata.bookingId': b.bookingId, status: 'pending' }, { $set: { meetingLink: link } });
    const dc = await DC.updateMany({ bookingId: b.bookingId, status: 'pending' }, { $set: { meetingLink: link } });
    const cl = await CALL.updateMany({ 'metadata.bookingId': b.bookingId, status: 'pending' }, { $set: { meetingLink: link } });
    console.log(`  FILLED        ${label}  wa=${wa.modifiedCount} discord=${dc.modifiedCount} call=${cl.modifiedCount}`);
  } else {
    console.log(`  WOULD FILL    ${label}`);
  }
  fixed++;
}

console.log(`\n${APPLY ? 'filled' : 'would fill'}: ${fixed}  |  still no link in Calendly: ${stillMissing}  |  no event uri: ${noEvent}`);
if (!APPLY && fixed) console.log('Re-run with --apply to write.');
await mongoose.disconnect();
