import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import {
  connectTestDb, disconnectTestDb, isolateExternalServices,
} from './helpers/testDb.mjs';
import {
  buildCallSummaries, getCallSummaries, CALLED_WITHIN_MS,
} from '../Utils/BookingCallSummary.js';
import { normalizeLeadPhone } from '../Utils/CallLinking.js';
import { CallLogModel } from '../Schema_Models/CallLog.js';
import { resolveBda } from '../Utils/BdaIdentity.js';
import { getAssignedBdaEmail } from '../Utils/BdaAssignment.js';
import * as bdaRegistry from '../Utils/BdaRegistry.js';
import * as syncHealth from '../Utils/SyncHealth.js';

isolateExternalServices();

// Most tests stub the identity functions so they stay fast and independent of the registry's rules:
// resolveBda(hint, registry) -> { bda, via } | null, getAssignedBdaEmail(booking) -> email | null.
// The "real identity modules" suite below runs the same flow through the real BdaIdentity / BdaAssignment.
const SID = 'siddhartha@flashfirehq.com';
const KAL = 'kalpataru@flashfirehq.com';
const registry = [
  { email: SID, zoomUserId: 'zu-sid' },
  { email: KAL, zoomUserId: null },
];
const stubDeps = {
  getTrackedBdas: async () => registry,
  getAssignedBdaEmail: (b) => b.calendlyHost?.email || null,
  resolveBda: (hint, reg) => {
    const byEmail = hint.email && reg.find((p) => p.email === String(hint.email).toLowerCase());
    if (byEmail) return { bda: byEmail, via: 'email' };
    const byZoom = hint.zoomUserId && reg.find((p) => p.zoomUserId === hint.zoomUserId);
    if (byZoom) return { bda: byZoom, via: 'zoom' };
    return null;
  },
};
const resolvers = {
  assignedEmailOf: stubDeps.getAssignedBdaEmail,
  callerEmailOf: (c) => stubDeps.resolveBda(
    { email: c.salesEmail, zoomUserId: c.raw?.caller_user_id }, registry,
  )?.bda.email ?? null,
};

const START = new Date('2026-10-01T10:00:00.000Z');
const atMin = (m) => new Date(START.getTime() + m * 60000);
const PHONE = '+1 777 013 0001';

const booking = (over = {}) => ({
  bookingId: 'zcl-b1',
  scheduledEventStartTime: START,
  clientPhone: PHONE,
  normalizedClientPhone: normalizeLeadPhone(PHONE),
  calendlyHost: { email: SID },
  ...over,
});
const call = (over = {}) => ({
  callId: 'zcl-c1',
  direction: 'outbound',
  bookingId: 'zcl-b1',
  leadNumber: PHONE,
  leadNumberNormalized: normalizeLeadPhone(PHONE),
  salesEmail: SID,
  startedAt: atMin(5),
  durationSec: 60,
  callResult: 'connected',
  ...over,
});
const summarize = (bookings, calls) => buildCallSummaries(bookings, calls, resolvers);

