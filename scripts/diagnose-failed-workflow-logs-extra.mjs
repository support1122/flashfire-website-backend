import dotenv from 'dotenv';
dotenv.config();
import mongoose from 'mongoose';

await mongoose.connect(process.env.MONGODB_URI);
const db = mongoose.connection.db;

const logs = db.collection('workflowlogs');
const bookings = db.collection('campaignbookings');

console.log('Extra: drill into "Bad Request" + "booking.save" failures\n');

for (const err of ['Bad Request', 'booking.save is not a function', 'Request failed with status code 400']) {
  console.log('---', err, '---');
  const docs = await logs.find(
    { status: 'failed', error: err },
    { projection: { bookingId: 1, clientEmail: 1, clientPhone: 1, 'step.channel': 1, 'step.templateId': 1, 'step.templateName': 1, errorDetails: 1, attempts: 1 } }
  ).toArray();
  console.log(`  count: ${docs.length}`);
  for (const d of docs.slice(0, 5)) {
    const b = await bookings.findOne({ bookingId: d.bookingId }, { projection: { clientPhone: 1, bookingStatus: 1 } });
    console.log(`  bookingId=${d.bookingId} email=${d.clientEmail} channel=${d.step?.channel} tpl=${d.step?.templateName || d.step?.templateId}`);
    console.log(`    booking-now: ${b ? `phone=${b.clientPhone || 'NULL'} status=${b.bookingStatus}` : 'NOT FOUND'}`);
    if (d.errorDetails) {
      const detail = JSON.stringify(d.errorDetails).slice(0, 300);
      console.log(`    errorDetails: ${detail}`);
    }
  }
}

// Also: how many of the 9 missing bookingIds correspond to docs that look like leads (meta_lead, test, diag)?
console.log('\n--- 9 missing bookingIds: client breakdown ---');
const missing = ['booking_1765191353240_y2q5johzp','booking_1774632122532_07euxzu5e','booking_1774635556159_vfsc9hcab','booking_1774643452197_5tqyrufb8','booking_1774645235854_570wvu5mc','booking_1774681140779_qpi3o88ln','booking_1774688011815_kxzlu8ln3','booking_1774842348180_51m6onk34','booking_1774686034542_2v8xe75c7'];
for (const id of missing) {
  const sample = await logs.findOne({ bookingId: id }, { projection: { clientEmail: 1, clientName: 1, clientPhone: 1, createdAt: 1 } });
  // also look for any booking with matching email
  const byEmail = sample?.clientEmail ? await bookings.findOne({ clientEmail: sample.clientEmail.toLowerCase() }, { projection: { bookingId: 1, bookingStatus: 1, clientPhone: 1 } }) : null;
  console.log(`  ${id}`);
  console.log(`    log.snapshot: name="${sample?.clientName}" email=${sample?.clientEmail} phone=${sample?.clientPhone || 'NULL'} created=${sample?.createdAt?.toISOString?.()}`);
  console.log(`    current booking by email: ${byEmail ? `bookingId=${byEmail.bookingId} status=${byEmail.bookingStatus} phone=${byEmail.clientPhone || 'NULL'}` : 'NONE'}`);
}

await mongoose.disconnect();
process.exit(0);
