/** Grace after scheduled start before No Show / Completed are allowed (ms). */
export const POST_MEETING_GRACE_MS = 5 * 60 * 1000;

/**
 * @param {Date|string|null|undefined} scheduledEventStartTime
 * @param {'no-show'|'completed'} targetStatus
 * @returns {{ ok: true } | { ok: false, message: string }}
 */
export function validatePostMeetingBookingStatus(scheduledEventStartTime, targetStatus) {
  if (targetStatus !== 'no-show' && targetStatus !== 'completed') {
    return { ok: true };
  }

  if (scheduledEventStartTime == null || scheduledEventStartTime === '') {
    return {
      ok: false,
      message:
        'No Show and Completed require a scheduled meeting time. Add or fix the meeting time first.',
    };
  }

  const startMs =
    scheduledEventStartTime instanceof Date
      ? scheduledEventStartTime.getTime()
      : new Date(scheduledEventStartTime).getTime();

  if (Number.isNaN(startMs)) {
    return {
      ok: false,
      message: 'Invalid scheduled meeting time; cannot set No Show or Completed.',
    };
  }

  const earliestAllowed = startMs + POST_MEETING_GRACE_MS;
  if (Date.now() < earliestAllowed) {
    return {
      ok: false,
      message:
        'No Show and Completed are only allowed at least 5 minutes after the scheduled meeting start.',
    };
  }

  return { ok: true };
}
