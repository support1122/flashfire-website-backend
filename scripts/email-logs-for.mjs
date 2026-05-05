/**
 * email-logs-for.mjs
 * Show every email-send touchpoint for a given email address.
 * Sources:
 *  - workflowlogs    (per-recipient email step send/failure rows)
 *  - emailcampaigns  (campaign rows containing the address in successfulEmails / failedEmails)
 *  - scheduledemailcampaigns (scheduled rows containing the address)
 *  - reminderlogs / remindererrors (any email-related reminder errors)
 *
 * Run: node scripts/email-logs-for.mjs <email>
 *      node scripts/email-logs-for.mjs dondaviswanth2@gmail.com
 */
import dotenv from 'dotenv';
dotenv.config();
import mongoose from 'mongoose';
import { DateTime } from 'luxon';

const target = (process.argv[2] || 'dondaviswanth2@gmail.com').toLowerCase().trim();

await mongoose.connect(process.env.MONGODB_URI);
const db = mongoose.connection.db;

const fmt = (d) => {
  if (!d) return null;
  const dt = DateTime.fromJSDate(new Date(d));
  return dt.isValid ? dt.setZone('Asia/Kolkata').toFormat('MMM d yyyy h:mm a ZZZZ') : String(d);
};

console.log(`\n=== EMAIL LOGS for ${target} ===\n`);

// 1. WorkflowLogs (per-recipient email + status)
const wlogs = await db.collection('workflowlogs').find({
  clientEmail: { $regex: `^${target}$`, $options: 'i' },
  'step.channel': 'email',
}).sort({ createdAt: -1 }).toArray();

console.log(`-- WorkflowLogs (email steps): ${wlogs.length}`);
for (const w of wlogs) {
  console.log({
    logId: w.logId,
    workflowName: w.workflowName,
    triggerAction: w.triggerAction,
    bookingId: w.bookingId,
    templateId: w.step?.templateId,
    templateName: w.step?.templateName,
    senderEmail: w.step?.senderEmail,
    status: w.status,
    scheduledFor: fmt(w.scheduledFor),
    executedAt: fmt(w.executedAt),
    claimedAt: fmt(w.claimedAt),
    attempts: w.attempts,
    error: w.error,
    createdAt: fmt(w.createdAt),
  });
  console.log('---');
}

// 2. EmailCampaigns — successful / failed entries
console.log(`\n-- EmailCampaigns containing ${target}`);
const campaigns = await db.collection('emailcampaigns').find({
  $or: [
    { 'successfulEmails.email': { $regex: `^${target}$`, $options: 'i' } },
    { 'failedEmails.email': { $regex: `^${target}$`, $options: 'i' } },
  ],
}).sort({ createdAt: -1 }).toArray();

console.log(`Found ${campaigns.length} campaign(s)`);
for (const c of campaigns) {
  const succ = (c.successfulEmails || []).filter(e => (e.email || '').toLowerCase() === target);
  const fail = (c.failedEmails || []).filter(e => (e.email || '').toLowerCase() === target);
  console.log({
    _id: c._id,
    templateName: c.templateName,
    templateId: c.templateId,
    domainName: c.domainName,
    status: c.status,
    provider: c.provider,
    isScheduled: c.isScheduled,
    createdAt: fmt(c.createdAt),
    sentToTarget: succ.map(s => ({ sentAt: fmt(s.sentAt), sendDay: s.sendDay, scheduledSendDate: fmt(s.scheduledSendDate) })),
    failedToTarget: fail.map(f => ({ failedAt: fmt(f.failedAt), error: f.error })),
  });
  console.log('---');
}

// 3. ScheduledEmailCampaigns
console.log(`\n-- ScheduledEmailCampaigns referencing ${target}`);
const scheduled = await db.collection('scheduledemailcampaigns').find({
  $or: [
    { 'recipientEmails.email': { $regex: `^${target}$`, $options: 'i' } },
    { 'recipientEmails': { $regex: `^${target}$`, $options: 'i' } },
  ],
}).sort({ createdAt: -1 }).toArray();
console.log(`Found ${scheduled.length}`);
for (const s of scheduled) {
  console.log({
    _id: s._id,
    name: s.name,
    templateId: s.templateId,
    status: s.status,
    scheduledFor: fmt(s.scheduledFor || s.sendAt),
    createdAt: fmt(s.createdAt),
  });
  console.log('---');
}

// 4. ReminderErrors with email category
console.log(`\n-- ReminderErrors (email category) for ${target}`);
const errs = await db.collection('remindererrors').find({
  clientEmail: { $regex: `^${target}$`, $options: 'i' },
}).sort({ createdAt: -1 }).limit(20).toArray();
console.log(`Found ${errs.length}`);
for (const e of errs) {
  console.log({
    category: e.category,
    severity: e.severity,
    message: e.message,
    source: e.source,
    bookingId: e.bookingId,
    createdAt: fmt(e.createdAt),
  });
  console.log('---');
}

// 5. CampaignBooking sanity (so we know who this is)
console.log(`\n-- CampaignBooking(s) for ${target}`);
const bookings = await db.collection('campaignbookings').find({
  clientEmail: { $regex: `^${target}$`, $options: 'i' },
}).sort({ bookingCreatedAt: -1 }).limit(10).toArray();
console.log(`Found ${bookings.length}`);
for (const b of bookings) {
  console.log({
    bookingId: b.bookingId,
    clientName: b.clientName,
    bookingStatus: b.bookingStatus,
    scheduledEventStartTime: fmt(b.scheduledEventStartTime),
    bookingCreatedAt: fmt(b.bookingCreatedAt),
    plan: b.plan,
    amount: b.amount,
  });
  console.log('---');
}

console.log('\n=== summary ===');
console.log({
  workflowEmailSteps: wlogs.length,
  workflowExecuted: wlogs.filter(w => w.status === 'executed').length,
  workflowFailed: wlogs.filter(w => w.status === 'failed').length,
  campaignsContainingTarget: campaigns.length,
  scheduledCampaignsReferencingTarget: scheduled.length,
  reminderErrors: errs.length,
  bookings: bookings.length,
});

await mongoose.disconnect();
