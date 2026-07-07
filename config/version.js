/**
 * Backend build version — bump this on every deploy so `/api/get-version`
 * reveals exactly which build is live in production.
 *
 * Rule: increase the LAST segment by one on each update
 *   1.0.0.0.0.1  ->  1.0.0.0.0.2  ->  1.0.0.0.0.3  ...
 *
 * Keep a one-line note in CHANGES for the most recent bump so the version is
 * traceable to what changed.
 */
export const APP_VERSION = '1.0.0.0.0.1';

// Most recent change shipped under APP_VERSION (newest first).
export const APP_VERSION_NOTE =
  'Kalpataru BDA reminder routing + "Assigned BDA" line in meet reminder message';

export default { APP_VERSION, APP_VERSION_NOTE };
