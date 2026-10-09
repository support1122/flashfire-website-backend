/**
 * Professional email signature and compliance footer for CRM-designed emails.
 *
 * Single source of truth: DesignedEmailTemplateController.wrapEmailShell uses these for
 * every send (workflow steps, cron sends, the builder's manual Send), and the CRM
 * builder fetches the same markup for its live preview, so what the team sees is what
 * clients receive.
 *
 * What it deliberately does NOT contain: a personal name. Each template already ends
 * with its own sign-off ("Regards, Onboarding Team, Flashfire" or "Talk soon, Elizabeth"),
 * and the name differs per template. A name here would sign every email off twice. The
 * signature carries the brand and the contact details instead.
 *
 * The postal address sits in the footer and is always rendered. A commercial email
 * should carry a valid physical address (CAN-SPAM), and the unsubscribe link is only
 * present when a SendGrid unsubscribe group is configured, so the address must not
 * depend on it.
 *
 * Markup is table-based with inline styles only: Outlook and Gmail strip <style> blocks
 * and ignore most modern CSS. No images, so nothing is blocked by "load images" prompts.
 */

const env = (key, fallback) => process.env[key] || fallback;

export const EMAIL_BRAND = {
  name: 'Flashfire',
  accent: '#ea580c',
  website: env('EMAIL_SIGNATURE_WEBSITE', 'https://www.flashfirejobs.com'),
  websiteLabel: env('EMAIL_SIGNATURE_WEBSITE_LABEL', 'flashfirejobs.com'),
  supportEmail: env('EMAIL_SIGNATURE_SUPPORT_EMAIL', 'support@flashfirejobs.com'),
  tagline: env(
    'EMAIL_SIGNATURE_TAGLINE',
    'We apply to jobs on your behalf in Europe, the UK, USA, Canada and Australia.'
  ),
  legalName: env('EMAIL_SIGNATURE_LEGAL_NAME', 'Flashfire LLC'),
  address: env('EMAIL_SIGNATURE_ADDRESS', '30 N Gould St, STE R, Sheridan, WY 82801, USA'),
  socials: [
    { label: 'LinkedIn', url: 'https://www.linkedin.com/company/flashfire-pvt-ltd/' },
    { label: 'Instagram', url: 'https://www.instagram.com/flashfirejobs/' },
    { label: 'YouTube', url: 'https://www.youtube.com/@flashfireindia' },
  ],
};

const FONT = 'Arial,Helvetica,sans-serif';
const MUTED = '#6b7280';
const TEXT = '#1f2937';

const link = (href, label, color = TEXT) =>
  `<a href="${href}" target="_blank" rel="noopener" style="color:${color};text-decoration:none;">${label}</a>`;

/**
 * The signature block, as a table row ready to sit inside the 600px card.
 * Returns only the <tr>, so the caller controls the surrounding table.
 */
export function renderEmailSignatureRow() {
  const b = EMAIL_BRAND;
  const dot = `<span style="color:#d1d5db;">&nbsp;&nbsp;|&nbsp;&nbsp;</span>`;
  const socials = b.socials.map((s) => link(s.url, s.label, MUTED)).join(dot);

  return `  <tr><td style="padding:6px 44px 30px;font-family:${FONT};">
    <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-top:2px solid ${b.accent};">
      <tr><td style="padding-top:16px;font-family:${FONT};font-size:15px;font-weight:700;letter-spacing:2px;color:${b.accent};">
        ${link(b.website, b.name.toUpperCase(), b.accent)}
      </td></tr>
      <tr><td style="padding-top:4px;font-family:${FONT};font-size:12.5px;line-height:1.55;color:${MUTED};">
        ${b.tagline}
      </td></tr>
      <tr><td style="padding-top:10px;font-family:${FONT};font-size:13px;line-height:1.6;color:${TEXT};">
        ${link(`mailto:${b.supportEmail}`, b.supportEmail)}${dot}${link(b.website, b.websiteLabel)}
      </td></tr>
      <tr><td style="padding-top:6px;font-family:${FONT};font-size:12.5px;line-height:1.6;">
        ${socials}
      </td></tr>
    </table>
  </td></tr>`;
}

/**
 * Compliance footer: postal address always, unsubscribe when one is available.
 * @param {{ unsubscribeHref?: string|null }} opts  pass null/undefined to omit the link
 */
export function renderEmailFooterRow({ unsubscribeHref = null } = {}) {
  const b = EMAIL_BRAND;
  const unsub = unsubscribeHref
    ? `<br/>Don't want these emails? <a href="${unsubscribeHref}" style="color:#9ca3af;text-decoration:underline;">Unsubscribe</a>.`
    : '';

  return `  <tr><td style="padding:14px 44px 26px;font-family:${FONT};font-size:11px;line-height:1.6;color:#9ca3af;text-align:center;border-top:1px solid #f1f1f1;">
    ${b.legalName} &middot; ${b.address}${unsub}
  </td></tr>`;
}

/** Both rows, for the CRM preview. The unsubscribe link is inert there. */
export function renderEmailSignaturePreview({ withUnsubscribe = false } = {}) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">
${renderEmailSignatureRow()}
${renderEmailFooterRow({ unsubscribeHref: withUnsubscribe ? '#' : null })}
</table>`;
}
