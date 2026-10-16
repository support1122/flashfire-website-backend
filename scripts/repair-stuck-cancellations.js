/**
 * One-off repair for bookings whose Calendly cancel webhook arrived but never reached the booking row.
 *
 * Cause: the old cancel handler matched on invitee email, and the invitee email can differ from the email on the
 * booking row (lead form address vs Calendly address). The row stayed 'scheduled', the meeting looked missed, and
 * the BDA was fined for a meeting the client had cancelled.
 *
 * This script finds those rows by the event URI (unique), marks them canceled the same way the webhook does, and
 * waives the fines tied to them through the deduction engine (so the audit trail and the monthly tiers stay right).
 *
 *   node scripts/repair-stuck-cancellations.js            dry run, writes nothing
 *   node scripts/repair-stuck-cancellations.js --apply    writes
 *
 * Only rows still 'scheduled' are touched, and only when the client cancelled before the meeting started.
 * A cancel that arrived after the start is reported and left alone, because that meeting may really have run.
 * The database comes from MONGODB_URI; the connection string is never printed.
 */
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';
import { BdaDeductionModel } from '../Schema_Models/BdaDeduction.js';
import { CalendlyWebhookLogModel } from '../Schema_Models/CalendlyWebhookLog.js';
import { waiveDeduction } from '../Utils/DeductionEngine.js';

dotenv.config();

const APPLY = process.argv.includes('--apply');
const ACTOR = { email: 'system_cancel_repair', name: 'Cancellation repair' };
const REASON = 'Client cancelled before the meeting started; the cancel was matched by event URI after a webhook email mismatch.';

const ms = (d) => (d ? new Date(d).getTime() : null);

async function main() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not set');
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 20000 });
  console.log(`database: ${mongoose.connection.name}   mode: ${APPLY ? 'APPLY (writes)' : 'dry run (no writes)'}`);

  const logs = await CalendlyWebhookLogModel.find({ eventType: 'invitee.canceled' })
    .select('payload.scheduled_event.uri payload.cancellation payload.rescheduled payload.email createdAt')
    .lean();

  const cancelByUri = new Map();
  for (const l of logs) {
    const uri = l.payload?.scheduled_event?.uri;
    if (!uri) continue;
    const at = ms(l.payload?.cancellation?.created_at) ?? ms(l.createdAt);
    const prev = cancelByUri.get(uri);
    if (!prev || at < prev.at) cancelByUri.set(uri, { at, by: l.payload?.cancellation?.canceled_by || 'unknown', reason: l.payload?.cancellation?.reason || 'No reason provided' });
  }

  const rows = await CampaignBookingModel.find({
    calendlyEventUri: { $in: [...cancelByUri.keys()] },
    bookingStatus: 'scheduled',
  });

  const plan = { fix: [], skippedNoStart: [], skippedCancelAfterStart: [] };
  for (const b of rows) {
    const c = cancelByUri.get(b.calendlyEventUri);
    const start = ms(b.scheduledEventStartTime);
    if (start == null) plan.skippedNoStart.push(b.bookingId);
    else if (c.at >= start) plan.skippedCancelAfterStart.push(b.bookingId);
    else plan.fix.push({ b, c });
  }

  console.log(`cancel logs: ${logs.length}   matching rows still 'scheduled': ${rows.length}`);
  console.log(`to fix: ${plan.fix.length}   skipped (no start time): ${plan.skippedNoStart.length}   skipped (cancel after start): ${plan.skippedCancelAfterStart.length}`);

  let waived = 0;
  let waivedInr = 0;
  let fixed = 0;
  for (const { b, c } of plan.fix) {
    const fines = await BdaDeductionModel.find({ bookingId: b.bookingId, status: { $in: ['active', 'needs_review', 'shadow'] } })
      .select('deductionId rule amountInr status')
      .lean();
    console.log(`${APPLY ? 'fixing' : 'would fix'} ${b.bookingId}  start ${new Date(b.scheduledEventStartTime).toISOString()}  cancelled ${new Date(c.at).toISOString()}  fines: ${fines.map((f) => `${f.rule} ${f.amountInr} ${f.status}`).join(', ') || 'none'}`);
    if (!APPLY) {
      waivedInr += fines.reduce((s, f) => s + (f.amountInr || 0), 0);
      waived += fines.length;
      continue;
    }
    b._statusActor = { source: 'calendly', name: 'Cancellation repair', email: ACTOR.email, previousStatus: b.bookingStatus };
    b.bookingStatus = 'canceled';
    b.statusChangedAt = new Date();
    b.statusChangeSource = 'calendly';
    b.statusChangedBy = ACTOR.email;
    b.canceledAt = new Date(c.at);
    b.canceledBy = c.by;
    b.cancelReason = c.reason;
    await b.save();
    fixed += 1;
    for (const f of fines) {
      const res = await waiveDeduction(f.deductionId, ACTOR, REASON);
      if (res.ok) {
        waived += 1;
        waivedInr += f.amountInr || 0;
      } else {
        console.warn(`  could not waive ${f.deductionId}: ${res.code}`);
      }
    }
  }

  console.log(`${APPLY ? 'fixed' : 'would fix'} bookings: ${APPLY ? fixed : plan.fix.length}   ${APPLY ? 'waived' : 'would waive'} fines: ${waived}   amount at current tiers: INR ${waivedInr}`);
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('repair failed:', err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
