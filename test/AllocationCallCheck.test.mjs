import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { connectTestDb, disconnectTestDb, isolateExternalServices } from './helpers/testDb.mjs';
import { buildAllocationCallChecks, getAllocationCallChecks, LATE_WINDOW_MS } from '../Utils/AllocationCallCheck.js';
import { CallLogModel } from '../Schema_Models/CallLog.js';

isolateExternalServices();

const SID = 'siddhartha@flashfirehq.com';
const KAL = 'kalpataru@flashfirehq.com';
const MIN = 60_000;
const NOW = Date.parse('2026-10-19T10:00:00.000Z');
const CALL_AT = NOW - 2 * 60 * MIN; // two hours ago, so the late window is over

const alloc = (over = {}) => ({
  allocationId: 'alloc_1',
  phone: '+1 (415) 555-0134',
  bdaEmail: SID,
  callAt: new Date(CALL_AT).toISOString(),
  createdAt: new Date(CALL_AT - 24 * 60 * MIN).toISOString(),
  ...over,
});
const call = (over = {}) => ({
  callId: `c_${Math.random()}`,
  direction: 'outbound',
  leadNumberNormalized: '4155550134',
  startedAt: new Date(CALL_AT - 5 * MIN).toISOString(),
  durationSec: 120,
  callResult: 'connected',
  salesEmail: SID,
  ...over,
});
const callerEmailOf = (c) => c.salesEmail || null;
const check = (allocations, calls, now = NOW) => buildAllocationCallChecks(allocations, calls, { callerEmailOf }, now);

describe('buildAllocationCallChecks', () => {
  it('called in time: a call to the client before the call time', () => {
    const r = check([alloc()], [call()]).get('alloc_1');
    assert.equal(r.verdict, 'called_in_time');
    assert.equal(r.calls, 1);
    assert.equal(r.connected, true);
    assert.equal(r.firstCallOffsetMin, -5);
    assert.equal(r.talkSec, 120);
  });

  it('called late: first call within 30 minutes after the call time', () => {
    const r = check([alloc()], [call({ startedAt: new Date(CALL_AT + 12 * MIN).toISOString() })]).get('alloc_1');
    assert.equal(r.verdict, 'called_late');
    assert.equal(r.firstCallOffsetMin, 12);
  });

  it('not called: nothing logged and the late window is over', () => {
    const r = check([alloc()], []).get('alloc_1');
    assert.equal(r.verdict, 'not_called');
    assert.equal(r.calls, 0);
    assert.equal(r.firstCallAt, null);
  });

  it('waiting: nothing yet, but the call time (plus 30 min) has not passed', () => {
    const future = alloc({ callAt: new Date(NOW + 10 * MIN).toISOString() });
    assert.equal(check([future], []).get('alloc_1').verdict, 'waiting');
    const justPast = alloc({ callAt: new Date(NOW - 10 * MIN).toISOString() });
    assert.equal(check([justPast], []).get('alloc_1').verdict, 'waiting');
    const edge = alloc({ callAt: new Date(NOW - LATE_WINDOW_MS - 1).toISOString() });
    assert.equal(check([edge], []).get('alloc_1').verdict, 'not_called');
  });

  it('a colleague, an inbound call, another number or an unknown caller never counts', () => {
    const calls = [
      call({ salesEmail: KAL }),
      call({ direction: 'inbound' }),
      call({ leadNumberNormalized: '4155559999' }),
      call({ salesEmail: null }),
    ];
    assert.equal(check([alloc()], calls).get('alloc_1').verdict, 'not_called');
  });

  it('a call before the allocation existed, or long after the call time, does not count', () => {
    const before = call({ startedAt: new Date(CALL_AT - 30 * 60 * MIN).toISOString() }); // before createdAt
    const after = call({ startedAt: new Date(CALL_AT + 31 * MIN).toISOString() });
    assert.equal(check([alloc()], [before, after]).get('alloc_1').verdict, 'not_called');
  });

  it('matches the number however it was typed, and uses the last 10 digits', () => {
    const r = check([alloc({ phone: '415.555.0134' })], [call({ leadNumberNormalized: '14155550134' })]).get('alloc_1');
    assert.equal(r.verdict, 'called_in_time');
  });

  it('counts several calls and sums talk time; the first call sets the verdict', () => {
    const calls = [
      call({ startedAt: new Date(CALL_AT - 1 * MIN).toISOString(), durationSec: 30, callResult: 'no_answer' }),
      call({ startedAt: new Date(CALL_AT + 4 * MIN).toISOString(), durationSec: 200, callResult: 'connected' }),
    ];
    const r = check([alloc()], calls).get('alloc_1');
    assert.equal(r.verdict, 'called_in_time');
    assert.equal(r.calls, 2);
    assert.equal(r.talkSec, 230);
    assert.equal(r.connected, true);
  });

  it('an allocation with no usable phone says so instead of "not called"', () => {
    assert.equal(check([alloc({ phone: null })], []).get('alloc_1').verdict, 'no_phone');
    assert.equal(check([alloc({ phone: 'abc' })], []).get('alloc_1').verdict, 'no_phone');
  });

  it('an allocation with no call time gets no entry (unknown, not zero calls)', () => {
    assert.equal(check([alloc({ callAt: null })], []).has('alloc_1'), false);
  });

  it('keeps two allocations to the same phone for different BDAs apart', () => {
    const a = alloc({ allocationId: 'a' });
    const b = alloc({ allocationId: 'b', bdaEmail: KAL });
    const out = check([a, b], [call()]);
    assert.equal(out.get('a').verdict, 'called_in_time');
    assert.equal(out.get('b').verdict, 'not_called');
  });
});

describe('getAllocationCallChecks against the test database', () => {
  const stubDeps = {
    getTrackedBdas: async () => [{ email: SID, zoomUserId: 'zu-sid' }],
    resolveBda: (hint, reg) => {
      const hit = reg.find((p) => p.email === String(hint.email || '').toLowerCase() || p.zoomUserId === hint.zoomUserId);
      return hit ? { bda: hit, via: 'email' } : null;
    },
    getAssignedBdaEmail: () => null,
  };
  before(async () => {
    await connectTestDb();
  });
  after(async () => {
    await CallLogModel.deleteMany({ callId: /^acc_/ });
    await disconnectTestDb();
  });
  beforeEach(async () => {
    await CallLogModel.deleteMany({ callId: /^acc_/ });
  });

  it('reads one page of calls with a single lookup and finds the BDA by email', async () => {
    await CallLogModel.create({
      callId: 'acc_1',
      direction: 'outbound',
      salesEmail: SID,
      leadNumber: '+14155550134',
      leadNumberNormalized: '4155550134',
      startedAt: new Date(CALL_AT - 3 * MIN),
      durationSec: 90,
      callResult: 'connected',
    });
    const out = await getAllocationCallChecks([alloc(), alloc({ allocationId: 'alloc_2', phone: '+1 415 555 7777' })], stubDeps, NOW);
    assert.equal(out.get('alloc_1').verdict, 'called_in_time');
    assert.equal(out.get('alloc_2').verdict, 'not_called');
  });

  it('returns an empty map for no allocations', async () => {
    assert.equal((await getAllocationCallChecks([], stubDeps, NOW)).size, 0);
  });
});
