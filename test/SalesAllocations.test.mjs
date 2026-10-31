import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  CRM_BASE_URL,
  buildReminderMessage,
  crmLinkFor,
  formatInZone,
  isOnLeaveAt,
  isValidTimeZone,
  istDayOf,
  normalizePhone,
  parseInstant,
  validateAllocationInput,
} from '../Utils/SalesAllocations.js';
import { isInReminderWindow, reminderWindow, tick } from '../Utils/SalesAllocationReminder.js';

// Pure logic only: no database, no network.

const NOW = new Date('2026-10-15T10:00:00Z');
const good = {
  clientName: 'Jane Doe',
  phone: '+1 (415) 555-0100',
  email: 'Jane@Example.com',
  timezone: 'America/New_York',
  callAt: '2026-10-15T15:00:00Z',
  bdaEmail: 'Sid@FlashfireHQ.com',
};

describe('validateAllocationInput', () => {
  it('normalises a good body', () => {
    const r = validateAllocationInput(good, NOW);
    assert.equal(r.error, undefined);
    assert.equal(r.value.phone, '+14155550100');
    assert.equal(r.value.email, 'jane@example.com');
    assert.equal(r.value.bdaEmail, 'sid@flashfirehq.com');
    assert.equal(r.value.callAt.toISOString(), '2026-10-15T15:00:00.000Z');
  });

  it('requires a name and one contact', () => {
    assert.equal(validateAllocationInput({ ...good, clientName: ' ' }, NOW).error.code, 'invalid_client_name');
    assert.equal(validateAllocationInput({ ...good, phone: '', email: '' }, NOW).error.code, 'contact_required');
    assert.equal(validateAllocationInput({ ...good, phone: undefined }, NOW).error, undefined);
    assert.equal(validateAllocationInput({ ...good, email: undefined }, NOW).error, undefined);
  });

  it('rejects bad phone, email and timezone', () => {
    assert.equal(validateAllocationInput({ ...good, phone: '12' }, NOW).error.code, 'invalid_phone');
    assert.equal(validateAllocationInput({ ...good, email: 'nope' }, NOW).error.code, 'invalid_email');
    assert.equal(validateAllocationInput({ ...good, timezone: 'Mars/Base' }, NOW).error.code, 'invalid_timezone');
  });

  it('rejects past, malformed and offset-less call times', () => {
    assert.equal(validateAllocationInput({ ...good, callAt: '2026-10-15T09:00:00Z' }, NOW).error.code, 'call_in_past');
    assert.equal(validateAllocationInput({ ...good, callAt: 'tomorrow' }, NOW).error.code, 'invalid_call_time');
    assert.equal(validateAllocationInput({ ...good, callAt: '2026-10-15T15:00:00' }, NOW).error.code, 'invalid_call_time');
    // within the 1 minute grace
    assert.equal(validateAllocationInput({ ...good, callAt: '2026-10-15T09:59:30Z' }, NOW).error, undefined);
  });

  it('requires a bda', () => {
    assert.equal(validateAllocationInput({ ...good, bdaEmail: '' }, NOW).error.code, 'invalid_bda');
  });
});

describe('helpers', () => {
  it('validates IANA zones', () => {
    assert.equal(isValidTimeZone('Asia/Kolkata'), true);
    assert.equal(isValidTimeZone('Nope/Zone'), false);
    assert.equal(isValidTimeZone(''), false);
  });

  it('normalises phones', () => {
    assert.equal(normalizePhone('(415) 555-0100'), '4155550100');
    assert.equal(normalizePhone('+91 98765 43210'), '+919876543210');
    assert.equal(normalizePhone('abc'), null);
  });

  it('parses only instants with an offset', () => {
    assert.equal(parseInstant('2026-10-15T20:30:00+05:30').toISOString(), '2026-10-15T15:00:00.000Z');
    assert.equal(parseInstant('2026-10-15T20:30:00'), null);
  });
});

