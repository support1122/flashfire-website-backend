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

  it('checks leave against the IST day, not the UTC day', () => {
    const leave = ['2026-10-16'];
    assert.equal(isOnLeaveAt(leave, new Date('2026-10-15T18:30:00Z')), true);
    assert.equal(isOnLeaveAt(leave, new Date('2026-10-15T18:29:00Z')), false);
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
