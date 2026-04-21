import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '..', '.env') });

import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';
import { CampaignModel } from '../Schema_Models/Campaign.js';

await mongoose.connect(process.env.MONGODB_URI);

const regCampaign = await CampaignModel.findOne({
  $or: [
    { utmMedium: 'Canada-Arun' },
    { campaignName: /Canada-1/i },
    { utmSource: 'google-1' },
  ],
}).lean();
console.log('Registered campaign:');
console.log(JSON.stringify(regCampaign, null, 2));

console.log('\n--- Bookings with utmMedium="Canada-Arun" ---');
const exactMedium = await CampaignBookingModel.countDocuments({ utmMedium: 'Canada-Arun' });
console.log('count:', exactMedium);

console.log('\n--- Bookings with utmSource of this campaign ---');
if (regCampaign?.utmSource) {
  const bySource = await CampaignBookingModel.find({ utmSource: regCampaign.utmSource })
    .select({ clientEmail: 1, utmSource: 1, utmMedium: 1, utmCampaign: 1, metaCampaignName: 1, bookingCreatedAt: 1 })
    .limit(10)
    .lean();
  console.log(`count by utmSource="${regCampaign.utmSource}":`, bySource.length);
  bySource.forEach((b) =>
    console.log(`  ${b.clientEmail} | src=${b.utmSource} | med=${b.utmMedium} | camp=${b.utmCampaign} | metaName=${b.metaCampaignName}`)
  );
}

console.log('\n--- Bookings with utmCampaign="Arun google Canada" ---');
const byCamp = await CampaignBookingModel.find({ utmCampaign: /canada/i })
  .select({ clientEmail: 1, utmSource: 1, utmMedium: 1, utmCampaign: 1, metaCampaignName: 1 })
  .limit(10)
  .lean();
console.log('count:', byCamp.length);
byCamp.forEach((b) =>
  console.log(`  ${b.clientEmail} | src=${b.utmSource} | med=${b.utmMedium} | camp=${b.utmCampaign} | metaName=${b.metaCampaignName}`)
);

await mongoose.disconnect();