describe('IST day boundary for leave', () => {
  it('maps a UTC instant to the IST calendar day', () => {
    // 18:29Z is 23:59 IST on the 15th, 18:30Z is 00:00 IST on the 16th.
    assert.equal(istDayOf(new Date('2026-10-15T18:29:00Z')), '2026-10-15');
    assert.equal(istDayOf(new Date('2026-10-15T18:30:00Z')), '2026-10-16');
  });

  it('checks leave against the working day (10:00 IST to 10:00 IST), not the calendar day', () => {
    const leave = ['2026-10-16'];
    assert.equal(isOnLeaveAt(leave, new Date('2026-10-16T04:30:00Z')), true, '10:00 IST starts the 16th');
    assert.equal(isOnLeaveAt(leave, new Date('2026-10-16T04:29:00Z')), false, '09:59 IST is still the 15th');
    assert.equal(isOnLeaveAt(leave, new Date('2026-10-16T20:00:00Z')), true, '01:30 IST on the 17th is the tail of the 16th shift');
    assert.equal(isOnLeaveAt(leave, new Date('2026-10-17T04:30:00Z')), false, '10:00 IST on the 17th starts the next day');
    assert.equal(isOnLeaveAt(leave, new Date('2026-10-16T04:30:00Z'), 12), false, 'a BDA whose day starts at 12:00 is still on the 15th');
    assert.equal(isOnLeaveAt(undefined, new Date()), false);
  });
});

describe('formatting', () => {
  const at = new Date('2026-10-15T15:00:00Z');
  it('shows the same instant in New York and India', () => {
    assert.equal(formatInZone(at, 'America/New_York'), 'Thu, Oct 15, 2026, 11:00 AM EDT');
    assert.equal(formatInZone(at, 'Asia/Kolkata'), 'Thu, Oct 15, 2026, 8:30 PM IST');
  });
});

describe('buildReminderMessage', () => {
  const a = {
    allocationId: 'alloc_1_abc',
    clientName: 'Jane Doe',
    phone: null,
    email: 'jane@example.com',
    timezone: 'America/New_York',
    callAt: new Date('2026-10-15T15:00:00Z'),
    bdaEmail: 'sid@flashfirehq.com',
    bdaName: 'Siddhartha',
  };
  it('has every field and the CRM link', () => {
    const m = buildReminderMessage(a);
    assert.match(m, /Call to make in ~5 minutes/);
    assert.match(m, /\*\*Client:\*\* Jane Doe/);
    assert.match(m, /\*\*Phone:\*\* n\/a/);
    assert.match(m, /\*\*Email:\*\* jane@example\.com/);
    assert.match(m, /11:00 AM EDT \(America\/New_York\)/);
    assert.match(m, /\*\*Time \(India\):\*\* .*8:30 PM IST/);
    assert.match(m, /\*\*Assigned BDA:\*\* Siddhartha/);
    assert.ok(m.includes(`${CRM_BASE_URL}/?tab=sales_allocation&id=alloc_1_abc`));
    assert.match(m, /Siddhartha, this call is yours\./);
    assert.ok(!m.includes('—'));
  });
  it('builds the link', () => {
    assert.equal(crmLinkFor('alloc_9'), 'https://flashfire-crm.vercel.app/?tab=sales_allocation&id=alloc_9');
  });
});

