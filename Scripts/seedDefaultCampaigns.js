import { CampaignModel } from '../Schema_Models/Campaign.js';

const DEFAULT_CAMPAIGNS = [
  { utmSource: 'whatsapp', campaignName: 'whatsapp', generatedUrl: 'https://www.flashfirejobs.com/?utm_source=whatsapp' },
  { utmSource: 'instagram', campaignName: 'instagram', generatedUrl: 'https://www.flashfirejobs.com/?utm_source=instagram' }
];

export async function ensureDefaultCampaigns() {
  for (const def of DEFAULT_CAMPAIGNS) {
    const existing = await CampaignModel.findOne({ utmSource: def.utmSource });
    if (!existing) {
      await CampaignModel.create({
        campaignName: def.campaignName,
        utmSource: def.utmSource,
        utmMedium: 'campaign',
        generatedUrl: def.generatedUrl,
        baseUrl: 'https://www.flashfirejobs.com',
        isActive: true,
        createdBy: 'system'
      });
    } else if (existing.generatedUrl !== def.generatedUrl) {
      existing.generatedUrl = def.generatedUrl;
      existing.baseUrl = 'https://www.flashfirejobs.com';
      await existing.save();
    }
  }
}
