import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildTemplateParameters, calendlyButtonTail, calendlyCancelTail } from '../Utils/TemplateParameterBuilder.js';

// 2026-08-21T21:00Z is 5pm Eastern, 2pm Pacific, 4pm Central, 2:30am IST the next day.
const START = new Date('2026-08-21T21:00:00.000Z');
const END = new Date('2026-08-21T21:15:00.000Z');

const booking = (inviteeTimezone) => ({
  clientName: 'Test Client',
  scheduledEventStartTime: START,
  scheduledEventEndTime: END,
  inviteeTimezone,
  calendlyMeetLink: 'https://meet.google.com/abc-defg-hij',
  calendlyRescheduleLink: 'https://calendly.com/reschedulings/8e172654',
});

// params[1] = date, params[2] = time with timezone
const display = async (tz) => {
  const p = await buildTemplateParameters('flashfire_appointment_reminder_b', { booking: booking(tz) });
  return { date: p[1], time: p[2] };
};

describe('appointment reminder meeting time', () => {
  it('renders the clock in the invitee timezone, not Eastern', async () => {
    const pacific = await display('America/Los_Angeles');
    assert.equal(pacific.time, '2pm – 2:15pm PDT');

    const central = await display('America/Chicago');
    assert.equal(central.time, '4pm – 4:15pm CDT');

    const eastern = await display('America/New_York');
    assert.equal(eastern.time, '5pm – 5:15pm EDT');
  });

  it('rolls the date when the invitee timezone crosses midnight', async () => {
    const india = await display('Asia/Kolkata');
    assert.equal(india.date, 'Aug 22');
    assert.equal(india.time, '2:30am – 2:45am IST');
  });

  it('does not label a non-Eastern zone as ET', async () => {
    for (const tz of ['America/Los_Angeles', 'America/Chicago', 'America/Phoenix', 'Asia/Kolkata']) {
      const { time } = await display(tz);
      assert.ok(!/\bET\b/.test(time), `${tz} was labelled ET: ${time}`);
    }
  });

  it('uses the real abbreviation for zones the US offset heuristic mislabelled', async () => {
    // Phoenix does not observe DST — the -7 offset guess used to call it PST.
    const { time } = await display('America/Phoenix');
    assert.match(time, /MST$/);
  });

  it('falls back to Eastern when the booking carries no usable zone', async () => {
    assert.equal((await display(null)).time, '5pm – 5:15pm ET');
    assert.equal((await display('Not/AZone')).time, '5pm – 5:15pm ET');
  });
});

describe('reschedule button tail', () => {
  it('sends only the path after calendly.com', () => {
    assert.equal(calendlyButtonTail('https://calendly.com/reschedulings/8e172654'), 'reschedulings/8e172654');
  });

  it('unwraps Google redirect wrappers', () => {
    const wrapped = 'https://www.google.com/url?q=https%3A%2F%2Fcalendly.com%2Freschedulings%2Fabc&sa=D';
    assert.equal(calendlyButtonTail(wrapped), 'reschedulings/abc');
  });

  it('falls back to the booking page for non-calendly links', () => {
    assert.equal(calendlyButtonTail('https://meet.google.com/xyz'), 'feedback-flashfire/15min');
    assert.equal(calendlyButtonTail(null), 'feedback-flashfire/15min');
  });

  it('is the 6th parameter of the _b template', async () => {
    const p = await buildTemplateParameters('flashfire_appointment_reminder_b', { booking: booking('America/New_York') });
    assert.equal(p.length, 6);
    assert.equal(p[5], 'reschedulings/8e172654');
  });

  it('is absent from the buttonless template', async () => {
    const p = await buildTemplateParameters('flashfire_appointment_reminder', { booking: booking('America/New_York') });
    assert.equal(p.length, 5);
  });
});

describe('cancel button tail', () => {
  it('uses an explicit cancel link when present', () => {
    assert.equal(calendlyCancelTail('https://calendly.com/cancellations/abc-123', null), 'cancellations/abc-123');
  });

  it('derives the cancel tail from the reschedule link', () => {
    // Calendly issues both URLs with the same invitee uuid.
    assert.equal(calendlyCancelTail(null, 'https://calendly.com/reschedulings/abc-123'), 'cancellations/abc-123');
  });

  it('prefers the explicit cancel link over the derived one', () => {
    assert.equal(
      calendlyCancelTail('https://calendly.com/cancellations/aaa', 'https://calendly.com/reschedulings/bbb'),
      'cancellations/aaa'
    );
  });

  it('unwraps Google redirect wrappers before deriving', () => {
    const wrapped = 'https://www.google.com/url?q=https%3A%2F%2Fcalendly.com%2Freschedulings%2Fxyz&sa=D';
    assert.equal(calendlyCancelTail(null, wrapped), 'cancellations/xyz');
  });

  it('returns null rather than inventing a target', () => {
    // A "Cancel" button pointing at a booking page is worse than no button.
    assert.equal(calendlyCancelTail(null, 'https://calendly.com/feedback-flashfire/15min'), null);
    assert.equal(calendlyCancelTail(null, 'https://meet.google.com/xyz'), null);
    assert.equal(calendlyCancelTail(null, null), null);
  });
});

describe('flashfire_appointment_reminder_rc', () => {
  const rcBooking = (extra = {}) => ({
    clientName: 'Test Client',
    scheduledEventStartTime: START,
    scheduledEventEndTime: END,
    inviteeTimezone: 'America/New_York',
    calendlyMeetLink: 'https://meet.google.com/abc-defg-hij',
    calendlyRescheduleLink: 'https://calendly.com/reschedulings/8e172654',
    ...extra,
  });

  it('sends 7 params with reschedule at {{6}} and cancel at {{7}}', async () => {
    const p = await buildTemplateParameters('flashfire_appointment_reminder_rc', { booking: rcBooking() });
    assert.equal(p.length, 7);
    assert.equal(p[5], 'reschedulings/8e172654');
    assert.equal(p[6], 'cancellations/8e172654');
  });

  it('uses the stored cancel link when the booking has one', async () => {
    const p = await buildTemplateParameters('flashfire_appointment_reminder_rc', {
      booking: rcBooking({ calendlyCancelLink: 'https://calendly.com/cancellations/from-webhook' }),
    });
    assert.equal(p[6], 'cancellations/from-webhook');
  });

  it('refuses to build when no cancel target can be derived', async () => {
    await assert.rejects(
      () => buildTemplateParameters('flashfire_appointment_reminder_rc', {
        booking: rcBooking({ calendlyRescheduleLink: 'https://calendly.com/feedback-flashfire/15min' }),
      }),
      /No cancel link available/
    );
  });

  it('renders the meeting time in the invitee zone, same as the other templates', async () => {
    const p = await buildTemplateParameters('flashfire_appointment_reminder_rc', {
      booking: rcBooking({ inviteeTimezone: 'America/Los_Angeles' }),
    });
    assert.equal(p[2], '2pm – 2:15pm PDT');
  });
});
