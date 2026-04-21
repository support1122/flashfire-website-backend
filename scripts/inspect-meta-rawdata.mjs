import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '..', '.env') });

import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected\n');

  const doc = await CampaignBookingModel.findOne({ metaLeadId: 'l:978685021346731' }).lean();
  if (!doc) {
    console.log('Himadri Meta lead not found');
    process.exit(0);
  }

  console.log('metaAdId:', doc.metaAdId);
  console.log('metaCampaignId:', doc.metaCampaignId);
  console.log('metaAdsetId:', doc.metaAdsetId);
  console.log('metaFormId:', doc.metaFormId);
  console.log('metaFormName:', doc.metaFormName);
  console.log('metaRawData keys:', Object.keys(doc.metaRawData || {}));
  console.log('metaRawData full:', JSON.stringify(doc.metaRawData, null, 2));

  await mongoose.disconnect();
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