describe('buildCallSummaries: what counts as a call', () => {
  it('a call at +29 min is within 30 min, a call at +31 min is not', () => {
    const early = summarize([booking()], [call({ startedAt: atMin(29) })]).get('zcl-b1');
    assert.equal(early.calls, 1);
    assert.equal(early.calledWithin30Min, true);
    assert.equal(early.firstCallOffsetMin, 29);

    const late = summarize([booking()], [call({ startedAt: atMin(31) })]).get('zcl-b1');
    assert.equal(late.calls, 1, 'a late call still counts as a call');
    assert.equal(late.calledWithin30Min, false);
    assert.equal(late.firstCallOffsetMin, 31);
  });

  it('the window is inclusive at the start and at +30:00, and a call before the start is not "within 30 min"', () => {
    assert.equal(CALLED_WITHIN_MS, 30 * 60000);
    assert.equal(summarize([booking()], [call({ startedAt: atMin(0) })]).get('zcl-b1').calledWithin30Min, true);
    assert.equal(summarize([booking()], [call({ startedAt: atMin(30) })]).get('zcl-b1').calledWithin30Min, true);
    const before = summarize([booking()], [call({ startedAt: atMin(-5) })]).get('zcl-b1');
    assert.equal(before.calls, 1);
    assert.equal(before.calledWithin30Min, false);
    assert.equal(before.firstCallOffsetMin, -5, 'negative offset means before the scheduled start');
  });

  it('ignores inbound calls', () => {
    const s = summarize([booking()], [call({ direction: 'inbound' })]).get('zcl-b1');
    assert.equal(s.calls, 0);
    assert.equal(s.calledWithin30Min, false);
    assert.equal(s.firstCallAt, null);
  });

  it("does not count a colleague's call", () => {
    const s = summarize([booking()], [call({ salesEmail: KAL })]).get('zcl-b1');
    assert.equal(s.calls, 0);
  });

  it('does not count an unknown caller, even when salesName looks right', () => {
    const s = summarize([booking()], [call({ salesEmail: 'stranger@example.com', salesName: 'Siddhartha' })]).get('zcl-b1');
    assert.equal(s.calls, 0);
  });

  it('counts a call attributed by Zoom user id when the email is missing', () => {
    const s = summarize([booking()], [call({ salesEmail: null, raw: { caller_user_id: 'zu-sid' } })]).get('zcl-b1');
    assert.equal(s.calls, 1);
  });

  it('connected is true only when a counted call has callResult connected', () => {
    assert.equal(summarize([booking()], [call({ callResult: 'no_answer' })]).get('zcl-b1').connected, false);
    assert.equal(summarize([booking()], [call({ callResult: null })]).get('zcl-b1').connected, false);
    const mixed = summarize([booking()], [
      call({ callId: 'a', callResult: 'no_answer', startedAt: atMin(1) }),
      call({ callId: 'b', callResult: 'connected', startedAt: atMin(2) }),
    ]).get('zcl-b1');
    assert.equal(mixed.connected, true);
    // A connected call from a colleague must not make the assigned BDA look connected.
    const colleague = summarize([booking()], [call({ callResult: 'connected', salesEmail: KAL })]).get('zcl-b1');
    assert.equal(colleague.connected, false);
  });

  it('sums talk time, and reports first and last call', () => {
    const s = summarize([booking()], [
      call({ callId: 'a', startedAt: atMin(20), durationSec: 100 }),
      call({ callId: 'b', startedAt: atMin(3), durationSec: 250 }),
      call({ callId: 'c', startedAt: atMin(40), durationSec: 62 }),
    ]).get('zcl-b1');
    assert.equal(s.calls, 3);
    assert.equal(s.talkSec, 412);
    assert.deepEqual(s.firstCallAt, atMin(3));
    assert.equal(s.firstCallOffsetMin, 3);
    assert.deepEqual(s.lastCallAt, atMin(40));
  });

  it('has exactly the contract shape, including for a booking with no calls', () => {
    const keys = ['calls', 'connected', 'firstCallAt', 'firstCallOffsetMin', 'talkSec', 'calledWithin30Min', 'lastCallAt'];
    const withCalls = summarize([booking()], [call()]).get('zcl-b1');
    const without = summarize([booking()], []).get('zcl-b1');
    assert.deepEqual(Object.keys(withCalls).sort(), [...keys].sort());
    assert.deepEqual(Object.keys(without).sort(), [...keys].sort());
    assert.deepEqual(without, {
      calls: 0, connected: false, firstCallAt: null, firstCallOffsetMin: null, talkSec: 0, calledWithin30Min: false, lastCallAt: null,
    });
  });

  it('gives no entry (unknown, not zero) when there is no scheduled start or no assigned BDA', () => {
    const m = summarize([
      booking({ bookingId: 'no-start', scheduledEventStartTime: null }),
      booking({ bookingId: 'no-bda', calendlyHost: { email: null } }),
    ], [call({ bookingId: 'no-start' }), call({ bookingId: 'no-bda' })]);
    assert.equal(m.has('no-start'), false);
    assert.equal(m.has('no-bda'), false);
  });
});

