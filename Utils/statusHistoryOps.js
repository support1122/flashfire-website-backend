// statusHistory entries for status writes that use findOneAndUpdate/updateOne.
//
// CampaignBooking's pre-save hook appends to statusHistory only on .save(). A findOneAndUpdate that $sets
// bookingStatus skips it, so the history ends on an older status. Attendance reads the status AT START from that
// history (plan 2.1), so a Meta lead or a cancel+rebook merged back to 'scheduled' looked dead and was never judged.
// Every bypassing writer spreads these two helpers into its update.

/**
 * Fields to spread into the update's $set when the status changes. Empty when it does not.
 * @param {string|null|undefined} prevStatus status before this write
 * @param {string} nextStatus status this write sets
 * @param {{source: string, name?: string, email?: string|null}} actor
 * @param {Date} [at]
 */
export function statusChangeSet(prevStatus, nextStatus, actor, at = new Date()) {
  if (prevStatus === nextStatus) return {};
  return {
    statusChangedAt: at,
    statusChangeSource: actor.source,
    statusChangedBy: actor.email || actor.name || actor.source,
    statusChangedByName: actor.name || actor.source,
  };
}

/** Top-level `$push` to spread into the update object, or an empty object when the status does not change. */
export function statusHistoryPush(prevStatus, nextStatus, actor, at = new Date()) {
  if (prevStatus === nextStatus) return {};
  return {
    $push: {
      statusHistory: {
        status: nextStatus,
        previousStatus: prevStatus ?? null,
        changedByEmail: actor.email || null,
        changedByName: actor.name || actor.source,
        source: actor.source,
        changedAt: at,
      },
    },
  };
}

export const CALENDLY_ACTOR = Object.freeze({ source: 'calendly', name: 'Calendly' });
export const SYSTEM_ACTOR = Object.freeze({ source: 'system', name: 'System' });
