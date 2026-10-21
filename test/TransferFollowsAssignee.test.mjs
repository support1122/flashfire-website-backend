import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { connectTestDb, disconnectTestDb } from './helpers/testDb.mjs';
import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';
import { getAssignedBdaLabel } from '../Utils/BdaAssignment.js';
import { applyBdaOwnLeadScope } from '../Controllers/CampaignBookingController.js';

// After an admin hands a meeting to another BDA (attendanceAssignee), everything that names or filters by "the BDA"
// has to follow: the reminder text, the recap header, and which meetings each BDA sees in their CRM list.

const RUN = Math.random().toString(36).slice(2, 8);
const D = `tf-${RUN}.test.invalid`;
const PREFIX = `__tf_${RUN}_`;
const KAL = `kal@${D}`;
const SID = `sid@${D}`;
let seq = 0;

async function mk({ host = null, assignee = null }) {
  const bookingId = `${PREFIX}${++seq}`;
  await CampaignBookingModel.create({
    bookingId,
    clientName: `Client ${seq}`,
    clientEmail: `${bookingId}@${D}`,
    bookingStatus: 'scheduled',
    utmSource: 'direct',
    scheduledEventStartTime: new Date(Date.now() + 86_400_000),
    scheduledEventEndTime: new Date(Date.now() + 86_400_000 + 1_800_000),
    bookingCreatedAt: new Date(),
    calendlyHost: host ? { email: host, name: host.split('@')[0] } : undefined,
    attendanceAssignee: assignee ? { email: assignee, name: assignee.split('@')[0] } : undefined,
  });
  return bookingId;
}

const visibleTo = async (email) => {
  const q = applyBdaOwnLeadScope({ bookingId: { $regex: `^${PREFIX}` } }, { crmUser: { bdaRole: 'bda', email } });
  return new Set((await CampaignBookingModel.find(q).select('bookingId').lean()).map((b) => b.bookingId));
};

before(connectTestDb);
after(async () => {
  await CampaignBookingModel.deleteMany({ bookingId: { $regex: `^${PREFIX}` } });
  await disconnectTestDb();
});

describe('getAssignedBdaLabel', () => {
  it('names the transferred-to BDA first, then the Calendly host, then a CRM claim', () => {
    const b = { attendanceAssignee: { name: 'Sid' }, calendlyHost: { name: 'Kal' }, claimedBy: { name: 'Adit' } };
    assert.equal(getAssignedBdaLabel(b), 'Sid');
    assert.equal(getAssignedBdaLabel({ ...b, attendanceAssignee: { email: '', name: null } }), 'Kal');
    assert.equal(getAssignedBdaLabel({ calendlyHost: { email: 'kal@x' } }), 'kal@x', 'falls back to the email');
    assert.equal(getAssignedBdaLabel({ claimedBy: { name: 'Adit' } }), 'Adit');
    assert.equal(getAssignedBdaLabel({}), null);
    assert.equal(getAssignedBdaLabel(null), null);
  });
});

describe('a BDA sees the meetings assigned to them after a transfer', () => {
  it('moves the meeting from the old host to the new BDA, and leaves everything else as it was', async () => {
    const untouched = await mk({ host: KAL });
    const moved = await mk({ host: KAL, assignee: SID });
    const movedBack = await mk({ host: SID, assignee: KAL });
    const noHost = await mk({});
    const noHostMoved = await mk({ assignee: SID });

    const kal = await visibleTo(KAL);
    const sid = await visibleTo(SID);

    assert.ok(kal.has(untouched) && !sid.has(untouched), 'no transfer: the Calendly host rule is unchanged');
    assert.ok(sid.has(moved) && !kal.has(moved), 'the new BDA sees it and the old host stops seeing it');
    assert.ok(kal.has(movedBack) && !sid.has(movedBack));
    assert.ok(kal.has(noHost) && sid.has(noHost), 'a meeting with no host and no transfer stays visible to every BDA, as before');
    assert.ok(sid.has(noHostMoved) && !kal.has(noHostMoved), 'a transfer of a hostless meeting makes it that BDA only');
  });

  it('matches the email case-insensitively and does not scope admins', async () => {
    const id = await mk({ host: KAL, assignee: SID });
    const q = applyBdaOwnLeadScope({ bookingId: id }, { crmUser: { bdaRole: 'bda', email: SID.toUpperCase() } });
    assert.equal(await CampaignBookingModel.countDocuments(q), 1);
    const admin = applyBdaOwnLeadScope({ bookingId: id }, { crmUser: { bdaRole: 'admin', email: KAL } });
    assert.equal(await CampaignBookingModel.countDocuments(admin), 1);
  });
});
