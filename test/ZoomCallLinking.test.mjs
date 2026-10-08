import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { connectTestDb, disconnectTestDb, isolateExternalServices } from './helpers/testDb.mjs';
import { CallLogModel } from '../Schema_Models/CallLog.js';
import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';
import { ZoomWebhookEventModel } from '../Schema_Models/ZoomWebhookEvent.js';
import { normalizePhone as legacyNormalizePhone } from '../Utils/ZoomPhone.js';
import {
  normalizeLeadPhone, bookingPhoneKey, pickBookingForCall,
  __setIdentityDepsForTests, __setSyncHealthForTests,
} from '../Utils/CallLinking.js';
import { upsertCallHistoryRows, buildHistoryCallDoc, syncZoomCallHistory } from '../Utils/ZoomPhoneSync.js';
import { zoomPhoneWebhook } from '../Controllers/ZoomPhoneController.js';
import { analyzeNoShowLinking } from '../scripts/audit-call-linking.js';
import { planRelink, runBackfill } from '../scripts/backfill-call-links.js';

isolateExternalServices();
delete process.env.ZOOM_WEBHOOK_SECRET_TOKEN; // no secret: the handler skips signature checks, like dev mode

// ---- stubs for the modules another agent owns (BdaIdentity / BdaRegistry / BdaAssignment / SyncHealth) ----
const SID = 'siddhartha@flashfirehq.com';
const KAL = 'kalpataru@flashfirehq.com';
const registry = [{ email: SID, zoomUserId: null }, { email: KAL, zoomUserId: null }];
const learned = [];
const identityStub = {
  getTrackedBdas: async () => registry,
  getAssignedBdaEmail: (b) => b.calendlyHost?.email || null,
  resolveBda: (hint, reg) => {
    const hit = hint.email && reg.find((p) => p.email === String(hint.email).toLowerCase());
    return hit ? { bda: hit, via: 'email' } : null;
  },
  learnZoomUserId: async (email, id) => { learned.push([email, id]); },
};
const healthEvents = [];
const healthStub = {
  recordSyncOk: async (source) => { healthEvents.push(['ok', source]); },
  recordSyncError: async (source, err) => { healthEvents.push(['error', source, err?.message]); },
};

const P = 'zcl-lnk-';
const START = new Date('2026-10-01T10:00:00.000Z');
const iso = (min) => new Date(START.getTime() + min * 60000).toISOString();

async function cleanup() {
  const re = new RegExp(`^${P}`);
  await CallLogModel.deleteMany({ callId: re });
  await CampaignBookingModel.deleteMany({ bookingId: re });
  await ZoomWebhookEventModel.deleteMany({ callId: re });
}

async function seedBooking(bookingId, clientPhone, over = {}) {
  return CampaignBookingModel.create({
    bookingId, utmSource: 'test', clientName: `Client ${bookingId}`, clientEmail: `${bookingId}@example.com`,
    clientPhone, scheduledEventStartTime: START, bookingCreatedAt: new Date(START.getTime() - 86400000),
    calendlyHost: { email: SID, name: 'Siddhartha' }, ...over,
  });
}

