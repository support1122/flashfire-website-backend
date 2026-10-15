import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { expandDays, isRealLeaveDay } from '../Utils/LeaveRequests.js';
import { countableReason } from '../Utils/BdaAssignment.js';

// Pure logic only: no database, no network.

const SID = 'siddhartha@flashfirehq.com';
const tracked = (email, leaveDays = []) => ({ email, active: true, tracked: true, leaveDays });

describe('isRealLeaveDay', () => {
  it('accepts a real IST date', () => {
    assert.equal(isRealLeaveDay('2026-10-14'), true);
  });

  it('rejects the wrong shape', () => {
    for (const bad of ['14-10-2026', '2026-10', '2026/10/14', '', null, undefined]) {
      assert.equal(isRealLeaveDay(bad), false, `expected ${String(bad)} to be rejected`);
    }
  });

  it('rejects a date that does not exist', () => {
    assert.equal(isRealLeaveDay('2026-02-31'), false);
    assert.equal(isRealLeaveDay('2026-13-01'), false);
  });
});

describe('expandDays', () => {
  it('expands an inclusive range', () => {
    assert.deepEqual(expandDays('2026-10-14', '2026-10-17').days, [
      '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17',
    ]);
  });

  it('a single day is a one-element range', () => {
    assert.deepEqual(expandDays('2026-10-14', '2026-10-14').days, ['2026-10-14']);
  });

  it('crosses a month boundary', () => {
    assert.deepEqual(expandDays('2026-10-30', '2026-11-02').days, [
      '2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02',
    ]);
  });

  it('crosses a leap day', () => {
    assert.deepEqual(expandDays('2028-02-28', '2028-03-01').days, [
      '2028-02-28', '2028-02-29', '2028-03-01',
    ]);
  });

  it('refuses a backwards range', () => {
    assert.equal(expandDays('2026-10-17', '2026-10-14').error.code, 'invalid_range');
  });

  it('refuses a malformed date', () => {
    assert.equal(expandDays('nope', '2026-10-14').error.code, 'invalid_dates');
  });

  it('refuses a range longer than the cap', () => {
    assert.equal(expandDays('2026-01-01', '2026-12-31').error.code, 'range_too_long');
  });
});

describe('approved leave stops new deductions', () => {
  // The contract approval relies on: once the day is in leaveDays, countableReason returns
  // 'on_leave' and no evaluator writes a fine for a meeting that starts that day.
  const startMs = Date.UTC(2026, 9, 14, 6, 0, 0); // 2026-10-14 11:30 IST
  const booking = {
    scheduledEventStartTime: new Date(startMs),
    bookingStatus: 'scheduled',
    calendlyHost: { email: SID },
  };

  it('is countable before the leave is approved', () => {
    const out = countableReason(booking, tracked(SID), startMs + 60_000);
    assert.equal(out.countable, true);
  });

  it('is not countable once the day is in leaveDays', () => {
    const out = countableReason(booking, tracked(SID, ['2026-10-14']), startMs + 60_000);
    assert.equal(out.countable, false);
    assert.equal(out.reason, 'on_leave');
  });

  it('a different approved day does not exempt this meeting', () => {
    const out = countableReason(booking, tracked(SID, ['2026-10-15']), startMs + 60_000);
    assert.equal(out.countable, true);
  });

  it('matches on the IST day, not the UTC day', () => {
    // 2026-10-14 20:00 UTC is 2026-10-15 01:30 IST, so the IST day is the 15th.
    const lateMs = Date.UTC(2026, 9, 14, 20, 0, 0);
    const late = { ...booking, scheduledEventStartTime: new Date(lateMs) };
    assert.equal(countableReason(late, tracked(SID, ['2026-10-14']), lateMs + 60_000).countable, true);
    assert.equal(countableReason(late, tracked(SID, ['2026-10-15']), lateMs + 60_000).reason, 'on_leave');
  });
});
