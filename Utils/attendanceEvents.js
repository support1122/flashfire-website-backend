// In-process event bus between the attendance engine (emits) and the deduction engine (listens).
// It keeps the two modules from importing each other, so they can be built, tested and replaced apart.
//
// Payloads (all times are Date objects, bdaEmail is lowercase):
//   VERDICT            { bookingId, bdaEmail, verdict: 'present' | 'absent', verdictAt, scheduledStart, signals, healthy }
//                      `healthy` is false when a source the verdict depends on was unhealthy (plan 2.7), so the
//                      deduction must be created as needs_review instead of active.
//   VERDICT_CORRECTED  { bookingId, bdaEmail, correctedAt, signal }
//                      Late evidence flipped an absent verdict to present (plan 2.2). The linked missed_meeting
//                      deduction must become voided with reason `late_evidence`.
//   INTEGRITY_FLAGGED  { bookingId, bdaEmail, flaggedAt, signal }
import { EventEmitter } from 'node:events';

export const EVENTS = Object.freeze({
  VERDICT: 'attendance:verdict',
  VERDICT_CORRECTED: 'attendance:verdict_corrected',
  INTEGRITY_FLAGGED: 'attendance:integrity_flagged',
});

export const attendanceEvents = new EventEmitter();
attendanceEvents.setMaxListeners(20);

/** Emit without letting a listener's error break the verdict job. Errors are logged, never swallowed. */
export function emitAttendanceEvent(name, payload) {
  for (const listener of attendanceEvents.listeners(name)) {
    Promise.resolve()
      .then(() => listener(payload))
      .catch((err) => console.error(`[attendanceEvents] listener for ${name} failed:`, err?.message || err));
  }
}
