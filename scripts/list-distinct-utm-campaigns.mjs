import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '..', '.env') });

import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';
import { CampaignModel } from '../Schema_Models/Campaign.js';

async function main() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI missing in .env');
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to MongoDB\n');

  const [bookingCampaigns, bookingSources, bookingMediums, campaignDocs] = await Promise.all([
    CampaignBookingModel.aggregate([
      { $match: { utmCampaign: { $nin: [null, ''] } } },
      { $group: { _id: '$utmCampaign', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]).allowDiskUse(true),
    CampaignBookingModel.distinct('utmSource'),
    CampaignBookingModel.distinct('utmMedium'),
    CampaignModel.find({}).select('campaignName utmSource utmCampaign utmMedium isActive').lean(),
  ]);

  console.log('=== Distinct utmCampaign values from CampaignBookings ===');
  bookingCampaigns.forEach((c) => console.log(`  ${c._id} -> ${c.count} bookings`));

  console.log('\n=== Distinct utmSource from CampaignBookings ===');
  bookingSources.filter(Boolean).sort().forEach((s) => console.log(`  ${s}`));

  console.log('\n=== Distinct utmMedium from CampaignBookings ===');
  bookingMediums.filter(Boolean).sort().forEach((s) => console.log(`  ${s}`));

  console.log('\n=== Registered Campaign docs (Campaign collection) ===');
  campaignDocs.forEach((c) =>
    console.log(`  [${c.isActive ? 'active' : 'inactive'}] ${c.campaignName} | source=${c.utmSource} | campaign=${c.utmCampaign}`)
  );

  const bookingCampaignSet = new Set(bookingCampaigns.map((c) => c._id));
  const registeredCampaignValues = new Set(
    campaignDocs.map((c) => c.utmCampaign).filter(Boolean)
  );
  const orphaned = [...bookingCampaignSet].filter((v) => !registeredCampaignValues.has(v));

  console.log('\n=== Booking utmCampaign values WITHOUT a Campaign doc (orphaned) ===');
  orphaned.forEach((v) => console.log(`  ${v}`));
  console.log(`\nOrphaned count: ${orphaned.length}`);

  await mongoose.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error('Script error:', err);
  process.exit(1);
});
