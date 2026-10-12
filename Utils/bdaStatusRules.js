/**
 * What a BDA may do with a lead's status, and why a lead was ignored.
 *
 * BDAs only record the outcome of a meeting: Completed, No Show, Paid or Ignored.
 * Scheduled / Rescheduled / Canceled / Not Scheduled come from Calendly and the
 * automations, or from an admin. Marking a lead Ignored needs a reason so admins
 * can see why leads are being dropped.
 *
 * The CRM mirrors these lists in src/utils/bdaStatusOptions.ts. Keep them in sync.
 */

export const BDA_SETTABLE_STATUSES = ['completed', 'no-show', 'paid', 'ignored'];

export const IGNORE_REASONS = [
  { code: 'not_interested', label: 'Not interested' },
  { code: 'invalid_contact', label: 'Wrong or invalid contact details' },
  { code: 'duplicate', label: 'Duplicate lead' },
  { code: 'not_eligible', label: 'Not eligible (location, visa or experience)' },
  { code: 'budget', label: "Can't afford a plan" },
  { code: 'spam', label: 'Spam or fake lead' },
  { code: 'other', label: 'Other' },
];

export const IGNORE_NOTE_MAX_LENGTH = 500;

const REASON_BY_CODE = new Map(IGNORE_REASONS.map((r) => [r.code, r]));

/**
 * @param {{ status: string, statusSource: string }} input
 * @returns {{ ok: true } | { ok: false, message: string }}
 */
export function checkBdaStatusAllowed({ status, statusSource }) {
  if (statusSource !== 'bda') return { ok: true };
  if (BDA_SETTABLE_STATUSES.includes(status)) return { ok: true };
  return {
    ok: false,
    message: 'BDAs can only mark a lead Completed, No Show, Paid or Ignored.',
  };
}

/**
 * Validate the `ignoreReason` body field. The label always comes from the server
 * list, never from the request, so a tampered label cannot reach the database.
 *
 * @param {unknown} raw  `{ code, note? }` from the request body
 * @param {{ required: boolean }} opts
 * @returns {{ ok: true, value: { code: string, label: string, note: string|null } | null }
 *          | { ok: false, message: string }}
 */
export function parseIgnoreReason(raw, { required }) {
  if (raw == null || raw === '') {
    return required
      ? { ok: false, message: 'Pick a reason before marking the lead Ignored.' }
      : { ok: true, value: null };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, message: 'ignoreReason must be an object with a code.' };
  }

  const code = typeof raw.code === 'string' ? raw.code.trim() : '';
  const reason = REASON_BY_CODE.get(code);
  if (!reason) {
    return { ok: false, message: 'Unknown ignore reason. Pick one from the list.' };
  }

  if (raw.note != null && typeof raw.note !== 'string') {
    return { ok: false, message: 'The ignore note must be text.' };
  }
  const note = typeof raw.note === 'string' ? raw.note.trim() : '';
  if (note.length > IGNORE_NOTE_MAX_LENGTH) {
    return { ok: false, message: `Keep the note under ${IGNORE_NOTE_MAX_LENGTH} characters.` };
  }
  if (code === 'other' && !note) {
    return { ok: false, message: 'Write a short reason when picking "Other".' };
  }

  return { ok: true, value: { code, label: reason.label, note: note || null } };
}

/** One-line text for the status history entry, e.g. "Duplicate lead: same person, booked twice". */
export function formatIgnoreReason(reason) {
  if (!reason) return null;
  return reason.note ? `${reason.label}: ${reason.note}` : reason.label;
}