describe('buildCallSummaries: linking by bookingId and by phone', () => {
  it('falls back to the phone key when the call has no bookingId', () => {
    const s = summarize([booking()], [call({ bookingId: null })]).get('zcl-b1');
    assert.equal(s.calls, 1);
  });

  it('matches every phone form to the same booking', () => {
    const forms = ['+1 415 555 0100', '4155550100', '(415) 555-0100', '1-415-555-0100'];
    // Every form must collapse to the same key...
    assert.deepEqual([...new Set(forms.map(normalizeLeadPhone))], ['4155550100']);
    // ...and each form on the call side must find a booking saved in any other form.
    for (const bookingForm of forms) {
      for (const callForm of forms) {
        const b = booking({ clientPhone: bookingForm, normalizedClientPhone: undefined });
        const c = call({ bookingId: null, leadNumber: callForm, leadNumberNormalized: normalizeLeadPhone(callForm) });
        assert.equal(summarize([b], [c]).get('zcl-b1').calls, 1, `booking "${bookingForm}" vs call "${callForm}"`);
      }
    }
  });

  it('matches non-US numbers regardless of how the country code is written', () => {
    const b = booking({ clientPhone: '98765 43210', normalizedClientPhone: undefined });
    for (const callForm of ['+91 98765 43210', '919876543210', '9876543210']) {
      const c = call({ bookingId: null, leadNumber: callForm, leadNumberNormalized: normalizeLeadPhone(callForm) });
      assert.equal(summarize([b], [c]).get('zcl-b1').calls, 1, callForm);
    }
  });

  it('two bookings for one phone: each call goes to the meeting closest in time, never both', () => {
    const first = booking({ bookingId: 'zcl-first', scheduledEventStartTime: START });
    const second = booking({ bookingId: 'zcl-second', scheduledEventStartTime: new Date(START.getTime() + 7 * 24 * 3600000) });
    const nearFirst = call({ callId: 'n1', bookingId: null, startedAt: atMin(10), durationSec: 30 });
    const nearSecond = call({ callId: 'n2', bookingId: null, startedAt: new Date(second.scheduledEventStartTime.getTime() + 5 * 60000), durationSec: 90 });
    const m = summarize([first, second], [nearFirst, nearSecond]);
    assert.equal(m.get('zcl-first').calls, 1);
    assert.equal(m.get('zcl-first').talkSec, 30);
    assert.equal(m.get('zcl-second').calls, 1);
    assert.equal(m.get('zcl-second').talkSec, 90);
  });

  it('two bookings for one phone: an explicit bookingId link is respected', () => {
    const first = booking({ bookingId: 'zcl-first' });
    const second = booking({ bookingId: 'zcl-second', scheduledEventStartTime: atMin(60 * 24 * 7) });
    const m = summarize([first, second], [call({ bookingId: 'zcl-second', startedAt: atMin(10) })]);
    assert.equal(m.get('zcl-first').calls, 0);
    assert.equal(m.get('zcl-second').calls, 1);
  });

  it('a call linked to a booking outside the page is not stolen by phone', () => {
    const m = summarize([booking()], [call({ bookingId: 'some-other-booking' })]);
    assert.equal(m.get('zcl-b1').calls, 0);
  });

  it('a call made before the booking existed is not attributed to it when the client has a later booking too', () => {
    const old = booking({ bookingId: 'zcl-old', scheduledEventStartTime: atMin(-60 * 24 * 30), bookingCreatedAt: atMin(-60 * 24 * 40) });
    const recent = booking({ bookingId: 'zcl-new', scheduledEventStartTime: START, bookingCreatedAt: atMin(-60 * 24 * 2) });
    const m = summarize([old, recent], [call({ bookingId: null, startedAt: atMin(-60 * 24 * 10) })]);
    assert.equal(m.get('zcl-old').calls, 1);
    assert.equal(m.get('zcl-new').calls, 0);
  });
});

describe('getCallSummaries against the throwaway database', () => {
  const PREFIX = 'zcl-sum-';
  const cleanup = () => CallLogModel.deleteMany({ callId: new RegExp(`^${PREFIX}`) });

  before(async () => {
    await connectTestDb();
    await CallLogModel.init();
    await cleanup();
  });
  after(async () => {
    await cleanup();
    await disconnectTestDb();
  });

  it('answers a whole page with ONE call-log query (no N+1)', async () => {
    const bookings = [];
    const docs = [];
    for (let i = 0; i < 60; i += 1) {
      const phone = `+1 777 014 ${String(i).padStart(4, '0')}`;
      bookings.push(booking({ bookingId: `${PREFIX}b${i}`, clientPhone: phone, normalizedClientPhone: normalizeLeadPhone(phone) }));
      docs.push({
        callId: `${PREFIX}c${i}`, direction: 'outbound', salesEmail: SID, startedAt: atMin(10), durationSec: 20 + i,
        callResult: 'connected', leadNumber: phone, leadNumberNormalized: normalizeLeadPhone(phone),
        bookingId: i % 2 === 0 ? `${PREFIX}b${i}` : null, // half linked by id, half only by phone
      });
    }
    await CallLogModel.insertMany(docs);

    const ops = [];
    mongoose.set('debug', (collection, method) => { if (collection === 'calllogs') ops.push(method); });
    let spyCalls = 0;
    const realFind = CallLogModel.find;
    CallLogModel.find = function patched(...args) { spyCalls += 1; return realFind.apply(this, args); };
    let result;
    try {
      result = await getCallSummaries(bookings, stubDeps);
    } finally {
      CallLogModel.find = realFind;
      mongoose.set('debug', false);
    }

    assert.equal(spyCalls, 1, 'one CallLog.find for the page');
    assert.deepEqual(ops, ['find'], 'one round trip to the calllogs collection, no matter how many rows');
    assert.equal(result.size, 60);
    for (let i = 0; i < 60; i += 1) {
      const s = result.get(`${PREFIX}b${i}`);
      assert.equal(s.calls, 1, `booking ${i}`);
      assert.equal(s.talkSec, 20 + i);
      assert.equal(s.calledWithin30Min, true);
    }
  });

  it('does not query at all for an empty page', async () => {
    let spyCalls = 0;
    const realFind = CallLogModel.find;
    CallLogModel.find = function patched(...args) { spyCalls += 1; return realFind.apply(this, args); };
    try {
      assert.equal((await getCallSummaries([], stubDeps)).size, 0);
    } finally {
      CallLogModel.find = realFind;
    }
    assert.equal(spyCalls, 0);
  });

  it('reads the caller from a webhook row\'s raw payload and drops inbound / colleague rows', async () => {
    const phone = '+1 777 015 0001';
    const key = normalizeLeadPhone(phone);
    await CallLogModel.insertMany([
      { callId: `${PREFIX}w1`, direction: 'outbound', salesEmail: null, startedAt: atMin(2), durationSec: 10,
        leadNumberNormalized: key, raw: { payload: { object: { caller: { user_id: 'zu-sid' } } } } },
      { callId: `${PREFIX}w2`, direction: 'outbound', salesEmail: KAL, startedAt: atMin(3), durationSec: 500, leadNumberNormalized: key },
      { callId: `${PREFIX}w3`, direction: 'inbound', salesEmail: SID, startedAt: atMin(4), durationSec: 500, leadNumberNormalized: key },
    ]);
    const b = booking({ bookingId: `${PREFIX}bw`, clientPhone: phone, normalizedClientPhone: key });
    const s = (await getCallSummaries([b], stubDeps)).get(`${PREFIX}bw`);
    assert.equal(s.calls, 1);
    assert.equal(s.talkSec, 10);
  });
});

