/**
 * READ-ONLY no-show audit. Performs no writes and starts no schedulers.
 *
 * Run:  node scripts/noshow-audit.mjs
 *       node scripts/noshow-audit.mjs 90      (window in days, default 180)
 *
 * Answers the questions that decide where to spend effort:
 *   - What is the real no-show rate, and is it moving?
 *   - Does booking lead time predict it? (same-day vs booked a week out)
 *   - Which source, and which meeting hour, no-shows hardest?
 *   - Do we even have a phone number for the people who ghost?
 *   - Did the WhatsApp reminders actually get delivered for those meetings?
 */
import dotenv from 'dotenv';
import mongoose from 'mongoose';

dotenv.config({ quiet: true });

const DAYS = Number(process.argv[2]) || 180;
const DECIDED = ['completed', 'paid', 'no-show'];
const pct = (a, b) => (b > 0 ? ((100 * a) / b).toFixed(1) + '%' : '—');

await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 20000 });
console.log(`Connected. Window: last ${DAYS} days of past meetings.\n`);

const C = mongoose.connection.collection('campaignbookings');
const since = new Date(Date.now() - DAYS * 24 * 3600 * 1000);
const base = { scheduledEventStartTime: { $gte: since, $lte: new Date() } };
const decided = { ...base, bookingStatus: { $in: DECIDED } };
const noShowSum = { $sum: { $cond: [{ $eq: ['$bookingStatus', 'no-show'] }, 1, 0] } };

const overall = await C.aggregate([
  { $match: base },
  { $group: { _id: '$bookingStatus', n: { $sum: 1 } } },
  { $sort: { n: -1 } },
]).toArray();
console.log('=== booking status of past meetings ===');
for (const r of overall) console.log(`${String(r._id).padEnd(16)} ${r.n}`);
console.log('(a large "scheduled" bucket here means outcomes are not being marked at all)');

const byMonth = await C.aggregate([
  { $match: decided },
  { $group: {
    _id: { $dateToString: { format: '%Y-%m', date: '$scheduledEventStartTime' } },
    total: { $sum: 1 }, noShow: noShowSum,
  } },
  { $sort: { _id: 1 } },
]).toArray();
console.log('\n=== no-show rate by month (share of completed+paid+no-show) ===');
for (const r of byMonth) console.log(`${r._id}  n=${String(r.total).padStart(4)}  noShow=${String(r.noShow).padStart(4)}  ${pct(r.noShow, r.total)}`);

const leadTime = await C.aggregate([
  { $match: { ...decided, bookingCreatedAt: { $ne: null } } },
  { $addFields: { leadHours: { $divide: [{ $subtract: ['$scheduledEventStartTime', '$bookingCreatedAt'] }, 3600000] } } },
  { $addFields: { bucket: { $switch: { branches: [
    { case: { $lt: ['$leadHours', 1] },   then: '0 <1h' },
    { case: { $lt: ['$leadHours', 4] },   then: '1 1-4h' },
    { case: { $lt: ['$leadHours', 24] },  then: '2 4-24h' },
    { case: { $lt: ['$leadHours', 72] },  then: '3 1-3d' },
    { case: { $lt: ['$leadHours', 168] }, then: '4 3-7d' },
  ], default: '5 >7d' } } } },
  { $group: { _id: '$bucket', total: { $sum: 1 }, noShow: noShowSum } },
  { $sort: { _id: 1 } },
]).toArray();
console.log('\n=== by booking lead time (booked -> meeting) ===');
for (const r of leadTime) console.log(`${r._id.padEnd(9)} n=${String(r.total).padStart(4)}  noShow=${String(r.noShow).padStart(4)}  ${pct(r.noShow, r.total)}`);

const bySource = await C.aggregate([
  { $match: decided },
  { $group: { _id: { $ifNull: ['$utmSource', 'none'] }, total: { $sum: 1 }, noShow: noShowSum } },
  { $match: { total: { $gte: 15 } } },
  { $sort: { total: -1 } }, { $limit: 15 },
]).toArray();
console.log('\n=== by utmSource (n >= 15) ===');
for (const r of bySource) console.log(`${String(r._id).slice(0, 26).padEnd(28)} n=${String(r.total).padStart(4)}  ${pct(r.noShow, r.total)}`);

const byHour = await C.aggregate([
  { $match: decided },
  { $group: { _id: { $hour: { date: '$scheduledEventStartTime', timezone: 'America/New_York' } }, total: { $sum: 1 }, noShow: noShowSum } },
  { $sort: { _id: 1 } },
]).toArray();
console.log('\n=== by meeting hour, ET (n >= 10) ===');
for (const r of byHour) if (r.total >= 10) console.log(`${String(r._id).padStart(2)}:00  n=${String(r.total).padStart(4)}  ${pct(r.noShow, r.total)}`);

const byDow = await C.aggregate([
  { $match: decided },
  { $group: { _id: { $dayOfWeek: { date: '$scheduledEventStartTime', timezone: 'America/New_York' } }, total: { $sum: 1 }, noShow: noShowSum } },
  { $sort: { _id: 1 } },
]).toArray();
const DOW = ['', 'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
console.log('\n=== by weekday (ET) ===');
for (const r of byDow) console.log(`${DOW[r._id].padEnd(4)} n=${String(r.total).padStart(4)}  ${pct(r.noShow, r.total)}`);

const phoneCov = await C.aggregate([
  { $match: decided },
  { $addFields: { hasPhone: { $and: [{ $ne: ['$clientPhone', null] }, { $ne: ['$clientPhone', ''] }] } } },
  { $group: { _id: '$hasPhone', total: { $sum: 1 }, noShow: noShowSum } },
]).toArray();
console.log('\n=== by phone-on-file (no phone = no WhatsApp, no call) ===');
for (const r of phoneCov) console.log(`hasPhone=${String(r._id).padEnd(5)} n=${String(r.total).padStart(4)}  ${pct(r.noShow, r.total)}`);

const WA = mongoose.connection.collection('scheduledwhatsappreminders');
const waAgg = await WA.aggregate([
  { $match: { meetingStartISO: { $gte: since } } },
  { $group: { _id: { type: '$metadata.reminderType', status: '$status' }, n: { $sum: 1 } } },
  { $sort: { n: -1 } }, { $limit: 30 },
]).toArray();
console.log('\n=== WhatsApp reminder outcomes (delivery health) ===');
for (const r of waAgg) console.log(`${String(r._id.type).padEnd(11)} ${String(r._id.status).padEnd(11)} ${r.n}`);

const noWa = await C.aggregate([
  { $match: decided },
  { $lookup: {
    from: 'scheduledwhatsappreminders', localField: 'bookingId', foreignField: 'bookingId',
    pipeline: [{ $match: { status: 'completed' } }, { $limit: 1 }], as: 'waDone',
  } },
  { $addFields: { gotWa: { $gt: [{ $size: '$waDone' }, 0] } } },
  { $group: { _id: '$gotWa', total: { $sum: 1 }, noShow: noShowSum } },
]).toArray();
console.log('\n=== by "at least one WhatsApp reminder delivered" ===');
for (const r of noWa) console.log(`reminded=${String(r._id).padEnd(5)} n=${String(r.total).padStart(4)}  ${pct(r.noShow, r.total)}`);
console.log('(not causal — reminded/unreminded differ in other ways — but a big gap is worth chasing)');

await mongoose.disconnect();
console.log('\nDone. No writes were performed.');
