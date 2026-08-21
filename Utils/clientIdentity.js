/**
 * One client, one identity — used to decide whether two bookings are the same person.
 *
 * A client can appear as several booking rows: they book, cancel, rebook, or come in
 * again through a Meta lead form. Anything that must reason about "this client" rather
 * than "this booking" (claim ownership, BDA credit) has to collapse those rows first.
 *
 * The key is EMAIL or PHONE, matched independently — sharing either one is enough,
 * because people re-book with the same phone but a different email and vice versa.
 * Phone is compared on the last 10 digits (normalizePhoneForMatching), so "+1 234 567
 * 8900", "+12345678900" and "2345678900" are the same person rather than three.
 *
 * NAME IS DELIBERATELY NOT PART OF THE KEY. In production data 166 names are shared by
 * multiple distinct email+phone pairs — "neha" alone spans 10 emails and 9 phones. On
 * name, those strangers would merge into one client and one BDA would wrongly lock
 * everyone else out of the lead. Name stays a display label only.
 */

import { normalizePhoneForMatching } from './normalizePhoneForMatching.js';

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Lower-cased trimmed email, or null when there isn't a usable one. */
export function normalizeEmailForMatching(email) {
  const e = String(email || '').trim().toLowerCase();
  return e.includes('@') ? e : null;
}

/**
 * A Mongo filter matching every booking that belongs to the same person as `booking`.
 * Returns null when the booking carries neither a usable email nor phone, in which case
 * the caller must fall back to the single booking rather than matching everything.
 */
export function buildClientIdentityQuery(booking) {
  const email = normalizeEmailForMatching(booking?.clientEmail);
  const phone = normalizePhoneForMatching(booking?.clientPhone) || booking?.normalizedClientPhone || null;

  const or = [];
  if (email) or.push({ clientEmail: email });
  if (phone) {
    or.push({ normalizedClientPhone: phone });
    // Legacy rows never had normalizedClientPhone written; match them on the raw
    // number's last 10 digits so an old booking still counts as the same client.
    or.push({ clientPhone: { $regex: escapeRegex(phone) + '$' } });
  }
  return or.length ? { $or: or } : null;
}

/**
 * Every booking for the same client, oldest first.
 * Falls back to just this booking when there is nothing to match on.
 */
export async function findClientBookings(BookingModel, booking, projection = null) {
  const query = buildClientIdentityQuery(booking);
  if (!query) return [booking];
  const cursor = BookingModel.find(query, projection || undefined).sort({ bookingCreatedAt: 1 });
  return cursor.lean();
}

/**
 * The BDA who owns this client: the first one ever assigned across ALL of the client's
 * bookings, oldest booking first. A manual claim on any of their bookings counts too,
 * so a lead someone already claimed cannot be taken by a different BDA on a later row.
 *
 * Returns null when nobody owns the client yet — that lead is free to claim.
 */
export function resolveClientOwner(bookings) {
  const sorted = [...bookings].sort(
    (a, b) => new Date(a?.bookingCreatedAt || 0) - new Date(b?.bookingCreatedAt || 0),
  );
  for (const b of sorted) {
    const owner = normalizeEmailForMatching(b?.originalBda?.email);
    if (owner) {
      return { email: owner, name: b.originalBda.name || owner, via: 'originalBda', bookingId: b.bookingId, at: b.bookingCreatedAt };
    }
    const claimed = normalizeEmailForMatching(b?.claimedBy?.email);
    if (claimed) {
      return { email: claimed, name: b.claimedBy.name || claimed, via: 'claim', bookingId: b.bookingId, at: b.claimedBy?.claimedAt || b.bookingCreatedAt };
    }
  }
  return null;
}

/**
 * Resolve the lead owner for a PAGE of bookings.
 *
 * The owner is a property of the client, not of the row: Valli Suresh books five
 * times, Calendly round-robins each meeting, and every row ends up showing a
 * different BDA. All five must show the one BDA who took the first meeting.
 *
 * Works in two queries regardless of page size: one to pull every booking sharing an
 * email or phone with anything on this page, then union-find to link rows that agree
 * on either key (a mistyped email still links by phone, which is exactly how
 * valli.s2400@gmaul.com stays attached to valli.s2400@gmail.com).
 *
 * Returns Map<bookingId, { email, name, via, bookingId, at }>.
 */
export async function resolveLeadOwnersForPage(BookingModel, pageBookings) {
  const owners = new Map();
  if (!Array.isArray(pageBookings) || pageBookings.length === 0) return owners;

  const emails = new Set();
  const phones = new Set();
  for (const b of pageBookings) {
    const e = normalizeEmailForMatching(b?.clientEmail);
    const p = normalizePhoneForMatching(b?.clientPhone) || b?.normalizedClientPhone || null;
    if (e) emails.add(e);
    if (p) phones.add(p);
  }
  if (emails.size === 0 && phones.size === 0) return owners;

  const or = [];
  if (emails.size) or.push({ clientEmail: { $in: [...emails] } });
  if (phones.size) or.push({ normalizedClientPhone: { $in: [...phones] } });
  const related = await BookingModel.find(
    { $or: or },
    { bookingId: 1, clientEmail: 1, clientPhone: 1, normalizedClientPhone: 1, bookingCreatedAt: 1, originalBda: 1, claimedBy: 1 },
  ).lean();

  // Union-find over email and phone keys so either one links two rows.
  const parent = new Map();
  const find = (x) => {
    while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); }
    return x;
  };
  const add = (k) => { if (!parent.has(k)) parent.set(k, k); };
  const union = (a, b) => { add(a); add(b); const ra = find(a); const rb = find(b); if (ra !== rb) parent.set(ra, rb); };

  const keysOf = (b) => {
    const e = normalizeEmailForMatching(b?.clientEmail);
    const p = normalizePhoneForMatching(b?.clientPhone) || b?.normalizedClientPhone || null;
    const ks = [];
    if (e) ks.push(`e:${e}`);
    if (p) ks.push(`p:${p}`);
    return ks;
  };

  const pool = related.length ? related : pageBookings;
  for (const b of pool) {
    const ks = keysOf(b);
    ks.forEach(add);
    for (let i = 1; i < ks.length; i += 1) union(ks[0], ks[i]);
  }

  // Group every related booking under its identity root, then resolve one owner each.
  const groups = new Map();
  for (const b of pool) {
    const ks = keysOf(b);
    if (!ks.length) continue;
    const root = find(ks[0]);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(b);
  }
  const ownerByRoot = new Map();
  for (const [root, rows] of groups) ownerByRoot.set(root, resolveClientOwner(rows));

  for (const b of pageBookings) {
    const ks = keysOf(b);
    if (!ks.length) continue;
    if (!parent.has(ks[0])) continue;
    const owner = ownerByRoot.get(find(ks[0]));
    if (owner) owners.set(b.bookingId, owner);
  }
  return owners;
}