describe('with the real identity modules', () => {
  const realRegistry = [
    { email: SID, firstName: 'siddhartha', lastName: 'basaveni', displayName: 'Siddhartha', aliases: ['basaveni siddhartha'], zoomUserId: 'zu-sid', active: true, tracked: true },
    { email: KAL, firstName: 'kalpataru', lastName: 'samal', displayName: 'Kalpataru', aliases: [], zoomUserId: null, active: true, tracked: true },
  ];
  const real = {
    resolveBda,
    getAssignedBdaEmail,
    callerEmailOf: (c) => resolveBda({ email: c.salesEmail || null, zoomUserId: c.raw?.caller_user_id || null }, realRegistry)?.bda.email ?? null,
  };
  const run = (bookings, calls) => buildCallSummaries(bookings, calls, { assignedEmailOf: real.getAssignedBdaEmail, callerEmailOf: real.callerEmailOf });

  it('counts the assigned BDA by email or Zoom user id', () => {
    assert.equal(run([booking()], [call()]).get('zcl-b1').calls, 1);
    assert.equal(run([booking()], [call({ salesEmail: null, raw: { caller_user_id: 'zu-sid' } })]).get('zcl-b1').calls, 1);
  });

  it('never trusts salesName alone: a row with a BDA-looking name but no email or id does not count', () => {
    assert.equal(run([booking()], [call({ salesEmail: null, salesName: 'Basaveni siddhartha' })]).get('zcl-b1').calls, 0);
    assert.equal(run([booking()], [call({ salesEmail: null, salesName: 'Siddhartha' })]).get('zcl-b1').calls, 0);
  });

  it('follows attendanceAssignee over the Calendly host, so leave cover gets the credit', () => {
    const covered = booking({ attendanceAssignee: { email: KAL } });
    assert.equal(run([covered], [call({ salesEmail: SID })]).get('zcl-b1').calls, 0);
    assert.equal(run([covered], [call({ salesEmail: KAL })]).get('zcl-b1').calls, 1);
  });

  it('the modules this feature depends on export the functions it calls', () => {
    assert.equal(typeof bdaRegistry.getTrackedBdas, 'function');
    assert.equal(typeof bdaRegistry.learnZoomUserId, 'function');
    assert.equal(typeof syncHealth.recordSyncOk, 'function');
    assert.equal(typeof syncHealth.recordSyncError, 'function');
  });
});

describe('getCallSummaries default path (real registry, throwaway database)', () => {
  before(async () => { await connectTestDb(); });
  after(async () => { await disconnectTestDb(); });

  it('runs end to end without overrides and never throws on an empty registry', async () => {
    const m = await getCallSummaries([booking({ bookingId: 'zcl-default-b' })]);
    assert.ok(m instanceof Map);
    assert.equal(m.get('zcl-default-b').calls, 0, 'no tracked BDA in the throwaway database means nothing counts');
  });
});
