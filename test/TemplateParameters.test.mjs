import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildTemplateParameters, calendlyButtonTail } from '../Utils/TemplateParameterBuilder.js';

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
