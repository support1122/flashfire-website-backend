import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { connectTestDb, disconnectTestDb, isolateExternalServices } from './helpers/testDb.mjs';
import { BdaProfileModel } from '../Schema_Models/BdaProfile.js';
import { CrmUserModel } from '../Schema_Models/CrmUser.js';
import { invalidateRegistryCache } from '../Utils/BdaRegistry.js';
import {
  getAssignedBdaEmail,
  isBookingAssignedTo,
  isCountableBooking,
  countableReason,
  statusAtStart,
  istDate,
} from '../Utils/BdaAssignment.js';

isolateExternalServices();

// Random per run: other agents run the whole suite in parallel against the same throwaway database.
const RUN = Math.random().toString(36).slice(2, 8);
const D = `assign-${RUN}.test.invalid`;
const TRACKED = `tracked@${D}`;
const COVER = `cover@${D}`;
const UNTRACKED = `untracked@${D}`;
const PRANJAL = `pranjal@${D}`; // role 'bda' in the CRM, but not in the tracked registry

const START = new Date('2026-10-12T10:30:00.000Z'); // 16:00 IST on 2026-10-12
const BEFORE_START = new Date(START.getTime() - 60 * 60 * 1000);
const AFTER_START = new Date(START.getTime() + 60 * 60 * 1000);
const NOW_AFTER = AFTER_START.getTime() + 24 * 60 * 60 * 1000;

const booking = (extra = {}) => ({
  bookingId: 'b1',
  bookingStatus: 'scheduled',
  scheduledEventStartTime: START,
  calendlyHost: { email: TRACKED, name: 'Host' },
  ...extra,
});

describe('getAssignedBdaEmail (plan 2.1 order)', () => {
  it('prefers attendanceAssignee over the Calendly host over the claim', () => {
    const b = booking({
      attendanceAssignee: { email: '  Cover@Example.com ' },
      calendlyHost: { email: 'host@example.com' },
      claimedBy: { email: 'claim@example.com' },
    });
    assert.equal(getAssignedBdaEmail(b), 'cover@example.com');
    assert.equal(getAssignedBdaEmail({ ...b, attendanceAssignee: { email: '' } }), 'host@example.com');
    assert.equal(getAssignedBdaEmail({ ...b, attendanceAssignee: null, calendlyHost: { email: null } }), 'claim@example.com');
  });

  it('lowercases and trims, and returns null when nobody is assigned', () => {
    assert.equal(getAssignedBdaEmail({ calendlyHost: { email: ' Host@Example.COM ' } }), 'host@example.com');
    assert.equal(getAssignedBdaEmail({}), null);
    assert.equal(getAssignedBdaEmail(null), null);
    assert.equal(getAssignedBdaEmail({ calendlyHost: { email: '   ' } }), null);
  });
});

describe('isBookingAssignedTo', () => {
  it('is true only for the one assigned BDA', () => {
    const b = booking({ attendanceAssignee: { email: COVER }, claimedBy: { email: UNTRACKED } });
    assert.equal(isBookingAssignedTo(b, COVER.toUpperCase()), true);
    assert.equal(isBookingAssignedTo(b, TRACKED), false, 'the Calendly host was handed the meeting to someone else');
    assert.equal(isBookingAssignedTo(b, UNTRACKED), false, 'a lower-priority claim does not also count');
  });

  it('accepts a CRM claim when there is no Calendly host', () => {
    const b = { claimedBy: { email: UNTRACKED }, calendlyHost: { email: null } };
    assert.equal(isBookingAssignedTo(b, UNTRACKED), true);
  });

  it('is false for blank emails', () => {
    assert.equal(isBookingAssignedTo(booking(), ''), false);
    assert.equal(isBookingAssignedTo(booking(), null), false);
  });
});

