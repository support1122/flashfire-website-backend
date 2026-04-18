import dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';
import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';
import { CampaignModel } from '../Schema_Models/Campaign.js';

const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI;

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalize(value) {
  return nonEmpty(value) ? value.trim() : null;
}

function readFromQuestionsAndAnswers(questionsAndAnswers, target) {
  if (!Array.isArray(questionsAndAnswers)) return null;
  const desiredTokens = target === 'medium'
    ? ['utm_medium', 'utm medium', 'utmmedium']
    : ['utm_campaign', 'utm campaign', 'utmcampaign'];

  for (const qa of questionsAndAnswers) {
    const key = String(qa?.question || qa?.name || '').toLowerCase();
    const value = normalize(qa?.answer || qa?.value);
    if (!value) continue;
    if (desiredTokens.some((token) => key.includes(token))) {
      return value;
    }
  }

  return null;
}

function readFromMetaRaw(metaRawData, target) {
  if (!metaRawData || typeof metaRawData !== 'object') return null;
  const directKeys = target === 'medium'
    ? ['utm_medium', 'utmMedium', 'utmmedium']
    : ['utm_campaign', 'utmCampaign', 'utmcampaign'];

  for (const key of directKeys) {
    const v = normalize(metaRawData[key]);
    if (v) return v;
  }

  if (Array.isArray(metaRawData.field_data)) {
    for (const field of metaRawData.field_data) {
      const name = String(field?.name || '').toLowerCase();
      const values = Array.isArray(field?.values) ? field.values : [];
      const first = normalize(values[0]);
      if (!first) continue;
      if (target === 'medium' && (name.includes('utm_medium') || name === 'utmmedium')) return first;
      if (target === 'campaign' && (name.includes('utm_campaign') || name === 'utmcampaign')) return first;
    }
  }

  return null;
}

function readFromUrl(url, target) {
  if (!nonEmpty(url)) return null;
  try {
    const parsed = new URL(url);
    const key = target === 'medium' ? 'utm_medium' : 'utm_campaign';
    return normalize(parsed.searchParams.get(key));
  } catch {
    return null;
  }
}

function defaultMediumFromLead(booking) {
  const source = String(booking.utmSource || '').toLowerCase();
  if (booking.leadSource === 'meta_lead_ad' || source.includes('meta') || source.includes('facebook')) return 'paid';
  if (source.includes('google')) return 'cpc';
  if (source.includes('email') || source.includes('newsletter')) return 'email';
  if (source.includes('linkedin')) return 'paid_social';
  if (source.includes('csv') || source.includes('manual')) return 'manual';
  return 'direct';
}

function defaultCampaignFromLead(booking) {
  const source = normalize(booking.utmSource);
  if (booking.metaCampaignId) return `meta_campaign_${booking.metaCampaignId}`;
  if (source) return `${source.toLowerCase().replace(/[^a-z0-9]+/g, '_')}_campaign`;
  return 'unknown_campaign';
}

async function run() {
  if (!MONGO_URI) {
    throw new Error('No MONGODB_URI or MONGO_URI found in env');
  }

  await mongoose.connect(MONGO_URI);
  console.log('✅ Connected to MongoDB');

  const campaigns = await CampaignModel.find({}).select('campaignId utmSource utmMedium utmCampaign').lean();
  const campaignById = new Map();
  const campaignBySource = new Map();
  for (const c of campaigns) {
    if (nonEmpty(c.campaignId)) campaignById.set(c.campaignId, c);
    if (nonEmpty(c.utmSource)) campaignBySource.set(c.utmSource.toLowerCase(), c);
  }

  const filter = {
    $or: [
      { utmMedium: { $exists: false } },
      { utmMedium: null },
      { utmMedium: '' },
      { utmCampaign: { $exists: false } },
      { utmCampaign: null },
      { utmCampaign: '' },
    ],
  };

  const bookings = await CampaignBookingModel.find(filter)
    .select('bookingId campaignId utmSource utmMedium utmCampaign questionsAndAnswers metaRawData calendlyMeetLink calendlyRescheduleLink leadSource metaCampaignId')
    .lean();

  console.log(`📋 Found ${bookings.length} booking(s) needing backfill`);

  if (bookings.length === 0) {
    await mongoose.disconnect();
    console.log('✅ Nothing to update');
    return;
  }

  const ops = [];
  let mediumUpdated = 0;
  let campaignUpdated = 0;

  for (const booking of bookings) {
    const sourceKey = nonEmpty(booking.utmSource) ? booking.utmSource.toLowerCase() : null;
    const linkedCampaign = (nonEmpty(booking.campaignId) ? campaignById.get(booking.campaignId) : null)
      || (sourceKey ? campaignBySource.get(sourceKey) : null)
      || null;

    const medium = normalize(booking.utmMedium)
      || normalize(linkedCampaign?.utmMedium)
      || readFromQuestionsAndAnswers(booking.questionsAndAnswers, 'medium')
      || readFromMetaRaw(booking.metaRawData, 'medium')
      || readFromUrl(booking.calendlyMeetLink, 'medium')
      || readFromUrl(booking.calendlyRescheduleLink, 'medium')
      || defaultMediumFromLead(booking);

    const campaign = normalize(booking.utmCampaign)
      || normalize(linkedCampaign?.utmCampaign)
      || readFromQuestionsAndAnswers(booking.questionsAndAnswers, 'campaign')
      || readFromMetaRaw(booking.metaRawData, 'campaign')
      || readFromUrl(booking.calendlyMeetLink, 'campaign')
      || readFromUrl(booking.calendlyRescheduleLink, 'campaign')
      || defaultCampaignFromLead(booking);

    const set = {};
    if (!normalize(booking.utmMedium) && medium) {
      set.utmMedium = medium;
      mediumUpdated += 1;
    }
    if (!normalize(booking.utmCampaign) && campaign) {
      set.utmCampaign = campaign;
      campaignUpdated += 1;
    }

    if (Object.keys(set).length > 0) {
      ops.push({
        updateOne: {
          filter: { bookingId: booking.bookingId },
          update: { $set: set },
        },
      });
    }
  }

  if (ops.length === 0) {
    await mongoose.disconnect();
    console.log('✅ No changes required after derivation');
    return;
  }

  const result = await CampaignBookingModel.bulkWrite(ops, { ordered: false });

  console.log('✅ Backfill complete');
  console.log(`   Matched: ${result.matchedCount ?? 0}`);
  console.log(`   Modified: ${result.modifiedCount ?? 0}`);
  console.log(`   utmMedium filled: ${mediumUpdated}`);
  console.log(`   utmCampaign filled: ${campaignUpdated}`);

  const remaining = await CampaignBookingModel.countDocuments(filter);
  console.log(`   Remaining missing medium/campaign: ${remaining}`);

  await mongoose.disconnect();
}

run()
  .then(() => {
    console.log('🏁 Done');
    process.exit(0);
  })
  .catch(async (error) => {
    console.error('❌ Backfill failed:', error.message || error);
    try {
      await mongoose.disconnect();
    } catch {}
    process.exit(1);
  });
