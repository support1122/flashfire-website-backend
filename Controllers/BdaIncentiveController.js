import { BdaIncentiveConfigModel } from '../Schema_Models/BdaIncentiveConfig.js';

const PLAN_NAMES = ['PRIME', 'IGNITE', 'PROFESSIONAL', 'EXECUTIVE'];

// Default base prices per currency — matches live pricing pages
const CURRENCY_DEFAULTS = {
  USD: { PRIME: 99,  IGNITE: 199, PROFESSIONAL: 349, EXECUTIVE: 599 },
  CAD: { PRIME: 139, IGNITE: 239, PROFESSIONAL: 409, EXECUTIVE: 799 },
  GBP: { PRIME: 79,  IGNITE: 149, PROFESSIONAL: 299, EXECUTIVE: 499 },
};

export const getIncentiveConfig = async (req, res) => {
  try {
    const existing = await BdaIncentiveConfigModel.find({}).lean();

    // Build map keyed by "planName|currency"
    const map = new Map();
    existing.forEach((c) => {
      const currency = c.currency || 'USD';
      // Support legacy rows that only have basePriceUsd and no currency field
      const basePrice = c.basePrice != null ? c.basePrice : (c.basePriceUsd ?? null);
      map.set(`${c.planName}|${currency}`, { ...c, basePrice, currency });
    });

    const configs = [];
    for (const [currency, defaults] of Object.entries(CURRENCY_DEFAULTS)) {
      for (const planName of PLAN_NAMES) {
        const key = `${planName}|${currency}`;
        const row = map.get(key);
        configs.push({
          planName,
          currency,
          basePrice: row?.basePrice != null ? row.basePrice : defaults[planName],
          // Legacy field for backward compat
          basePriceUsd: currency === 'USD' ? (row?.basePrice ?? defaults[planName]) : undefined,
          incentivePerLeadInr: row?.incentivePerLeadInr ?? 0
        });
      }
    }

    return res.status(200).json({ success: true, configs });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Failed to load incentive config',
      error: error.message
    });
  }
};

export const saveIncentiveConfig = async (req, res) => {
  try {
    const { configs } = req.body;

    if (!Array.isArray(configs)) {
      return res.status(400).json({ success: false, message: 'configs array is required' });
    }

    for (const cfg of configs) {
      const planName = cfg.planName;
      if (!PLAN_NAMES.includes(planName)) continue;

      const currency = (cfg.currency || 'USD').toUpperCase();
      // Accept either basePrice or legacy basePriceUsd
      const basePrice = cfg.basePrice != null ? Number(cfg.basePrice) : (cfg.basePriceUsd != null ? Number(cfg.basePriceUsd) : null);
      const incentivePerLeadInr = cfg.incentivePerLeadInr != null ? Number(cfg.incentivePerLeadInr) : 0;

      if (basePrice != null && (Number.isNaN(basePrice) || basePrice < 0)) continue;
      if (Number.isNaN(incentivePerLeadInr) || incentivePerLeadInr < 0) continue;

      const update = { updatedAt: new Date(), currency, incentivePerLeadInr };
      if (basePrice != null) {
        update.basePrice = basePrice;
        if (currency === 'USD') update.basePriceUsd = basePrice;
      }

      await BdaIncentiveConfigModel.findOneAndUpdate(
        { planName, currency },
        update,
        { upsert: true, new: true }
      );
    }

    const updated = await BdaIncentiveConfigModel.find({}).lean();
    return res.status(200).json({ success: true, message: 'Incentive config saved', data: updated });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Failed to save incentive config',
      error: error.message
    });
  }
};
