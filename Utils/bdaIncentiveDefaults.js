// AUD has no Prime plan. Used until an admin saves AUD rows in BDA Incentive Settings.
export const AUD_INCENTIVE_DEFAULTS = {
  IGNITE: { basePrice: 299, incentivePerLeadInr: 600 },
  PROFESSIONAL: { basePrice: 549, incentivePerLeadInr: 1200 },
  EXECUTIVE: { basePrice: 899, incentivePerLeadInr: 2200 },
};

// EUR (Europe, /en-eu): same incentive per lead as the other regions. No Prime plan.
export const EUR_INCENTIVE_DEFAULTS = {
  IGNITE: { basePrice: 169, incentivePerLeadInr: 600 },
  PROFESSIONAL: { basePrice: 299, incentivePerLeadInr: 1200 },
  EXECUTIVE: { basePrice: 499, incentivePerLeadInr: 2200 },
};

/** Fills in EUR entries on a Map("PLAN|CURRENCY" -> config) for plans the DB has no EUR row for. */
export function seedEurDefaults(configByKey) {
  for (const [planName, cfg] of Object.entries(EUR_INCENTIVE_DEFAULTS)) {
    const key = `${planName}|EUR`;
    if (!configByKey.has(key)) configByKey.set(key, { ...cfg });
  }
  return configByKey;
}

/** Fills in AUD entries on a Map("PLAN|CURRENCY" -> config) for plans the DB has no AUD row for. */
export function seedAudDefaults(configByKey) {
  for (const [planName, cfg] of Object.entries(AUD_INCENTIVE_DEFAULTS)) {
    const key = `${planName}|AUD`;
    if (!configByKey.has(key)) configByKey.set(key, { ...cfg });
  }
  return configByKey;
}

/** Seeds every currency that has built-in defaults (AUD, EUR). */
export function seedRegionalDefaults(configByKey) {
  seedAudDefaults(configByKey);
  return seedEurDefaults(configByKey);
}