function webhookBody(event, callId, over = {}) {
  const { caller, callee, ...rest } = over;
  return {
    event,
    payload: {
      object: {
        call_id: callId,
        direction: 'outbound',
        caller: { email: SID, name: 'Basaveni siddhartha', phone_number: '+19998887777', user_id: 'zu-sid', ...caller },
        callee: { phone_number: '+14155550100', ...callee },
        start_time: iso(5),
        ...rest,
      },
    },
  };
}
async function fire(body) {
  const res = { code: null, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  await zoomPhoneWebhook({ body, headers: {}, ip: '127.0.0.1', rawBody: undefined }, res);
  return res;
}
const histRow = (over = {}) => ({
  call_id: `${P}h1`, direction: 'outbound', caller_email: SID, caller_name: 'Basaveni siddhartha', caller_user_id: 'zu-sid',
  caller_did_number: '+19998887777', callee_did_number: '+14155550100', callee_name: 'Zoom Callee Label',
  call_result: 'connected', start_time: iso(5), duration: 60, ...over,
});

// =====================================================================================================
describe('root causes of unlinked calls: how the old matching failed', () => {
  // These characterise the OLD logic (still importable: ZoomPhone.normalizePhone, and the exact regex the webhook used)
  // and prove the new shared helper fixes each case.
  const oldWebhookRegexMatches = (callNormalized, clientPhone) => new RegExp(`${callNormalized}$`).test(clientPhone ?? '');

  it('cause 1, formatting: a regex over the raw clientPhone cannot match a number saved with spaces or dashes', () => {
    const callKey = legacyNormalizePhone('+14155550100'); // '4155550100'
    assert.equal(oldWebhookRegexMatches(callKey, '+14155550100'), true, 'only the clean form matched');
    for (const saved of ['+1 415 555 0100', '(415) 555-0100', '1-415-555-0100', '415 555 0100', '415.555.0100']) {
      assert.equal(oldWebhookRegexMatches(callKey, saved), false, `old matching missed "${saved}"`);
      assert.equal(normalizeLeadPhone(saved), callKey, `shared helper matches "${saved}"`);
    }
  });

  it('cause 2, country code: non-US numbers kept every digit on the call but only 10 on the booking', () => {
    const oldCallKey = legacyNormalizePhone('+91 98765 43210');
    assert.equal(oldCallKey, '919876543210');
    const bookingKey = normalizeLeadPhone('+91 98765 43210'); // what CampaignBooking.normalizedClientPhone stores
    assert.equal(bookingKey, '9876543210');
    assert.notEqual(oldCallKey, bookingKey, 'old call key could never equal the booking key');
    assert.equal(normalizeLeadPhone('+919876543210'), bookingKey, 'new call key equals the booking key');
    assert.equal(oldWebhookRegexMatches(oldCallKey, '9876543210'), false, 'old regex also missed a booking saved without the country code');
  });

  it('cause 3, one phone and two bookings: the old lookup had no sort, the new one picks the closest meeting', () => {
    const early = { bookingId: 'e', scheduledEventStartTime: START, bookingCreatedAt: new Date(START.getTime() - 9e8) };
    const late = { bookingId: 'l', scheduledEventStartTime: new Date(START.getTime() + 14 * 86400000), bookingCreatedAt: new Date(START.getTime() - 3600000) };
    assert.equal(pickBookingForCall([late, early], new Date(START.getTime() + 600000)).bookingId, 'e');
    assert.equal(pickBookingForCall([early, late], new Date(late.scheduledEventStartTime.getTime() + 600000)).bookingId, 'l');
    // A call can't belong to a booking created after it, even if that meeting is nearer.
    const call = new Date(START.getTime() - 5 * 86400000);
    assert.equal(pickBookingForCall([early, late], call).bookingId, 'e');
    assert.equal(pickBookingForCall([], call), null);
  });

  it('bookingPhoneKey falls back to clientPhone for bookings that never got normalizedClientPhone', () => {
    assert.equal(bookingPhoneKey({ clientPhone: '(415) 555-0100' }), '4155550100');
    assert.equal(bookingPhoneKey({ clientPhone: '(415) 555-0100', normalizedClientPhone: '4155550100' }), '4155550100');
    assert.equal(bookingPhoneKey({ clientPhone: null }), null);
    assert.equal(normalizeLeadPhone('12345'), null, 'too short to be a phone number');
  });
});

// =====================================================================================================
describe('buildHistoryCallDoc (pure)', () => {
  it('never writes null link fields when nothing matched, so an earlier link survives', () => {
    const { set, setOnInsert } = buildHistoryCallDoc(histRow(), null);
    assert.equal('bookingId' in set, false);
    assert.equal('leadEmail' in set, false);
    assert.equal('leadName' in set, false);
    assert.equal(setOnInsert.leadName, 'Zoom Callee Label');
  });

  it('falls back to callee_number when callee_did_number is empty', () => {
    const { set } = buildHistoryCallDoc(histRow({ callee_did_number: '', callee_number: '+1 (415) 555-0100' }), null);
    assert.equal(set.leadNumber, '+1 (415) 555-0100');
    assert.equal(set.leadNumberNormalized, '4155550100');
  });

  it('reads the client and the BDA from the right side on inbound calls', () => {
    const { set } = buildHistoryCallDoc(histRow({
      direction: 'inbound', caller_email: null, caller_name: 'The Client', caller_did_number: '+14155550100', caller_user_id: null,
      callee_email: SID, callee_name: 'Basaveni siddhartha', callee_did_number: '+19998887777',
    }), null);
    assert.equal(set.salesEmail, SID, 'the BDA is the callee on an inbound call');
    assert.equal(set.salesName, 'Basaveni siddhartha');
    assert.equal(set.leadNumberNormalized, '4155550100');
  });
});

// =====================================================================================================
describe('webhook and sync linking against the throwaway database', () => {
  before(async () => {
    await connectTestDb();
    await CallLogModel.init();
    __setIdentityDepsForTests(identityStub);
    __setSyncHealthForTests(healthStub);
    await cleanup();
  });
  beforeEach(() => { learned.length = 0; healthEvents.length = 0; });
  after(async () => {
    await cleanup();
    __setIdentityDepsForTests(null);
    __setSyncHealthForTests(null);
    await disconnectTestDb();
  });

  it('webhook links every phone form to the booking', async () => {
    const forms = [
      (d) => `+1 ${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6)}`,
      (d) => d,
      (d) => `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`,
      (d) => `1-${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`,
    ];
    for (let i = 0; i < forms.length; i += 1) {
      const digits = `777016000${i}`;
      await seedBooking(`${P}form${i}`, forms[i](digits));
      const res = await fire(webhookBody('phone.caller_ended', `${P}wf${i}`, { callee: { phone_number: `+1${digits}` } }));
      assert.equal(res.code, 200);
      const row = await CallLogModel.findOne({ callId: `${P}wf${i}` }).lean();
      assert.equal(row.bookingId, `${P}form${i}`, `booking saved as "${forms[i](digits)}"`);
      assert.equal(row.leadNumberNormalized, digits);
    }
  });

  it('webhook links a non-US number whatever country-code form each side uses', async () => {
    await seedBooking(`${P}in1`, '+91 98765 43210');
    await fire(webhookBody('phone.caller_ended', `${P}win1`, { callee: { phone_number: '+919876543210' } }));
    assert.equal((await CallLogModel.findOne({ callId: `${P}win1` }).lean()).bookingId, `${P}in1`);

    await seedBooking(`${P}in2`, '9812345678');
    await fire(webhookBody('phone.caller_ended', `${P}win2`, { callee: { phone_number: '+91 98123 45678' } }));
    assert.equal((await CallLogModel.findOne({ callId: `${P}win2` }).lean()).bookingId, `${P}in2`);
  });

  it('webhook with two bookings for one phone links the meeting closest to the call', async () => {
    const phone = '+1 777 017 0001';
    await seedBooking(`${P}two-a`, phone, { scheduledEventStartTime: START });
    await seedBooking(`${P}two-b`, phone, { scheduledEventStartTime: new Date(START.getTime() + 7 * 86400000) });
    await fire(webhookBody('phone.caller_ended', `${P}w-two1`, { callee: { phone_number: '+17770170001' }, start_time: iso(8) }));
    await fire(webhookBody('phone.caller_ended', `${P}w-two2`, { callee: { phone_number: '+17770170001' }, start_time: iso(8 + 7 * 24 * 60) }));
    assert.equal((await CallLogModel.findOne({ callId: `${P}w-two1` }).lean()).bookingId, `${P}two-a`);
    assert.equal((await CallLogModel.findOne({ callId: `${P}w-two2` }).lean()).bookingId, `${P}two-b`);
  });

  it('a later webhook event without a start time does not erase the start time or the link', async () => {
    await seedBooking(`${P}keep`, '+1 777 018 0001');
    const callee = { phone_number: '+17770180001' };
    await fire(webhookBody('phone.callee_ringing', `${P}w-keep`, { callee, start_time: iso(5) }));
    const ended = webhookBody('phone.caller_ended', `${P}w-keep`, { callee, duration: 42 });
    delete ended.payload.object.start_time;
    await fire(ended);
    const row = await CallLogModel.findOne({ callId: `${P}w-keep` }).lean();
    assert.equal(row.startedAt.toISOString(), iso(5), 'start time survives the ended event');
    assert.equal(row.bookingId, `${P}keep`);
    assert.equal(row.durationSec, 42);
  });

  it('webhook keeps an unknown caller but never learns an id for them, and learns the id of a registry BDA', async () => {
    await fire(webhookBody('phone.caller_ended', `${P}w-unk`, { caller: { email: 'stranger@example.com', user_id: 'zu-x' } }));
    const stored = await CallLogModel.findOne({ callId: `${P}w-unk` }).lean();
    assert.ok(stored, 'the row is kept');
    assert.equal(stored.salesEmail, 'stranger@example.com');
    assert.deepEqual(learned, []);

    await fire(webhookBody('phone.caller_ended', `${P}w-sid`, { caller: { email: SID, user_id: 'zu-sid' } }));
    assert.deepEqual(learned, [[SID, 'zu-sid']]);
  });

  it('webhook records SyncHealth zoom_phone ok on success and an error on failure', async () => {
    await fire(webhookBody('phone.caller_ended', `${P}w-health`));
    assert.deepEqual(healthEvents, [['ok', 'zoom_phone']]);

    healthEvents.length = 0;
    const realUpdate = CallLogModel.findOneAndUpdate;
    CallLogModel.findOneAndUpdate = async () => { throw new Error('mongo down'); };
    try {
      const res = await fire(webhookBody('phone.caller_ended', `${P}w-health2`));
      assert.equal(res.body.ok, false);
    } finally {
      CallLogModel.findOneAndUpdate = realUpdate;
    }
    assert.deepEqual(healthEvents, [['error', 'zoom_phone', 'mongo down']]);
  });

  it('sync links, is idempotent, and reports unknown callers', async () => {
    await seedBooking(`${P}sync1`, '(777) 019-0001');
    const rows = [
      histRow({ call_id: `${P}s1`, callee_did_number: '+17770190001' }),
      histRow({ call_id: `${P}s2`, callee_did_number: '', callee_number: '+1 777 019 0001', caller_email: 'stranger@example.com', caller_user_id: 'zu-x' }),
    ];
    const first = await upsertCallHistoryRows(rows, identityStub);
    assert.deepEqual(first, { upserted: 2, matched: 2, unknownCallers: 1 });
    assert.deepEqual(learned, [[SID, 'zu-sid']], 'learned once for the BDA, not for the stranger');
    const again = await upsertCallHistoryRows(rows, identityStub);
    assert.equal(again.upserted, 2);
    assert.equal(await CallLogModel.countDocuments({ callId: { $in: [`${P}s1`, `${P}s2`] } }), 2, 'no duplicates');
    const s2 = await CallLogModel.findOne({ callId: `${P}s2` }).lean();
    assert.equal(s2.bookingId, `${P}sync1`, 'callee_number fallback linked the call');
    assert.equal(s2.salesEmail, 'stranger@example.com', 'unknown caller is stored as is');
  });

  it('sync does not erase a link the webhook made when it cannot match the row itself', async () => {
    await CallLogModel.create({
      callId: `${P}s-wipe`, direction: 'outbound', bookingId: `${P}made-by-webhook`, leadEmail: 'x@example.com', leadName: 'Real Name',
      leadNumberNormalized: '7770190002', salesEmail: SID,
    });
    await upsertCallHistoryRows([histRow({ call_id: `${P}s-wipe`, callee_did_number: '+17770190002' })], identityStub);
    const row = await CallLogModel.findOne({ callId: `${P}s-wipe` }).lean();
    assert.equal(row.bookingId, `${P}made-by-webhook`);
    assert.equal(row.leadEmail, 'x@example.com');
    assert.equal(row.leadName, 'Real Name');
  });

  it('sync of an inbound call stores the client name, not the BDA name, as the lead', async () => {
    await upsertCallHistoryRows([histRow({
      call_id: `${P}s-in`, direction: 'inbound', caller_email: null, caller_name: 'Pat Client', caller_user_id: null,
      caller_did_number: '+17770190003', callee_email: SID, callee_name: 'Basaveni siddhartha', callee_did_number: '+19998887777',
    })], identityStub);
    const row = await CallLogModel.findOne({ callId: `${P}s-in` }).lean();
    assert.equal(row.leadName, 'Pat Client');
    assert.equal(row.salesEmail, SID);
    assert.equal(row.leadNumberNormalized, '7770190003');
  });

  it('syncZoomCallHistory records SyncHealth ok, and records an error for every failure path', async () => {
    const okFetch = async () => ({ ok: true, json: async () => ({ call_logs: [histRow({ call_id: `${P}s-ok` })], next_page_token: '' }), text: async () => '' });
    const ok = await syncZoomCallHistory({}, { getToken: async () => 'tok', fetchFn: okFetch, health: healthStub, ...identityStub });
    assert.equal(ok.ok, true);
    assert.equal(ok.upserted, 1);
    assert.deepEqual(healthEvents, [['ok', 'zoom_phone']]);

    healthEvents.length = 0;
    const badFetch = async () => ({ ok: false, status: 500, text: async () => 'boom' });
    const http = await syncZoomCallHistory({}, { getToken: async () => 'tok', fetchFn: badFetch, health: healthStub, ...identityStub });
    assert.equal(http.ok, false);
    assert.deepEqual(healthEvents, [['error', 'zoom_phone', 'Zoom 500: boom']]);

    healthEvents.length = 0;
    const noToken = await syncZoomCallHistory({}, { getToken: async () => null, health: healthStub });
    assert.equal(noToken.ok, false);
    assert.deepEqual(healthEvents, [['error', 'zoom_phone', 'Zoom OAuth not configured']]);

    healthEvents.length = 0;
    const thrown = await syncZoomCallHistory({}, { getToken: async () => 'tok', fetchFn: async () => { throw new Error('network'); }, health: healthStub });
    assert.equal(thrown.ok, false);
    assert.deepEqual(healthEvents, [['error', 'zoom_phone', 'network']]);
  });
});

// =====================================================================================================
describe('audit: analyzeNoShowLinking (pure)', () => {
  const key = '4155550100';
  const noShow = (id, over = {}) => ({
    bookingId: id, clientName: `Client ${id}`, clientPhone: '+1 415 555 0100', normalizedClientPhone: key,
    scheduledEventStartTime: START, calendlyHost: { email: SID }, ...over,
  });
  const call = (id, over = {}) => ({
    callId: id, direction: 'outbound', bookingId: null, leadNumber: '+14155550100', leadNumberNormalized: key,
    leadName: null, salesEmail: SID, startedAt: new Date(START.getTime() + 600000), ...over,
  });
  const run = (noShows, calls) => analyzeNoShowLinking({
    noShows, calls, assignedEmailOf: identityStub.getAssignedBdaEmail,
    callerEmailOf: (c) => (c.salesEmail && registry.some((p) => p.email === c.salesEmail) ? c.salesEmail : null),
  });

  it('isolated scenarios: each cause lands in its own bucket', () => {
    const one = (booking, calls) => run([booking], calls).bookingIds;
    assert.deepEqual(one(noShow('b'), [call('c')]).unlinked_same_phone, ['b']);
    assert.deepEqual(one(noShow('b'), [call('c', { bookingId: 'sibling-booking' })]).linked_to_sibling_booking, ['b']);
    assert.deepEqual(one(noShow('b', { normalizedClientPhone: null }), [call('c')]).booking_phone_not_normalized, ['b']);
    assert.deepEqual(one(noShow('b'), [call('c', { leadNumberNormalized: null })]).stale_call_normalization, ['b']);
    assert.deepEqual(one(noShow('b'), [call('c', { bookingId: 'b', salesEmail: KAL })]).called_by_other_agent, ['b']);
    assert.deepEqual(one(noShow('b'), [call('c', { bookingId: 'b', salesEmail: 'stranger@example.com' })]).called_by_other_agent, ['b']);
    assert.deepEqual(one(noShow('b'), []).not_called, ['b']);
  });

  it('only looks within one day of the meeting and ignores inbound calls', () => {
    assert.equal(run([noShow('b')], [call('c', { startedAt: new Date(START.getTime() + 25 * 3600000) })]).counts.not_called, 1);
    assert.equal(run([noShow('b')], [call('c', { startedAt: new Date(START.getTime() + 23 * 3600000) })]).counts.unlinked_same_phone, 1);
    assert.equal(run([noShow('b')], [call('c', { direction: 'inbound' })]).counts.not_called, 1);
  });

  it('reports the share of called-but-not-linked no-shows and exposes only booking ids', () => {
    const r = run([noShow('a'), noShow('b', { clientPhone: '+1 303 555 0100', normalizedClientPhone: '3035550100' })], [call('c1')]);
    assert.equal(r.noShows, 2);
    assert.equal(r.calledButNotLinked, 1);
    assert.equal(r.calledButNotLinkedPct, 50);
    assert.ok(!JSON.stringify(r).includes('example.com'));
    assert.ok(!JSON.stringify(r).includes('415'), 'no phone numbers in the summary');
    assert.ok(!JSON.stringify(r).includes('Client '), 'no client names in the summary');
  });
});

// =====================================================================================================
describe('backfill: planRelink (pure)', () => {
  const booking = (id, startOffsetDays = 0, over = {}) => ({
    bookingId: id, clientEmail: `${id}@example.com`, clientName: `Name ${id}`,
    scheduledEventStartTime: new Date(START.getTime() + startOffsetDays * 86400000),
    bookingCreatedAt: new Date(START.getTime() - 30 * 86400000), ...over,
  });
  const byKey = (entries) => new Map(entries);

  it('links an unlinked row and fixes a stale key in one go', () => {
    const plan = planRelink(
      { leadNumber: '+91 98765 43210', leadNumberNormalized: '919876543210', bookingId: null, startedAt: START },
      byKey([['9876543210', [booking('in1')]]]),
    );
    assert.equal(plan.kind, 'linked');
    assert.equal(plan.normalizationFixed, true);
    assert.deepEqual(plan.set, {
      leadNumberNormalized: '9876543210', bookingId: 'in1', leadEmail: 'in1@example.com', leadName: 'Name in1',
    });
  });

  it('moves a row between two bookings of one phone only when the nearer one differs', () => {
    const cands = [booking('first', 0), booking('second', 14)];
    const wrong = planRelink({ leadNumber: '4155550100', leadNumberNormalized: '4155550100', bookingId: 'first', startedAt: new Date(START.getTime() + 14 * 86400000) }, byKey([['4155550100', cands]]));
    assert.equal(wrong.kind, 'moved');
    assert.equal(wrong.set.bookingId, 'second');
    const right = planRelink({ leadNumber: '4155550100', leadNumberNormalized: '4155550100', bookingId: 'first', startedAt: START }, byKey([['4155550100', cands]]));
    assert.equal(right.kind, null);
    assert.deepEqual(right.set, {});
  });

  it('never touches a row linked to a booking with a different phone', () => {
    const plan = planRelink({ leadNumber: '4155550100', leadNumberNormalized: '4155550100', bookingId: 'elsewhere', startedAt: START }, byKey([['4155550100', [booking('a'), booking('b', 3)]]]));
    assert.equal(plan.kind, null);
    assert.deepEqual(plan.set, {});
  });

  it('reads the number from a synced row\'s raw payload when leadNumber is empty', () => {
    const plan = planRelink(
      { leadNumber: null, source: 'sync', direction: 'outbound', raw: { callee_number: '+1 (415) 555-0100' }, bookingId: null, startedAt: START },
      byKey([['4155550100', [booking('a')]]]),
    );
    assert.equal(plan.set.bookingId, 'a');
    assert.equal(plan.set.leadNumberNormalized, '4155550100');
  });
});

describe('backfill: runBackfill against the throwaway database', () => {
  const scope = { callId: new RegExp(`^${P}bf`) };
  before(async () => { await connectTestDb(); await cleanup(); });
  after(async () => { await cleanup(); await disconnectTestDb(); });

  async function seed() {
    await cleanup();
    await seedBooking(`${P}bf-b1`, '+91 98765 43299');
    await CallLogModel.create({
      callId: `${P}bf-c1`, direction: 'outbound', leadNumber: '+919876543299', leadNumberNormalized: '919876543299',
      bookingId: null, salesEmail: SID, startedAt: new Date(START.getTime() + 300000),
    });
  }

  it('dry run is the default and writes nothing', async () => {
    await seed();
    const before = await CallLogModel.findOne({ callId: `${P}bf-c1` }).lean();
    const stats = await runBackfill({ callFilter: scope });
    assert.equal(stats.mode, 'DRY RUN');
    assert.equal(stats.unlinkedNowLinked, 1);
    assert.equal(stats.normalizationFixed, 1);
    const after = await CallLogModel.findOne({ callId: `${P}bf-c1` }).lean();
    assert.deepEqual(after, before, 'document is byte-for-byte unchanged');
  });

  it('refuses to write unless apply is exactly true', async () => {
    await seed();
    for (const apply of ['true', 1, 'yes']) {
      await runBackfill({ apply, callFilter: scope });
    }
    assert.equal((await CallLogModel.findOne({ callId: `${P}bf-c1` }).lean()).bookingId, null);
  });

  it('--apply links the call and rewrites the key', async () => {
    await seed();
    const stats = await runBackfill({ apply: true, callFilter: scope });
    assert.equal(stats.mode, 'APPLY');
    const row = await CallLogModel.findOne({ callId: `${P}bf-c1` }).lean();
    assert.equal(row.bookingId, `${P}bf-b1`);
    assert.equal(row.leadNumberNormalized, '9876543299');
    const second = await runBackfill({ apply: true, callFilter: scope });
    assert.equal(second.callRowsToChange, 0, 'a second run has nothing left to do');
  });

  it('--fix-booking-keys fills a missing normalizedClientPhone only with --apply', async () => {
    await cleanup();
    await CampaignBookingModel.collection.insertOne({
      bookingId: `${P}bf-nokey`, utmSource: 'test', clientName: 'No Key', clientEmail: 'nokey@example.com',
      clientPhone: '(777) 020-0001', normalizedClientPhone: null, scheduledEventStartTime: START,
    });
    await runBackfill({ fixBookingKeys: true, callFilter: scope });
    assert.equal((await CampaignBookingModel.findOne({ bookingId: `${P}bf-nokey` }).lean()).normalizedClientPhone, null);
    const stats = await runBackfill({ apply: true, fixBookingKeys: true, callFilter: scope });
    assert.ok(stats.bookingKeysFixed >= 1);
    assert.equal((await CampaignBookingModel.findOne({ bookingId: `${P}bf-nokey` }).lean()).normalizedClientPhone, '7770200001');
  });
});
