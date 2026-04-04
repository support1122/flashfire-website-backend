import dotenv from 'dotenv';
dotenv.config();
import mongoose from 'mongoose';
import { DateTime } from 'luxon';

await mongoose.connect(process.env.MONGODB_URI);
const db = mongoose.connection.db;

const names = ['abhishek', 'muhammad khan', 'sumeet', 'saurabh'];

for (const name of names) {
  const docs = await db.collection('scheduleddiscordmeetreminders').find({
    $or: [
      { clientName: new RegExp(name, 'i') },
      { 'metadata.clientName': new RegExp(name, 'i') }
    ]
  }).sort({ scheduledFor: -1 }).limit(4).toArray();
  
  if (docs.length) {
    console.log(`\n=== ${name.toUpperCase()} ===`);
    docs.forEach(r => {
      const sf = DateTime.fromJSDate(new Date(r.scheduledFor)).setZone('Asia/Calcutta');
      console.log({
        reminderType: r.reminderType,
        scheduledFor: sf.toFormat('MMM d h:mma ZZZZ'),
        meetingStartISO: r.meetingStartISO,
        inviteeTimezone: r.inviteeTimezone,
        status: r.status,
        hasMeta: !!r.metadata,
        metaKeys: r.metadata ? Object.keys(r.metadata) : []
      });
    });
  }
}

await mongoose.disconnect();
