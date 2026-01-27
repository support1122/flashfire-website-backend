import { BdaIncentiveConfigModel } from '../Schema_Models/BdaIncentiveConfig.js';

const PLAN_CATALOG = {
  PRIME: { price: 119, currency: 'USD' },
  IGNITE: { price: 199, currency: 'USD' },
  PROFESSIONAL: { price: 349, currency: 'USD' },
  EXECUTIVE: { price: 599, currency: 'USD' }
};

export const getIncentiveConfig = async (req, res) => {
  try {
    const existing = await BdaIncentiveConfigModel.find({}).lean();
    const map = new Map();
    existing.forEach((c) => {
      map.set(c.planName, c);
    });

    const configs = Object.keys(PLAN_CATALOG).map((planName) => {
      const base = PLAN_CATALOG[planName];
      const row = map.get(planName);
      return {
        planName,
        basePrice: base.price,
        currency: base.currency,
        incentivePercent: row ? row.incentivePercent : 0
      };
    });

    return res.status(200).json({
      success: true,
      configs
    });
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
      return res.status(400).json({
        success: false,
        message: 'configs array is required'
      });
    }

    for (const cfg of configs) {
      const planName = cfg.planName;
      const percent = Number(cfg.incentivePercent);
      if (!PLAN_CATALOG[planName]) {
        continue;
      }
      if (Number.isNaN(percent) || percent < 0) {
        continue;
      }

      await BdaIncentiveConfigModel.findOneAndUpdate(
        { planName },
        { incentivePercent: percent, updatedAt: new Date() },
        { upsert: true, new: true }
      );
    }

    const updated = await BdaIncentiveConfigModel.find({}).lean();

    return res.status(200).json({
      success: true,
      message: 'Incentive config saved',
      data: updated
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: 'Failed to save incentive config',
      error: error.message
    });
  }
};

