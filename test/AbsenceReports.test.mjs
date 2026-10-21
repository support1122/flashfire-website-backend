import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { applyAbsence, checkEligible, cleanReason, validateReportInput, LOOKBACK_MS } from '../Utils/AbsenceReports.js';
import { createManualMiss, formatDeductionMessage } from '../Utils/DeductionEngine.js';

const NOW = Date.parse('2026-10-17T10:00:00Z');
const HOUR = 3600 * 1000;

describe('validateReportInput', () => {
  const ok = { kind: 'allocation', refId: 'alloc_1', reason: 'Client never picked up' };
  it('accepts a good body', () => {
    assert.deepEqual(validateReportInput(ok).value, ok);
  });
  it('rejects an unknown kind', () => {
    assert.equal(validateReportInput({ ...ok, kind: 'x' }).error.code, 'invalid_kind');
  });
  it('rejects a missing ref', () => {
    assert.equal(validateReportInput({ ...ok, refId: ' ' }).error.code, 'invalid_ref');
  });
  it('needs a reason of 5 to 500 characters', () => {
    assert.equal(validateReportInput({ ...ok, reason: 'no' }).error.code, 'reason_required');
    assert.equal(cleanReason('x'.repeat(501)).error.code, 'reason_too_long');
    assert.equal(cleanReason('  fine reason  ').reason, 'fine reason');
  });
  it('never throws on junk', () => {
    assert.ok(validateReportInput(null).error);
    assert.ok(validateReportInput('str').error);
  });
});

describe('checkEligible', () => {
  const alloc = (o = {}) => ({ kind: 'allocation', startMs: NOW - HOUR, state: 'scheduled', ...o });
  it('lets a past scheduled allocation call through', () => {
    assert.equal(checkEligible(alloc(), NOW).ok, true);
  });
  it('refuses a call that has not started', () => {
    assert.equal(checkEligible(alloc({ startMs: NOW + HOUR }), NOW).code, 'call_not_over');
  });
  it('lets an admin mark a call that is still ahead, up to a week out, and no further', () => {
    assert.equal(checkEligible(alloc({ startMs: NOW + HOUR }), NOW, { admin: true }).ok, true);
    assert.equal(checkEligible(alloc({ startMs: NOW + 7 * 24 * HOUR }), NOW, { admin: true }).ok, true);
    assert.equal(checkEligible(alloc({ startMs: NOW + 7 * 24 * HOUR + 1 }), NOW, { admin: true }).code, 'too_far_ahead');
    assert.equal(checkEligible(alloc({ startMs: NOW + HOUR }), NOW, { admin: false }).code, 'call_not_over');
  });
  it('refuses a call older than 30 days', () => {
    assert.equal(checkEligible(alloc({ startMs: NOW - LOOKBACK_MS - 1 }), NOW).code, 'too_old');
  });
  it('refuses an allocation call that was completed, cancelled or already absent', () => {
    for (const state of ['completed', 'no_answer', 'cancelled', 'absent']) {
      assert.equal(checkEligible(alloc({ state }), NOW).code, 'not_scheduled', state);
    }
  });
  it('refuses a booking that was cancelled, rescheduled or never scheduled', () => {
    for (const state of ['canceled', 'rescheduled', 'not-scheduled']) {
      assert.equal(checkEligible({ kind: 'booking', startMs: NOW - HOUR, state }, NOW).code, 'meeting_did_not_happen', state);
    }
    assert.equal(checkEligible({ kind: 'booking', startMs: NOW - HOUR, state: 'scheduled' }, NOW).ok, true);
    assert.equal(checkEligible({ kind: 'booking', startMs: NOW - HOUR, state: 'completed' }, NOW).ok, true);
  });
  it('refuses a call with no start time', () => {
    assert.equal(checkEligible({ kind: 'booking', startMs: null, state: 'scheduled' }, NOW).code, 'no_start_time');
  });
});

