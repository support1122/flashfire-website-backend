/**
 * find-email-anywhere.mjs
 * Sweep every collection for any field containing the target email (or fuzzy variant).
 * Run: node scripts/find-email-anywhere.mjs dondaviswanth2@gmail.com
 */
import dotenv from 'dotenv';
dotenv.config();
import mongoose from 'mongoose';
import { DateTime } from 'luxon';

const arg = (process.argv[2] || 'dondaviswanth2@gmail.com').toLowerCase().trim();
const local = arg.split('@')[0];
const fuzzy = local.replace(/[^a-z0-9]/g, '');

await mongoose.connect(process.env.MONGODB_URI);
const db = mongoose.connection.db;

const fmt = (d) => {
  if (!d) return null;
  const dt = DateTime.fromJSDate(new Date(d));
  return dt.isValid ? dt.setZone('Asia/Kolkata').toFormat('MMM d yyyy h:mm a ZZZZ') : String(d);
};

console.log(`\nLooking for: ${arg}`);
console.log(`Local part: ${local}, fuzzy: ${fuzzy}\n`);

const collections = await db.listCollections().toArray();
const exactRe = new RegExp(`^${arg.replace(/[.+]/g, '\\$&')}$`, 'i');
const partialRe = new RegExp(local.replace(/[.+]/g, '\\$&'), 'i');
const fuzzyRe = new RegExp(fuzzy.split('').join('.{0,1}'), 'i'); // tolerant of 1-char gaps

const results = {};

for (const c of collections) {
  const name = c.name;
  if (/^system\./.test(name)) continue;
  try {
    const exactCount = await db.collection(name).countDocuments({
      $or: [
        { clientEmail: exactRe },
        { email: exactRe },
        { recipientEmail: exactRe },
        { 'invitee.email': exactRe },
        { 'payload.payload.email': exactRe },
        { 'successfulEmails.email': exactRe },
        { 'failedEmails.email': exactRe },
      ],
    });
    if (exactCount > 0) {
      results[name] = results[name] || {};
      results[name].exact = exactCount;
    }
  } catch (_) {}
}

console.log('Exact-email matches per collection:');
console.log(JSON.stringify(results, null, 2));

if (Object.keys(results).length === 0) {
  console.log('\nNo exact match anywhere. Trying partial match on local part...');
  const partial = {};
  for (const c of collections) {
    const name = c.name;
    if (/^system\./.test(name)) continue;
    try {
      const cnt = await db.collection(name).countDocuments({
        $or: [
          { clientEmail: partialRe },
          { email: partialRe },
          { clientName: partialRe },
          { 'invitee.email': partialRe },
          { 'invitee.name': partialRe },
          { 'payload.payload.email': partialRe },
          { 'payload.payload.name': partialRe },
        ],
      });
      if (cnt > 0) partial[name] = cnt;
    } catch (_) {}
  }
  console.log('Partial matches (local part):');
  console.log(JSON.stringify(partial, null, 2));

  // Show top 5 docs from each partial-match collection
  for (const name of Object.keys(partial)) {
    console.log(`\n--- sample from ${name} ---`);
    const docs = await db.collection(name).find({
      $or: [
        { clientEmail: partialRe },
        { email: partialRe },
        { clientName: partialRe },
        { 'invitee.email': partialRe },
        { 'invitee.name': partialRe },
        { 'payload.payload.email': partialRe },
        { 'payload.payload.name': partialRe },
      ],
    }).limit(3).toArray();
    for (const d of docs) {
      console.log({
        _id: d._id,
        clientEmail: d.clientEmail,
        clientName: d.clientName,
        email: d.email,
        bookingId: d.bookingId,
        bookingStatus: d.bookingStatus,
        scheduledEventStartTime: fmt(d.scheduledEventStartTime),
        eventType: d.eventType,
        createdAt: fmt(d.createdAt || d.bookingCreatedAt),
      });
    }
  }
}

await mongoose.disconnect();
