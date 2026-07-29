
import dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';
import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';
import { CrmUserModel } from '../Schema_Models/CrmUser.js';

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI;
const KALPATARU_EMAIL = 'kalpataru@flashfirehq.com';

async function reassignAllToKalpataru() {
  if (!MONGO_URI) {
    console.error('❌ No MONGODB_URI or MONGO_URI found in env');
    process.exit(1);
  }

  await mongoose.connect(MONGO_URI);
  console.log('✅ Connected to MongoDB');

  // Find Kalpataru
  const kalpataru = await CrmUserModel.findOne({
    email: KALPATARU_EMAIL,
    isActive: { $ne: false },
  }).lean();

  if (!kalpataru) {
    console.error(`❌ Could not find active Kalpataru user with email ${KALPATARU_EMAIL}`);
    process.exit(1);
  }

  // Define criteria: Meta-sourced leads with 'not-scheduled' booking status
  const match = {
    $or: [{ leadSource: 'meta_lead_ad' }, { metaLeadId: { $exists: true, $ne: null } }],
    bookingStatus: 'not-scheduled',
    scheduledEventStartTime: null,
  };

  const leads = await CampaignBookingModel.find(match).select('bookingId callLeadAssignee').lean();
  console.log(`📋 Found ${leads.length} matching leads.`);

  const now = new Date();
  const ops = leads.map((lead) => ({
    updateOne: {
      filter: { bookingId: lead.bookingId },
      update: {
        $set: {
          'callLeadAssignee.email': kalpataru.email,
          'callLeadAssignee.name': kalpataru.name,
          'callLeadAssignee.assignedAt': now,
        },
      },
    },
  }));

  if (ops.length > 0) {
    const result = await CampaignBookingModel.bulkWrite(ops, { ordered: false });
    console.log(`✅ Reassigned ${result.modifiedCount} lead(s) to Kalpataru.`);
  } else {
    console.log('ℹ️ No leads needed reassignment.');
  }

  await mongoose.disconnect();
  console.log('🏁 Done.');
  process.exit(0);
}

reassignAllToKalpataru().catch((err) => {
  console.error('❌ Script failed:', err);
  process.exit(1);
});