describe('applyAbsence', () => {
  const call = { kind: 'allocation', refId: 'alloc_1', bdaEmail: 'a@x.com', clientName: 'Leslie', startMs: NOW - HOUR };
  const actor = { email: 'admin@x.com', name: 'Admin' };

  function fakeAllocation({ flips = true } = {}) {
    const calls = { flip: [], revert: [] };
    return {
      calls,
      findOneAndUpdate(filter, update) {
        calls.flip.push({ filter, update });
        return { lean: async () => (flips ? { allocationId: 'alloc_1', status: 'absent' } : null) };
      },
      async updateOne(filter, update) {
        calls.revert.push({ filter, update });
      },
    };
  }

  it('flips the call to absent, then writes the fine', async () => {
    const Allocation = fakeAllocation();
    const seen = [];
    const res = await applyAbsence(call, { actor, reason: 'Did not call' }, {
      Allocation,
      createManualMiss: async (a) => (seen.push(a), { ok: true, deduction: { deductionId: 'ded_1' } }),
    });
    assert.equal(res.ok, true);
    assert.deepEqual(Allocation.calls.flip[0].filter, { allocationId: 'alloc_1', status: 'scheduled' });
    assert.equal(Allocation.calls.flip[0].update.$set.status, 'absent');
    assert.equal(seen[0].refId, 'alloc_1');
    assert.equal(seen[0].bdaEmail, 'a@x.com');
    assert.equal(Allocation.calls.revert.length, 0);
  });

  it('writes no fine when the call is no longer scheduled', async () => {
    let fined = false;
    const res = await applyAbsence(call, { actor, reason: 'Did not call' }, {
      Allocation: fakeAllocation({ flips: false }),
      createManualMiss: async () => ((fined = true), { ok: true, deduction: {} }),
    });
    assert.equal(res.ok, false);
    assert.equal(res.code, 'not_scheduled');
    assert.equal(fined, false);
  });

  it('puts the call back to scheduled when the fine is refused', async () => {
    const Allocation = fakeAllocation();
    const res = await applyAbsence(call, { actor, reason: 'Did not call' }, {
      Allocation,
      createManualMiss: async () => ({ ok: false, status: 409, code: 'fines_off', message: 'off' }),
    });
    assert.equal(res.code, 'fines_off');
    assert.equal(Allocation.calls.revert.length, 1);
    assert.deepEqual(Allocation.calls.revert[0].filter, { allocationId: 'alloc_1', status: 'absent' });
    assert.equal(Allocation.calls.revert[0].update.$set.status, 'scheduled');
  });

  it('puts the call back when writing the fine throws', async () => {
    const Allocation = fakeAllocation();
    const res = await applyAbsence(call, { actor, reason: 'Did not call' }, {
      Allocation,
      createManualMiss: async () => {
        throw new Error('db down');
      },
    });
    assert.equal(res.ok, false);
    assert.equal(res.status, 500);
    assert.equal(Allocation.calls.revert.length, 1);
  });

  it('a booking never touches the allocation collection', async () => {
    const Allocation = fakeAllocation();
    const res = await applyAbsence({ ...call, kind: 'booking', refId: 'bk_1' }, { actor, reason: 'Did not join' }, {
      Allocation,
      createManualMiss: async () => ({ ok: true, deduction: { deductionId: 'ded_2' } }),
    });
    assert.equal(res.ok, true);
    assert.equal(Allocation.calls.flip.length, 0);
  });
});

describe('createManualMiss gates', () => {
  const base = { kind: 'allocation', refId: 'alloc_1', bdaEmail: 'A@x.com', startMs: NOW - HOUR, clientName: 'Leslie', actor: { email: 'admin@x.com', name: 'Admin' }, reason: 'Did not call' };
  const tracked = { email: 'a@x.com', active: true, tracked: true, trackedSince: new Date(NOW - 30 * 24 * HOUR) };
  const opts = (o = {}) => ({ now: NOW, mode: 'live', liveFrom: new Date(NOW - 10 * 24 * HOUR), getProfile: async () => tracked, ...o });

  it('writes nothing while fines are off', async () => {
    assert.equal((await createManualMiss(base, opts({ mode: 'off' }))).code, 'fines_off');
  });
  it('writes nothing without a go-live date', async () => {
    assert.equal((await createManualMiss(base, opts({ liveFrom: null }))).code, 'fines_not_started');
  });
  it('writes nothing for a call from before go-live', async () => {
    assert.equal((await createManualMiss({ ...base, startMs: NOW - 20 * 24 * HOUR }, opts())).code, 'before_live_from');
  });
  it('refuses someone who is not a tracked BDA', async () => {
    assert.equal((await createManualMiss(base, opts({ getProfile: async () => ({ ...tracked, tracked: false }) }))).code, 'not_tracked');
    assert.equal((await createManualMiss(base, opts({ getProfile: async () => null }))).code, 'not_tracked');
  });
  it('refuses a call from before the BDA was tracked', async () => {
    const p = { ...tracked, trackedSince: new Date(NOW) };
    assert.equal((await createManualMiss(base, opts({ getProfile: async () => p }))).code, 'before_tracking');
  });
});

describe('manual fine message', () => {
  const row = {
    rule: 'missed_meeting', status: 'active', amountInr: 500, tierIndex: 2,
    evidence: { scheduledStart: new Date('2026-10-16T15:45:00Z'), manualAbsent: { kind: 'allocation', markedByName: 'Adit' } },
  };
  it('says who marked it and what kind of call it was', () => {
    const msg = formatDeductionMessage(row, { name: 'Siddhartha', client: 'Leslie' });
    assert.match(msg, /marked absent for the allocated call with Leslie/);
    assert.match(msg, /Marked by Adit/);
    assert.match(msg, /miss 2 this month/);
  });
  it('keeps the old wording for an automatic miss', () => {
    const msg = formatDeductionMessage({ ...row, evidence: { scheduledStart: row.evidence.scheduledStart } }, { name: 'Siddhartha', client: 'Leslie' });
    assert.match(msg, /missed the meeting with Leslie/);
  });
});
