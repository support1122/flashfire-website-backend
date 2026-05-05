/**
 * fuzzy-find-name.mjs
 * Try several name spellings to locate this client.
 * Run: node scripts/fuzzy-find-name.mjs
 */
import dotenv from 'dotenv';
dotenv.config();
import mongoose from 'mongoose';
import { DateTime } from 'luxon';

const tries = [
  /viswanth/i,
  /vishwanath/i,
  /viswanath/i,
  /donda/i,
  /donduri/i,
  /davis.*wanth/i,
  /wanth/i,
];

await mongoose.connect(process.env.MONGODB_URI);
const db = mongoose.connection.db;
const fmt = (d) => {
  if (!d) return null;
  const dt = DateTime.fromJSDate(new Date(d));
  return dt.isValid ? dt.setZone('Asia/Kolkata').toFormat('MMM d yyyy h:mm a ZZZZ') : String(d);
};

const collections = ['campaignbookings', 'leads', 'users', 'workflowlogs', 'emailcampaigns'];

for (const re of tries) {
  console.log(`\n=== regex ${re} ===`);
  for (const cname of collections) {
    try {
      const docs = await db.collection(cname).find({
        $or: [
          { clientEmail: re },
          { email: re },
          { clientName: re },
          { name: re },
          { 'invitee.email': re },
          { 'invitee.name': re },
        ],
      }).limit(5).toArray();
      if (docs.length) {
        console.log(`  ${cname}: ${docs.length} doc(s)`);
        for (const d of docs) {
          console.log('   ', {
            email: d.clientEmail || d.email || d.invitee?.email,
            name: d.clientName || d.name || d.invitee?.name,
            bookingId: d.bookingId,
            status: d.bookingStatus || d.status,
            createdAt: fmt(d.createdAt || d.bookingCreatedAt),
          });
        }
      }
    } catch (_) {}
  }
}

await mongoose.disconnect();
