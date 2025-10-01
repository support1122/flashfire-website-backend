const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com', 'tempmail.com', '10minutemail.com', 'guerrillamail.com',
  'yopmail.com', 'trashmail.com', 'dispostable.com', 'mintemail.com',
  'maildrop.cc', 'sharklasers.com', 'grr.la', 'mail-temporaire.fr',
  'getnada.com', 'temp-mail.org'
]);

const SUSPICIOUS_KEYWORDS = [
  'test', 'spam', 'fake', 'bot', 'fraud', 'scam'
];

export function extractDomain(email) {
  if (!email || typeof email !== 'string') return '';
  const idx = email.lastIndexOf('@');
  if (idx === -1) return '';
  return email.slice(idx + 1).trim().toLowerCase();
}

export function isDisposableDomain(domain) {
  if (!domain) return false;
  return DISPOSABLE_DOMAINS.has(domain);
}

export function hasSuspiciousLocalPart(email) {
  if (!email) return false;
  const local = email.split('@')[0].toLowerCase();
  return SUSPICIOUS_KEYWORDS.some(k => local.includes(k));
}

export function basicFraudCheck({ email, name, utmSource }) {
  const reasons = [];
  const domain = extractDomain(email);

  if (!email || !email.includes('@')) {
    reasons.push('invalid_email');
  }
  if (isDisposableDomain(domain)) {
    reasons.push('disposable_domain');
  }
  if (hasSuspiciousLocalPart(email)) {
    reasons.push('suspicious_local_part');
  }
  if (utmSource && typeof utmSource === 'string' && utmSource.toLowerCase().includes('bot')) {
    reasons.push('suspicious_utm_source');
  }
  if (name && name.trim().split(' ').length <= 1) {
    reasons.push('incomplete_name');
  }

  const flagged = reasons.length > 0;
  return { flagged, reasons };
}


