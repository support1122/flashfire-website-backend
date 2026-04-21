import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.join(__dirname, '..', '.env') });

import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';

const REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/g;
function ciExact(v) {
  const escaped = v.trim().replace(REGEX_SPECIALS, '\\$&').replace(/[+ ]/g, '[+ ]');
  return { $regex: `^${escaped}$`, $options: 'i' };
}

await mongoose.connect(process.env.MONGODB_URI);

const tests = [
  ['utmMedium', 'cpc'],
  ['utmMedium', 'Paid'],
  ['utmCampaign', 'usa-job'],
  ['utmCampaign', 'Google+Discovery+Arun'],
  ['utmCampaign', 'Google Discovery Arun'],
];

for (const [field, value] of tests) {
  const exact = await CampaignBookingModel.countDocuments({ [field]: value });
  const ci = await CampaignBookingModel.countDocuments({ [field]: ciExact(value) });
  console.log(`${field}="${value}"  exact=${exact}  caseInsensitive=${ci}`);
}

await mongoose.disconnect();
