// Covers the REMINDER_FORCE_EASTERN=false path: each client sees their own local
// meeting time with a generic label (ET / CT / MT / PT). Set before importing,
// because the policy constant is read once at module load — hence dynamic imports.
process.env.REMINDER_FORCE_EASTERN = 'false';

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

const START = new Date('2026-08-21T21:00:00.000Z'); // 5pm New York, 2pm Los Angeles
const END = new Date('2026-08-21T21:15:00.000Z');

let buildTemplateParameters;
let FORCE_EASTERN_DISPLAY;

before(async () => {
  ({ buildTemplateParameters } = await import('../Utils/TemplateParameterBuilder.js'));
  ({ FORCE_EASTERN_DISPLAY } = await import('../Utils/MeetingReminderUtils.js'));
});

const display = async (tz) => {
  const p = await buildTemplateParameters('flashfire_appointment_reminder_b', {
    booking: {
      clientName: 'Test Client',
      scheduledEventStartTime: START,
      scheduledEventEndTime: END,
      inviteeTimezone: tz,
      calendlyMeetLink: 'https://meet.google.com/abc-defg-hij',
      calendlyRescheduleLink: 'https://calendly.com/reschedulings/8e172654',
    },
  });
  return { date: p[1], time: p[2] };
};

describe('per-client local zone (REMINDER_FORCE_EASTERN=false)', () => {
  it('reads the env switch as off', () => {
    assert.equal(FORCE_EASTERN_DISPLAY, false);
  });

  it('renders each client their own wall clock', async () => {
    assert.equal((await display('America/Los_Angeles')).time, '2pm – 2:15pm PT');
    assert.equal((await display('America/Chicago')).time, '4pm – 4:15pm CT');
    assert.equal((await display('America/New_York')).time, '5pm – 5:15pm ET');
    assert.equal((await display('America/Denver')).time, '3pm – 3:15pm MT');
  });

  it('still avoids daylight/standard variants', async () => {
    for (const tz of ['America/Los_Angeles', 'America/Chicago', 'America/Phoenix', 'America/New_York']) {
      const { time } = await display(tz);
      assert.ok(!/\b(EST|EDT|CST|CDT|MST|MDT|PST|PDT)\b/.test(time), `${tz} leaked a DST label: ${time}`);
    }
  });

  it('rolls the date when the client zone crosses midnight', async () => {
    assert.equal((await display('Asia/Kolkata')).date, 'Aug 22');
    assert.equal((await display('America/Los_Angeles')).date, 'Aug 21');
  });
});