describe('statusAtStart', () => {
  it('reads the status in force at the scheduled start, not the current one', () => {
    const canceledAfter = booking({
      bookingStatus: 'canceled',
      statusHistory: [
        { status: 'scheduled', changedAt: new Date(START.getTime() - 3 * 86400000) },
        { status: 'canceled', changedAt: AFTER_START },
      ],
    });
    assert.equal(statusAtStart(canceledAfter, START.getTime()), 'scheduled');
  });

  it('reads canceled when the cancel came before the start', () => {
    const b = booking({
      bookingStatus: 'canceled',
      statusHistory: [
        { status: 'scheduled', changedAt: new Date(START.getTime() - 3 * 86400000) },
        { status: 'canceled', changedAt: BEFORE_START },
      ],
    });
    assert.equal(statusAtStart(b, START.getTime()), 'canceled');
  });

  it('sorts unordered history and counts a change at exactly the start as in force', () => {
    const b = booking({
      statusHistory: [
        { status: 'canceled', changedAt: START },
        { status: 'scheduled', changedAt: BEFORE_START },
      ],
    });
    assert.equal(statusAtStart(b, START.getTime()), 'canceled');
  });

  it('uses previousStatus, else the default, when every change came after the start', () => {
    const withPrev = booking({
      bookingStatus: 'completed',
      statusHistory: [{ status: 'completed', previousStatus: 'rescheduled', changedAt: AFTER_START }],
    });
    assert.equal(statusAtStart(withPrev, START.getTime()), 'rescheduled');
    const noPrev = booking({
      bookingStatus: 'no-show',
      statusHistory: [{ status: 'no-show', previousStatus: null, changedAt: AFTER_START }],
    });
    assert.equal(statusAtStart(noPrev, START.getTime()), 'scheduled');
  });

  it('falls back to the current status without any history', () => {
    assert.equal(statusAtStart(booking({ bookingStatus: 'completed' }), START.getTime()), 'completed');
    assert.equal(statusAtStart(booking({ statusHistory: [] }), START.getTime()), 'scheduled');
  });
});

describe('istDate', () => {
  it('uses the IST calendar day, not the UTC one', () => {
    assert.equal(istDate(new Date('2026-10-11T19:00:00Z').getTime()), '2026-10-12'); // 00:30 IST
    assert.equal(istDate(new Date('2026-10-11T18:29:00Z').getTime()), '2026-10-11'); // 23:59 IST
  });
});

describe('countableReason (pure)', () => {
  const profile = { email: TRACKED, active: true, tracked: true, leaveDays: [] };

  it('counts a normal meeting for a tracked BDA', () => {
    assert.deepEqual(countableReason(booking(), profile, NOW_AFTER), { countable: true, reason: null });
  });

  it('gives a reason for each way a meeting can fail', () => {
    const reason = (b, p = profile) => countableReason(b, p, NOW_AFTER).reason;
    assert.equal(reason({ scheduledEventStartTime: START }), 'unassigned');
    assert.equal(reason(booking({ scheduledEventStartTime: null })), 'no_start_time');
    assert.equal(reason(booking(), null), 'not_tracked');
    assert.equal(reason(booking(), { ...profile, tracked: false }), 'not_tracked');
    assert.equal(reason(booking(), { ...profile, active: false }), 'not_tracked');
    assert.equal(reason(booking(), { ...profile, leaveDays: ['2026-10-12'] }), 'on_leave');
    assert.equal(reason(booking({ bookingStatus: 'canceled' })), 'status_canceled');
    assert.equal(reason(booking({ bookingStatus: 'rescheduled' })), 'status_rescheduled');
    assert.equal(reason(booking({ bookingStatus: 'not-scheduled' })), 'status_not-scheduled');
  });

  it('counts no-show, completed, paid and ignored meetings: those states came after the meeting time', () => {
    for (const bookingStatus of ['no-show', 'completed', 'paid', 'ignored']) {
      assert.equal(countableReason(booking({ bookingStatus }), profile, NOW_AFTER).countable, true, bookingStatus);
    }
  });

  it('uses the live status for a meeting that has not started yet', () => {
    const future = START.getTime() - 3 * 86400000;
    assert.equal(countableReason(booking({ bookingStatus: 'canceled' }), profile, future).countable, false);
    assert.equal(countableReason(booking(), profile, future).countable, true);
  });
});