describe('reminder window', () => {
  const min = (n) => new Date(NOW.getTime() + n * 60000);
  it('covers 5 minutes ahead to 10 minutes back', () => {
    assert.equal(isInReminderWindow(min(5), NOW), true);
    assert.equal(isInReminderWindow(min(5.1), NOW), false);
    assert.equal(isInReminderWindow(min(0), NOW), true);
    assert.equal(isInReminderWindow(min(-10), NOW), true);
    assert.equal(isInReminderWindow(min(-10.1), NOW), false);
    assert.deepEqual(Object.keys(reminderWindow(NOW)), ['from', 'to']);
  });

  const rows = [
    { allocationId: 'soon', callAt: min(4), clientName: 'A', timezone: 'Asia/Kolkata', bdaName: 'X' },
    { allocationId: 'far', callAt: min(30), clientName: 'B', timezone: 'Asia/Kolkata', bdaName: 'X' },
    { allocationId: 'stale', callAt: min(-60), clientName: 'C', timezone: 'Asia/Kolkata', bdaName: 'X' },
  ];

  function fakeDeps({ sendOk = true, loseClaim = false } = {}) {
    const log = { sent: [], marked: [], failed: [], posts: [] };
    return {
      log,
      resetStuck: async () => 2,
      findDue: async (now) => rows.filter((r) => isInReminderWindow(r.callAt, now)),
      claim: async (row) => (loseClaim ? null : row),
      send: async (content) => {
        log.posts.push(content);
        return sendOk ? { ok: true } : { ok: false, error: 'boom' };
      },
      markSent: async (row) => log.marked.push(row.allocationId),
      markFailed: async (row) => log.failed.push(row.allocationId),
    };
  }

  it('sends only for calls inside the window', async () => {
    const d = fakeDeps();
    const out = await tick(NOW, d);
    assert.deepEqual(out, { reset: 2, sent: 1, failed: 0, skipped: 0 });
    assert.deepEqual(d.log.marked, ['soon']);
    assert.match(d.log.posts[0], /alloc_|sales_allocation&id=soon/);
  });

  it('marks failed when Discord rejects', async () => {
    const d = fakeDeps({ sendOk: false });
    const out = await tick(NOW, d);
    assert.equal(out.failed, 1);
    assert.deepEqual(d.log.failed, ['soon']);
    assert.deepEqual(d.log.marked, []);
  });

  it('skips when another instance wins the claim', async () => {
    const d = fakeDeps({ loseClaim: true });
    const out = await tick(NOW, d);
    assert.equal(out.skipped, 1);
    assert.equal(d.log.posts.length, 0);
  });
});

import { guessTimezoneFromPhone, phoneBookingFilter } from '../Utils/SalesAllocations.js';

describe('phone lookup helpers', () => {
  it('guesses the zone from the country code', () => {
    assert.equal(guessTimezoneFromPhone('+41772452623'), 'Europe/Zurich');
    assert.equal(guessTimezoneFromPhone('+971501234567'), 'Asia/Dubai');
    assert.equal(guessTimezoneFromPhone('+447700900123'), 'Europe/London');
  });

  it('uses the injected area-code lookup for +1 numbers and returns null when it cannot tell', () => {
    assert.equal(guessTimezoneFromPhone('+14155550142', () => 'PT'), 'America/Los_Angeles');
    assert.equal(guessTimezoneFromPhone('+14155550142', () => 'ET'), 'America/New_York');
    assert.equal(guessTimezoneFromPhone('+14155550142'), null);
    assert.equal(guessTimezoneFromPhone('4155550142'), null);
    assert.equal(guessTimezoneFromPhone(null), null);
  });

  it('matches a number typed with its country code against the stored last-10 key', () => {
    const f = phoneBookingFilter('41772452623');
    const exact = f.$or.find((c) => typeof c.normalizedClientPhone === 'string');
    assert.equal(exact.normalizedClientPhone, '1772452623');
    assert.ok(f.$or.some((c) => c.clientPhone instanceof RegExp && c.clientPhone.test('+41772452623')));
  });

  it('does not add the last-10 key for short fragments', () => {
    const f = phoneBookingFilter('4177');
    assert.equal(f.$or.some((c) => typeof c.normalizedClientPhone === 'string'), false);
  });
});

import { buildEarlyReminderMessage } from '../Utils/SalesAllocations.js';
import { earlyWindow, isInEarlyWindow, tickEarly } from '../Utils/SalesAllocationReminder.js';

