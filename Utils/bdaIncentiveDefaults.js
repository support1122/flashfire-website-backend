// AUD has no Prime plan. Used until an admin saves AUD rows in BDA Incentive Settings.
export const AUD_INCENTIVE_DEFAULTS = {
  IGNITE: { basePrice: 299, incentivePerLeadInr: 600 },
  PROFESSIONAL: { basePrice: 549, incentivePerLeadInr: 1200 },
  EXECUTIVE: { basePrice: 899, incentivePerLeadInr: 2200 },
};

/** Fills in AUD entries on a Map("PLAN|CURRENCY" -> config) for plans the DB has no AUD row for. */
export function seedAudDefaults(configByKey) {
  for (const [planName, cfg] of Object.entries(AUD_INCENTIVE_DEFAULTS)) {
    const key = `${planName}|AUD`;
    if (!configByKey.has(key)) configByKey.set(key, { ...cfg });
  }
  return configByKey;
}