describe('isCountableBooking (registry from the database)', () => {
  before(async () => {
    await connectTestDb();
    await BdaProfileModel.init();
  });
  after(async () => {
    await BdaProfileModel.deleteMany({ email: { $regex: `@${D.replace(/\./g, '\\.')}$` } });
    await CrmUserModel.deleteMany({ email: PRANJAL });
    invalidateRegistryCache();
    await disconnectTestDb();
  });
  beforeEach(async () => {
    await BdaProfileModel.deleteMany({ email: { $regex: `@${D.replace(/\./g, '\\.')}$` } });
    await CrmUserModel.deleteMany({ email: PRANJAL });
    await BdaProfileModel.create([
      { email: TRACKED, displayName: 'Tracked', firstName: 'tracked', tracked: true, active: true, leaveDays: ['2026-10-20'] },
      { email: COVER, displayName: 'Cover', firstName: 'cover', tracked: true, active: true },
      { email: UNTRACKED, displayName: 'Untracked', firstName: 'untracked', tracked: false, active: true },
    ]);
    // Pranjal is a CRM user with role 'bda' who is not in the tracked registry.
    await CrmUserModel.create({ email: PRANJAL, name: 'Pranjal', role: 'bda', permissions: [] });
    invalidateRegistryCache();
  });

  it('counts a plain meeting for a tracked BDA', async () => {
    assert.equal(await isCountableBooking(booking(), NOW_AFTER), true);
  });

  it('accepts a Date for now', async () => {
    assert.equal(await isCountableBooking(booking(), new Date(NOW_AFTER)), true);
  });

  it('judges the attendanceAssignee, not the Calendly host, when one is set', async () => {
    assert.equal(await isCountableBooking(booking({ attendanceAssignee: { email: COVER } }), NOW_AFTER), true);
    assert.equal(await isCountableBooking(booking({ attendanceAssignee: { email: UNTRACKED } }), NOW_AFTER), false);
  });

  it('does not count an untracked BDA or an unknown email', async () => {
    assert.equal(await isCountableBooking(booking({ calendlyHost: { email: UNTRACKED } }), NOW_AFTER), false);
    assert.equal(await isCountableBooking(booking({ calendlyHost: { email: `ghost@${D}` } }), NOW_AFTER), false);
  });

  it('does not count a CRM user with role bda who is not in the registry (Pranjal)', async () => {
    const crm = await CrmUserModel.findOne({ email: PRANJAL }).lean();
    assert.equal(crm.role, 'bda');
    assert.equal(await isCountableBooking(booking({ calendlyHost: { email: PRANJAL } }), NOW_AFTER), false);
  });

  it('does not count a meeting on a leave day, using the IST date', async () => {
    // 2026-10-19T19:00Z is 00:30 IST on the 20th, the BDA's leave day.
    const lateNight = booking({ scheduledEventStartTime: new Date('2026-10-19T19:00:00Z') });
    assert.equal(await isCountableBooking(lateNight, new Date('2026-10-21T00:00:00Z').getTime()), false);
    const dayBefore = booking({ scheduledEventStartTime: new Date('2026-10-19T18:00:00Z') }); // 23:30 IST on the 19th
    assert.equal(await isCountableBooking(dayBefore, new Date('2026-10-21T00:00:00Z').getTime()), true);
  });

  it('does not count a meeting canceled before its start, per statusHistory', async () => {
    const b = booking({
      bookingStatus: 'canceled',
      statusHistory: [
        { status: 'scheduled', changedAt: new Date(START.getTime() - 86400000) },
        { status: 'canceled', changedAt: BEFORE_START },
      ],
    });
    assert.equal(await isCountableBooking(b, NOW_AFTER), false);
  });

  it('still counts a meeting canceled only after its start', async () => {
    const b = booking({
      bookingStatus: 'canceled',
      statusHistory: [
        { status: 'scheduled', changedAt: new Date(START.getTime() - 86400000) },
        { status: 'canceled', changedAt: AFTER_START },
      ],
    });
    assert.equal(await isCountableBooking(b, NOW_AFTER), true);
  });

  it('does not count a meeting without a start time or an assignee', async () => {
    assert.equal(await isCountableBooking(booking({ scheduledEventStartTime: undefined }), NOW_AFTER), false);
    assert.equal(await isCountableBooking({ scheduledEventStartTime: START }, NOW_AFTER), false);
  });

  it('skips the registry lookup when a profile is passed in', async () => {
    const profile = { email: TRACKED, active: true, tracked: true, leaveDays: [] };
    assert.equal(await isCountableBooking(booking(), NOW_AFTER, { profile }), true);
    assert.equal(await isCountableBooking(booking(), NOW_AFTER, { profile: null }), false);
  });
});
