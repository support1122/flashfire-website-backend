import dotenv from 'dotenv';
dotenv.config();
import mongoose from 'mongoose';

await mongoose.connect(process.env.MONGODB_URI);
const db = mongoose.connection.db;

// Find collection names
const cols = await db.listCollections().toArray();
const names = cols.map(c => c.name);
console.log('Collections:', names.filter(n => n.includes('remind') || n.includes('whatsapp') || n.includes('booking') || n.includes('scheduled')).join(', '));

// Find Divya in all reminder collections
for (const name of names) {
  const docs = await db.collection(name).find({
    $or: [{ clientName: /divya/i }, { phoneNumber: /6234326930/ }]
  }).limit(3).toArray();
  if (docs.length > 0) {
    console.log(`\n=== Found in ${name} ===`);
    docs.forEach(r => console.log(JSON.stringify({
      reminderType: r.reminderType, meetingDate: r.meetingDate,
      meetingTime: r.meetingTime, timezone: r.timezone, inviteeTimezone: r.inviteeTimezone,
      scheduledFor: r.scheduledFor, meetingStartISO: r.meetingStartISO, status: r.status
    }, null, 2)));
  }
}

await mongoose.disconnect();
