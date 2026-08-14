/**
 * Meta lead metadata sometimes arrives as an ERROR MESSAGE instead of a value.
 *
 * When the Facebook user behind the Lead Ads → Google Sheet sync can read the Page but
 * not the ad account, Meta fills the campaign/adset/ad columns with the text
 * "You don't have enough permissions. Please refer to this help page: https://…"
 * rather than leaving them blank. The sheet stores that text like any other cell, so
 * without this guard it lands in utmCampaign / metaCampaignName / metaAdName and shows
 * up in the CRM as if it were the campaign's name. Id columns get the same text behind
 * a short prefix ("c:You don't have…", "ag:You don't have…"), which is why the match is
 * a substring test rather than a whole-string comparison.
 *
 * Storing null instead keeps the lead itself — only the unusable metadata is dropped.
 */

const ERROR_MARKERS = [
  /facebook\.com\/business\/help/i,
  /do(?:es)?n'?t have enough permission/i,
  /do(?:es)? not have enough permission/i,
  /insufficient permission/i,
  /unsupported (?:get|post) request/i,
  /invalid oauth(?: 2\.0)? access token/i,
  /error validating access token/i,
];

/** True when the value is an API error message masquerading as lead metadata. */
export function isMetaErrorValue(value) {
  if (typeof value !== 'string') return false;
  const s = value.trim();
  if (!s) return false;
  return ERROR_MARKERS.some((rx) => rx.test(s));
}

/**
 * The value to store: the original when it is real data, null when it is an error
 * message. Non-strings pass through untouched so callers can use this on any field.
 */
export function sanitizeMetaField(value) {
  return isMetaErrorValue(value) ? null : value;
}

/** Same rule applied across an object, returning a new object. */
export function sanitizeMetaFields(fields) {
  const out = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = sanitizeMetaField(value);
  }
  return out;
}