describe('30-minute heads-up', () => {
  const min = (n) => new Date(NOW.getTime() + n * 60000);

  it('covers calls 5 to 30 minutes away, and nothing outside that', () => {
    assert.equal(isInEarlyWindow(min(30), NOW), true);
    assert.equal(isInEarlyWindow(min(30.1), NOW), false);
    assert.equal(isInEarlyWindow(min(5), NOW), true);
    assert.equal(isInEarlyWindow(min(4.9), NOW), false); // the final reminder owns this range
    assert.equal(isInEarlyWindow(min(-1), NOW), false);
    assert.deepEqual(Object.keys(earlyWindow(NOW)), ['from', 'to']);
  });

  it('builds a message with the facts, the notes, the link and the follow-up promise', () => {
    const m = buildEarlyReminderMessage({
      allocationId: 'alloc_2_xyz',
      clientName: 'Jane Doe',
      phone: '+14155550142',
      email: null,
      timezone: 'America/Los_Angeles',
      callAt: new Date('2026-10-17T17:30:00Z'),
      bdaName: 'Siddhartha',
      notes: 'Asked about Premium',
    });
    assert.match(m, /Call coming up in ~30 minutes/);
    assert.match(m, /\*\*Phone:\*\* \+14155550142/);
    assert.match(m, /\*\*Email:\*\* n\/a/);
    assert.match(m, /10:30 AM PDT/);
    assert.match(m, /11:00 PM IST/);
    assert.match(m, /\*\*Notes:\*\* Asked about Premium/);
    assert.ok(m.includes('https://flashfire-crm.vercel.app/?tab=sales_allocation&id=alloc_2_xyz'));
    assert.match(m, /one more reminder 5 minutes before/);
    assert.ok(!m.includes('—'));
  });

  it('leaves the notes line out when there are none', () => {
    const m = buildEarlyReminderMessage({ allocationId: 'a', clientName: 'X', timezone: 'Asia/Kolkata', callAt: new Date(), bdaName: 'S' });
    assert.ok(!m.includes('**Notes:**'));
  });

  const rows = [
    { allocationId: 'in20', callAt: min(20), clientName: 'A', timezone: 'Asia/Kolkata', bdaName: 'X' },
    { allocationId: 'in3', callAt: min(3), clientName: 'B', timezone: 'Asia/Kolkata', bdaName: 'X' },
    { allocationId: 'in90', callAt: min(90), clientName: 'C', timezone: 'Asia/Kolkata', bdaName: 'X' },
  ];
  const deps = ({ sendOk = true } = {}) => {
    const log = { marked: [], failed: [], posts: [] };
    return {
      log,
      resetStuck: async () => 0,
      findDue: async (now) => rows.filter((r) => isInEarlyWindow(r.callAt, now)),
      claim: async (row) => row,
      send: async (c) => (log.posts.push(c), sendOk ? { ok: true } : { ok: false, error: 'boom' }),
      markSent: async (r) => log.marked.push(r.allocationId),
      markFailed: async (r) => log.failed.push(r.allocationId),
    };
  };

  it('posts the heads-up only for the call inside the window', async () => {
    const d = deps();
    const out = await tickEarly(NOW, d);
    assert.deepEqual(out, { reset: 0, sent: 1, failed: 0, skipped: 0 });
    assert.deepEqual(d.log.marked, ['in20']);
    assert.match(d.log.posts[0], /Call coming up in ~30 minutes/);
  });

  it('marks failed when Discord rejects', async () => {
    const d = deps({ sendOk: false });
    const out = await tickEarly(NOW, d);
    assert.equal(out.failed, 1);
    assert.deepEqual(d.log.failed, ['in20']);
  });
});

describe('reminder Important note', () => {
  const a = { allocationId: 'alloc_x', clientName: 'Leslie', timezone: 'America/Chicago', callAt: new Date('2026-10-16T15:45:00Z'), bdaName: 'Siddhartha', bdaEmail: 's@x.com' };
  for (const [label, build] of [['final', buildReminderMessage], ['early', buildEarlyReminderMessage]]) {
    it(`${label} reminder tells the BDA to call via Zoom before India time`, () => {
      const msg = build(a);
      assert.match(msg, /\*\*Important:\*\* The client requested a callback at the above mentioned date and time/);
      assert.match(msg, /Siddhartha, please make the call via Zoom only before Time \(India\)\. Otherwise, it will be marked as absent\./);
    });
  }
});
