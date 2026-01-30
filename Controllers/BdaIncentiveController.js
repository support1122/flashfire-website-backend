import { BdaIncentiveConfigModel } from '../Schema_Models/BdaIncentiveConfig.js';

const PLAN_CATALOG = {
  PRIME: { price: 99, currency: 'USD' },
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
        basePriceUsd: row?.basePriceUsd != null ? row.basePriceUsd : base.price,
        currency: base.currency,
        incentivePerLeadInr: row?.incentivePerLeadInr != null ? row.incentivePerLeadInr : 0
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
      if (!PLAN_CATALOG[planName]) {
        continue;
      }
      const basePriceUsd = cfg.basePriceUsd != null ? Number(cfg.basePriceUsd) : null;
      const incentivePerLeadInr = cfg.incentivePerLeadInr != null ? Number(cfg.incentivePerLeadInr) : 0;
      if (basePriceUsd != null && (Number.isNaN(basePriceUsd) || basePriceUsd < 0)) {
        continue;
      }
      if (Number.isNaN(incentivePerLeadInr) || incentivePerLeadInr < 0) {
        continue;
      }

      const update = {
        updatedAt: new Date(),
        incentivePerLeadInr
      };
      if (basePriceUsd != null) {
        update.basePriceUsd = basePriceUsd;
      }

      await BdaIncentiveConfigModel.findOneAndUpdate(
        { planName },
        update,
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
