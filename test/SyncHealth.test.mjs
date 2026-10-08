import { describe, it, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import { connectTestDb, disconnectTestDb, isolateExternalServices } from './helpers/testDb.mjs';
import { SyncHealthModel } from '../Schema_Models/SyncHealth.js';
import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';
import { BdaAttendanceModel } from '../Schema_Models/BdaAttendance.js';
import {
  recordSyncOk,
  recordSyncError,
  getAllSyncHealth,
  wasSourceHealthy,
  syncOkBetween,
  SYNC_SOURCES,
  SYNC_LIMITS_MS,
} from '../Utils/SyncHealth.js';
import { pollMeetApiAttendance, syncBookingFromMeetNow } from '../Utils/MeetAttendanceScheduler.js';

isolateExternalServices();

const MIN = 60 * 1000;
const T0 = new Date('2026-10-12T10:00:00.000Z').getTime();
const at = (minutes) => new Date(T0 + minutes * MIN);
const SOURCE = 'zoom_phone';

before(async () => {
  await connectTestDb();
  await SyncHealthModel.init();
});
after(async () => {
  await SyncHealthModel.deleteMany({ source: { $in: SYNC_SOURCES } });
  await disconnectTestDb();
});
beforeEach(async () => {
  await SyncHealthModel.deleteMany({ source: { $in: SYNC_SOURCES } });
});

describe('recordSyncOk / recordSyncError', () => {
  it('creates the row on first success and clears any earlier error', async () => {
    await recordSyncError(SOURCE, new Error('boom'), at(0));
    await recordSyncOk(SOURCE, at(5));
    const row = await SyncHealthModel.findOne({ source: SOURCE }).lean();
    assert.equal(row.lastOkAt.getTime(), at(5).getTime());
    assert.equal(row.lastError, null);
  });

  it('records an error without losing the last good time', async () => {
    await recordSyncOk(SOURCE, at(0));
    await recordSyncError(SOURCE, new Error('zoom 500'), at(3));
    const row = await SyncHealthModel.findOne({ source: SOURCE }).lean();
    assert.equal(row.lastOkAt.getTime(), at(0).getTime());
    assert.equal(row.lastError, 'zoom 500');
    assert.equal(row.lastErrorAt.getTime(), at(3).getTime());
  });

  it('accepts a plain string error and truncates a huge one', async () => {
    await recordSyncError(SOURCE, 'plain text');
    assert.equal((await SyncHealthModel.findOne({ source: SOURCE }).lean()).lastError, 'plain text');
    await recordSyncError(SOURCE, new Error('x'.repeat(5000)));
    assert.equal((await SyncHealthModel.findOne({ source: SOURCE }).lean()).lastError.length, 500);
  });

  it('keeps one history point per 30 s but always the exact latest success', async () => {
    await recordSyncOk(SOURCE, new Date(T0));
    await recordSyncOk(SOURCE, new Date(T0 + 10 * 1000));
    await recordSyncOk(SOURCE, new Date(T0 + 20 * 1000));
    await recordSyncOk(SOURCE, new Date(T0 + 40 * 1000));
    const row = await SyncHealthModel.findOne({ source: SOURCE }).lean();
    assert.equal(row.okTimes.length, 2);
    assert.equal(row.lastOkAt.getTime(), T0 + 40 * 1000);
  });

  it('never throws on an unknown source, it reports false', async () => {
    const original = console.error;
    console.error = () => {};
    try {
      assert.equal(await recordSyncOk('nope'), false);
      assert.equal(await recordSyncError('nope', 'x'), false);
      assert.equal(await wasSourceHealthy('nope', { fromMs: 0, toMs: 1, maxAgeMs: 1 }), false);
    } finally {
      console.error = original;
    }
    assert.equal(await SyncHealthModel.countDocuments({ source: 'nope' }), 0);
  });
});

describe('getAllSyncHealth', () => {
  it('lists every known source, never-run ones with nulls, and hides the history array', async () => {
    await recordSyncOk('google_meet', at(0));
    const all = await getAllSyncHealth();
    assert.deepEqual(all.map((r) => r.source), SYNC_SOURCES);
    const meet = all.find((r) => r.source === 'google_meet');
    assert.equal(meet.lastOkAt.getTime(), at(0).getTime());
    assert.equal('okTimes' in meet, false);
    const zoom = all.find((r) => r.source === 'zoom_phone');
    assert.equal(zoom.lastOkAt, null);
    assert.equal(zoom.lastError, null);
  });

  it('exposes a limit for each source', () => {
    for (const s of SYNC_SOURCES) assert.ok(SYNC_LIMITS_MS[s] > 0, s);
  });
});

describe('wasSourceHealthy (plan 2.7 window check)', () => {
  const window = (fromMin, toMin, maxAgeMin) => ({ fromMs: at(fromMin).getTime(), toMs: at(toMin).getTime(), maxAgeMs: maxAgeMin * MIN });

  it('is healthy when syncs kept landing through the whole window', async () => {
    for (const m of [-20, -10, 0, 10, 20, 30, 40]) await recordSyncOk(SOURCE, at(m));
    assert.equal(await wasSourceHealthy(SOURCE, window(0, 40, 30)), true);
  });

  it('is healthy when one earlier sync still covers the whole short window', async () => {
    await recordSyncOk(SOURCE, at(-10));
    assert.equal(await wasSourceHealthy(SOURCE, window(0, 15, 30)), true);
  });

  it('is unhealthy when there is a gap longer than the limit inside the window', async () => {
    // syncs at 0 and 45: between minute 30 and 45 the newest sync was older than 30 min.
    await recordSyncOk(SOURCE, at(0));
    await recordSyncOk(SOURCE, at(45));
    assert.equal(await wasSourceHealthy(SOURCE, window(0, 40, 30)), false);
    assert.equal(await wasSourceHealthy(SOURCE, window(0, 30, 30)), true, 'a window that ends at the limit is fine');
  });

  it('is unhealthy when the only sync is too old at the start of the window', async () => {
    await recordSyncOk(SOURCE, at(-45));
    assert.equal(await wasSourceHealthy(SOURCE, window(0, 10, 30)), false);
  });

  it('is unhealthy when the last sync was before the window ended and nothing followed it', async () => {
    await recordSyncOk(SOURCE, at(0));
    assert.equal(await wasSourceHealthy(SOURCE, window(0, 40, 30)), false);
  });

  it('is unhealthy with no history at all: unknown never counts as healthy', async () => {
    assert.equal(await wasSourceHealthy(SOURCE, window(0, 40, 30)), false);
  });

  it('is unhealthy when a sync only landed after the window began', async () => {
    await recordSyncOk(SOURCE, at(20));
    assert.equal(await wasSourceHealthy(SOURCE, window(0, 40, 30)), false);
  });

  it('rejects nonsense windows', async () => {
    await recordSyncOk(SOURCE, at(0));
    assert.equal(await wasSourceHealthy(SOURCE, { fromMs: 10, toMs: 5, maxAgeMs: 1000 }), false);
    assert.equal(await wasSourceHealthy(SOURCE, { fromMs: NaN, toMs: 5, maxAgeMs: 1000 }), false);
    assert.equal(await wasSourceHealthy(SOURCE, { fromMs: 1, toMs: 5 }), false);
  });

  it('a failed run in the window does not hide earlier successes, the age rule decides', async () => {
    await recordSyncOk(SOURCE, at(0));
    await recordSyncError(SOURCE, 'blip', at(5));
    assert.equal(await wasSourceHealthy(SOURCE, window(0, 10, 30)), true);
  });

  it('syncOkBetween finds a run inside a window (used for the verdict job check)', async () => {
    await recordSyncOk('verdict_job', at(1));
    await recordSyncOk('verdict_job', at(2));
    assert.equal(await syncOkBetween('verdict_job', at(1.5).getTime(), at(5).getTime()), true);
    assert.equal(await syncOkBetween('verdict_job', at(3).getTime(), at(5).getTime()), false);
    assert.equal(await syncOkBetween('google_meet', at(0).getTime(), at(5).getTime()), false);
  });
});

describe('Google Meet sync reports its health', () => {
  const CRED_VARS = ['GOOGLE_SERVICE_ACCOUNT_KEY_JSON', 'GOOGLE_SERVICE_ACCOUNT_KEY_FILE', 'GOOGLE_CLIENT_EMAIL', 'GOOGLE_PRIVATE_KEY'];

  it('records an error when credentials are missing (the production symptom in plan P3)', async () => {
    for (const v of CRED_VARS) delete process.env[v];
    delete process.env.MEET_API_ATTENDANCE_ENABLED;
    const warn = console.warn;
    console.warn = () => {};
    try {
      await pollMeetApiAttendance();
    } finally {
      console.warn = warn;
      process.env.MEET_API_ATTENDANCE_ENABLED = 'false';
    }
    const row = await SyncHealthModel.findOne({ source: 'google_meet' }).lean();
    assert.match(row.lastError, /credentials/i);
    assert.equal(row.lastOkAt, null);
  });

  it('writes nothing when the verifier is switched off on purpose', async () => {
    process.env.MEET_API_ATTENDANCE_ENABLED = 'false';
    await pollMeetApiAttendance();
    assert.equal(await SyncHealthModel.countDocuments({ source: 'google_meet' }), 0);
  });

  describe('with credentials present (fake, never used: bookings are stubbed)', () => {
    before(() => {
      delete process.env.MEET_API_ATTENDANCE_ENABLED;
      process.env.GOOGLE_CLIENT_EMAIL = 'fake@fake.iam.gserviceaccount.com';
      process.env.GOOGLE_PRIVATE_KEY = 'not-a-real-key';
    });
    after(() => {
      for (const v of CRED_VARS) delete process.env[v];
      process.env.MEET_API_ATTENDANCE_ENABLED = 'false';
      mock.restoreAll();
    });

    const stubBookings = (result) =>
      mock.method(CampaignBookingModel, 'find', () => ({
        select: () => ({ lean: () => (result instanceof Error ? Promise.reject(result) : Promise.resolve(result)) }),
      }));

    it('records ok after a poll cycle that finished cleanly', async () => {
      stubBookings([]);
      await pollMeetApiAttendance();
      const row = await SyncHealthModel.findOne({ source: 'google_meet' }).lean();
      assert.ok(row.lastOkAt, 'lastOkAt set');
      assert.equal(row.lastError, null);
      mock.restoreAll();
    });

    it('records an error when the poll itself fails', async () => {
      stubBookings(new Error('mongo went away'));
      const log = console.error;
      console.error = () => {};
      try {
        await pollMeetApiAttendance();
      } finally {
        console.error = log;
      }
      const row = await SyncHealthModel.findOne({ source: 'google_meet' }).lean();
      assert.equal(row.lastError, 'mongo went away');
      assert.equal(row.lastOkAt, null);
      mock.restoreAll();
    });

    it('records ok after a clean live check and an error after a failed one', async () => {
      // No host email: processBooking returns before touching Google, which is a clean run.
      await syncBookingFromMeetNow({ bookingId: 'x', scheduledEventStartTime: new Date() });
      const ok = await SyncHealthModel.findOne({ source: 'google_meet' }).lean();
      assert.ok(ok.lastOkAt);
      // A database failure inside processBooking is a failed sync.
      mock.method(BdaAttendanceModel, 'findOne', () => Promise.reject(new Error('db down')));
      const warn = console.warn;
      console.warn = () => {};
      try {
        await syncBookingFromMeetNow({ bookingId: 'y', calendlyHost: { email: 'h@x.invalid' }, scheduledEventStartTime: new Date() });
      } finally {
        console.warn = warn;
        mock.restoreAll();
      }
      const failed = await SyncHealthModel.findOne({ source: 'google_meet' }).lean();
      assert.equal(failed.lastError, 'db down');
    });
  });
});
