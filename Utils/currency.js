/**
 * Currency display for payment plans. Backend mirror of
 * flashfire-CRM/src/utils/currency.ts — keep the two in sync.
 *
 * `paymentPlan.currency` is not consistent in the database: older rows store the raw
 * symbol ("$", "₹") while newer ones store an ISO code ("USD", "CAD"). Everything here
 * accepts both, so no migration is required and legacy rows keep rendering correctly.
 */

export const CURRENCY_SYMBOLS = {
  USD: '$',
  CAD: 'CA$',
  EUR: '€',
  INR: '₹',
  GBP: '£',
  AUD: 'A$',
};

/** Legacy rows store the symbol itself instead of an ISO code — map those back. */
const LEGACY_SYMBOL_TO_CODE = {
  $: 'USD',
  'CA$': 'CAD',
  '€': 'EUR',
  '₹': 'INR',
  '£': 'GBP',
  'A$': 'AUD',
};

/** Any stored currency value (ISO code or raw symbol) -> ISO code. Unknown -> USD. */
export function normalizeCurrency(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return 'USD';
  if (LEGACY_SYMBOL_TO_CODE[value]) return LEGACY_SYMBOL_TO_CODE[value];
  const upper = value.toUpperCase();
  return CURRENCY_SYMBOLS[upper] ? upper : 'USD';
}

export function currencySymbol(raw) {
  return CURRENCY_SYMBOLS[normalizeCurrency(raw)] ?? '$';
}

/** "€599", "CA$749". Empty string when there is no usable amount. */
export function formatMoney(amount, raw) {
  if (amount == null || Number.isNaN(Number(amount))) return '';
  return `${currencySymbol(raw)}${Number(amount)}`;
}
