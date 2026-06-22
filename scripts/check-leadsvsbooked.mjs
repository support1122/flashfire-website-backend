import dotenv from 'dotenv'; dotenv.config();
import mongoose from 'mongoose';
await mongoose.connect(process.env.MONGODB_URI);
const C = mongoose.connection.db.collection('campaignbookings');

const rows = await C.aggregate([
  { $addFields: {
      groupKey: { $ifNull: ['$clientPhone', '$clientEmail'] },
      isMeta: { $cond: [ { $or: [ { $ne: [ { $ifNull: ['$metaLeadId', null] }, null ] }, { $eq: ['$leadSource','meta_lead_ad'] } ] }, 1, 0 ] },
  } },
  { $group: {
      _id: '$groupKey',
      isMeta: { $max: '$isMeta' },
      hasMeeting: { $max: { $cond: [ { $ne: ['$scheduledEventStartTime', null] }, 1, 0 ] } },
      everCompleted: { $max: { $cond: [ { $in: ['$bookingStatus', ['completed','paid']] }, 1, 0 ] } },
      everPaid: { $max: { $cond: [ { $eq: ['$bookingStatus','paid'] }, 1, 0 ] } },
      firstSeen: { $min: { $ifNull: ['$bookingCreatedAt', '$scheduledEventStartTime'] } },
  } },
  { $group: {
      _id: { $dateToString: { format: '%Y-%m', date: '$firstSeen' } },
      leads: { $sum: 1 }, booked: { $sum: '$hasMeeting' },
      metaLeads: { $sum: '$isMeta' }, metaBooked: { $sum: { $cond: [ { $eq: ['$isMeta',1] }, '$hasMeeting', 0 ] } },
      completed: { $sum: '$everCompleted' }, paid: { $sum: '$everPaid' },
  } },
  { $sort: { _id: 1 } },
]).toArray();

const T = rows.reduce((a,r)=>({leads:a.leads+r.leads,booked:a.booked+r.booked,metaLeads:a.metaLeads+r.metaLeads,metaBooked:a.metaBooked+r.metaBooked,completed:a.completed+r.completed,paid:a.paid+r.paid}),{leads:0,booked:0,metaLeads:0,metaBooked:0,completed:0,paid:0});
console.log('TOTALS:', T);
console.log(`All booking rate:  ${(T.booked/T.leads*100).toFixed(1)}%`);
console.log(`Meta booking rate: ${(T.metaBooked/T.metaLeads*100).toFixed(1)}%`);
console.log('\nFunnel: Leads', T.leads, '-> Booked', T.booked, '-> Completed', T.completed, '-> Paid', T.paid);
console.log('\nPer month:'); rows.forEach(r=>console.log(`  ${r._id}  leads=${String(r.leads).padStart(4)} booked=${String(r.booked).padStart(4)}  meta=${String(r.metaLeads).padStart(4)}/${String(r.metaBooked).padStart(3)}`));
await mongoose.disconnect();
