import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '..', '.env') });

import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';

async function main() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI missing in .env');
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to MongoDB\n');

  const query = {
    $or: [
      { clientEmail: /himadrivyas141/i },
      { clientName: /himadri/i },
      { metaLeadId: 'l:978685021346731' },
    ],
  };

  const docs = await CampaignBookingModel.find(query)
    .sort({ bookingCreatedAt: -1 })
    .limit(10)
    .lean();

  console.log(`Found ${docs.length} matching lead(s):\n`);
  for (const d of docs) {
    console.log(JSON.stringify({
      bookingId: d.bookingId,
      clientName: d.clientName,
      clientEmail: d.clientEmail,
      clientPhone: d.clientPhone,
      utmSource: d.utmSource,
      utmMedium: d.utmMedium,
      utmCampaign: d.utmCampaign,
      metaLeadId: d.metaLeadId,
      metaFormName: d.metaFormName,
      metaCampaignName: d.metaCampaignName,
      metaAdName: d.metaAdName,
      metaAdsetName: d.metaAdsetName,
      metaPlatform: d.metaPlatform,
      metaIsOrganic: d.metaIsOrganic,
      metaLeadStatus: d.metaLeadStatus,
      leadSource: d.leadSource,
      bookingStatus: d.bookingStatus,
      bookingCreatedAt: d.bookingCreatedAt,
    }, null, 2));
    console.log('---');
  }

  await mongoose.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error('Script error:', err);
  process.exit(1);
});
