// Parse a Calendly Notetaker recap email (the "Summary" emails from notifications@calendly.com) into fields.
//
// Calendly's wording can change, so nothing here depends on one exact layout: the summary is the body up to
// "Ask Notetaker" (what the old Apps Script forwarded to Discord), section headings are recognised loosely, and the
// invitee name is taken from the common subject shapes. Whatever cannot be parsed is simply null; the raw text is
// always kept, so a later parser can re-read old recaps.
import { foldName } from './BdaIdentity.js';

const MAX_SUMMARY_CHARS = 20000;

/** Common subject shapes: "... with Jane Doe", "... with Jane Doe on Oct 8", "... between A and B". */
export function inviteeNameFromSubject(subject) {
  const s = String(subject || '').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  const between = s.match(/\bbetween\s+(.+?)\s+and\s+(.+?)\s*$/i);
  if (between) return [between[1].trim(), between[2].trim()];
  const withMatch = s.match(/\bwith\s+(.+?)(?:\s+(?:on|at|-|–|\|)\s+.*)?\s*$/i);
  if (withMatch) return [withMatch[1].replace(/[.!]+$/, '').trim()];
  return null;
}

const HEADING_RE = /^\s*(summary|meeting summary|overview|action items?|next steps|key (?:points|takeaways|topics)|highlights|topics|attendees|participants|questions?)\s*:?\s*$/i;

/** Split the body into { heading -> text } using lines that look like section headings. */
export function splitSections(body) {
  const sections = {};
  let current = 'preamble';
  for (const line of String(body || '').split(/\r?\n/)) {
    const m = line.match(HEADING_RE);
    if (m) {
      current = m[1].toLowerCase().replace(/\s+/g, ' ');
      if (current === 'meeting summary' || current === 'overview') current = 'summary';
      if (current === 'action item') current = 'action items';
      if (current === 'participants') current = 'attendees';
      sections[current] = sections[current] || '';
      continue;
    }
    sections[current] = (sections[current] || '') + line + '\n';
  }
  for (const k of Object.keys(sections)) sections[k] = sections[k].trim();
  return sections;
}

/** The link to the recap in Calendly, if the email carried one. */
export function recapUrlFrom(links = [], body = '') {
  const all = [...(Array.isArray(links) ? links : []), ...(String(body).match(/https?:\/\/[^\s<>"')]+/g) || [])];
  const calendly = all.filter((u) => /^https?:\/\/([a-z0-9-]+\.)*calendly\.com\//i.test(u));
  return (
    calendly.find((u) => /recap|notetaker|meeting[_-]?notes|notes/i.test(u)) ||
    calendly.find((u) => !/unsubscribe|preferences|help|support|privacy|terms/i.test(u)) ||
    null
  );
}

/** Names listed under an Attendees/Participants heading, one per line or comma-separated. */
export function attendeesFrom(sections) {
  const text = sections?.attendees;
  if (!text) return [];
  return text
    .split(/\r?\n|,/)
    .map((x) => x.replace(/^[\s•\-*·]+/, '').replace(/\s*\(.*?\)\s*$/, '').trim())
    .filter((x) => x && x.length <= 80 && /[a-z]/i.test(x))
    .slice(0, 30);
}

/**
 * @param {{ subject: string, plainBody: string, links?: string[] }} email
 * @returns {{ inviteeNames: string[], summary: string, sections: object, recapUrl: string|null, attendees: string[], foldedText: string }}
 */
export function parseRecapEmail({ subject, plainBody, links }) {
  let body = String(plainBody || '');
  const cut = body.search(/\bAsk Notetaker\b/i);
  if (cut !== -1) body = body.slice(0, cut);
  body = body.trim();
  const sections = splitSections(body);
  const summary = (sections.summary || body).slice(0, MAX_SUMMARY_CHARS);
  return {
    inviteeNames: inviteeNameFromSubject(subject) || [],
    summary,
    sections,
    recapUrl: recapUrlFrom(links, plainBody),
    attendees: attendeesFrom(sections),
    // For matching: folded subject + the top of the body (homoglyphs, accents and punctuation removed).
    foldedText: foldName(`${subject || ''} ${body.slice(0, 3000)}`),
  };
}
