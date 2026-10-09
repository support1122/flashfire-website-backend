// Find the booking a Calendly Notetaker recap email belongs to.
//
// The recap arrives a few minutes after the meeting ends. Candidates are bookings that started in the 12 hours
// before the email (and up to 5 minutes after, for clock skew). Each is scored on evidence, and a recap is linked
// only when one booking clearly wins. Anything else is stored as unmatched for an admin to link: a wrong link would
// put another client's notes on a meeting, which is worse than no link.
import { foldName } from './BdaIdentity.js';
import { getAssignedBdaEmail } from './BdaAssignment.js';

export const MATCH_MIN_SCORE = 6;
export const MATCH_MIN_LEAD = 3;
const LOOKBACK_MS = 12 * 60 * 60 * 1000;
const LOOKAHEAD_MS = 5 * 60 * 1000;

const toMs = (d) => (d instanceof Date ? d.getTime() : new Date(d).getTime());
const tokens = (s) => foldName(s).split(' ').filter((t) => t.length >= 3);

/**
 * Pure scoring. Returns [{ booking, score, why: string[] }] sorted best first.
 * @param {object[]} bookings candidate bookings
 * @param {{ foldedText: string, plainBody: string, inviteeNames: string[], account?: string, sentAtMs: number }} recap
 */
export function scoreCandidates(bookings, recap) {
  const text = ` ${recap.foldedText} `;
  const bodyLower = String(recap.plainBody || '').toLowerCase();
  const subjectNames = (recap.inviteeNames || []).map(foldName).filter(Boolean);
  const account = String(recap.account || '').trim().toLowerCase();

  const out = [];
  for (const b of bookings || []) {
    let score = 0;
    const why = [];
    const email = String(b.clientEmail || '').trim().toLowerCase();
    if (email && bodyLower.includes(email)) {
      score += 10;
      why.push('client_email_in_body');
    }

    const full = foldName(b.clientName);
    if (full && subjectNames.some((n) => n === full || n.includes(full) || full.includes(n))) {
      score += 6;
      why.push('client_name_in_subject');
    } else if (full && text.includes(` ${full} `)) {
      score += 5;
      why.push('client_name_in_text');
    } else {
      const hits = tokens(b.clientName).filter((t) => text.includes(` ${t} `)).length;
      if (hits) {
        score += 2 * hits;
        why.push(`client_name_tokens:${hits}`);
      }
    }

    // Recaps come after the meeting: within 3 hours of its scheduled end is the expected shape.
    const endMs = b.scheduledEventEndTime ? toMs(b.scheduledEventEndTime) : toMs(b.scheduledEventStartTime) + 30 * 60 * 1000;
    if (recap.sentAtMs >= endMs - 10 * 60 * 1000 && recap.sentAtMs <= endMs + 3 * 60 * 60 * 1000) {
      score += 2;
      why.push('sent_after_meeting');
    }

    // The script runs in a Gmail inbox. When that inbox is the assigned BDA's, it is their meeting's recap.
    if (account) {
      const assigned = getAssignedBdaEmail(b);
      if (assigned && assigned === account) {
        score += 3;
        why.push('inbox_is_assigned_bda');
      }
    }
    out.push({ booking: b, score, why });
  }
  return out.sort((a, b) => b.score - a.score);
}

/** Decide from scored candidates: { status: 'matched'|'ambiguous'|'unmatched', best, score, lead, why } */
export function decideMatch(scored) {
  const [best, second] = scored;
  if (!best || best.score < MATCH_MIN_SCORE) {
    return { status: 'unmatched', best: best || null, score: best?.score ?? 0, lead: null, why: best?.why ?? [] };
  }
  const lead = best.score - (second?.score ?? 0);
  if (second && lead < MATCH_MIN_LEAD) return { status: 'ambiguous', best, score: best.score, lead, why: best.why };
  return { status: 'matched', best, score: best.score, lead, why: best.why };
}

/** Load candidates from the database and decide. */
export async function matchRecapToBooking(recap) {
  const { CampaignBookingModel } = await import('../Schema_Models/CampaignBooking.js');
  const candidates = await CampaignBookingModel.find({
    scheduledEventStartTime: { $gte: new Date(recap.sentAtMs - LOOKBACK_MS), $lte: new Date(recap.sentAtMs + LOOKAHEAD_MS) },
  })
    .select('bookingId clientName clientEmail scheduledEventStartTime scheduledEventEndTime calendlyHost claimedBy attendanceAssignee bookingStatus')
    .limit(300)
    .lean();
  return decideMatch(scoreCandidates(candidates, recap));
}
