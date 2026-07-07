#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Phase 0 spike: verify the Meet REST API works end-to-end for one meeting.
//
// Usage:
//   node scripts/meet-api-spike.mjs <host-email> <meet-code-or-url>
//
// Example:
//   node scripts/meet-api-spike.mjs bda@yourdomain.com abc-mnop-xyz
//   node scripts/meet-api-spike.mjs bda@yourdomain.com "https://meet.google.com/abc-mnop-xyz"
//
// Requires in .env: GOOGLE_CLIENT_EMAIL, GOOGLE_PRIVATE_KEY
// Requires one-time Admin console DWD setup — see MEET_ATTENDANCE_SETUP.md.
//
// What success looks like: the conference record prints with start/end time,
// every participant with their join/leave sessions, and (if Directory access
// works) resolved emails for signed-in participants.
//
// What failure looks like:
//   403 PERMISSION_DENIED  → DWD scopes not authorized for the service account
//   404 / empty records    → no conference on that code, or the host is not
//                            the space owner (e.g. Calendly connected to a
//                            personal Gmail account)
// ---------------------------------------------------------------------------
import dotenv from 'dotenv';
dotenv.config();

import {
  extractMeetCode,
  findConferenceRecords,
  listParticipantsWithSessions,
  mergeParticipants,
  resolveUserEmail,
} from '../Utils/MeetApiHelper.js';

const [hostEmail, rawCode] = process.argv.slice(2);
if (!hostEmail || !rawCode) {
  console.error('Usage: node scripts/meet-api-spike.mjs <host-email> <meet-code-or-url>');
  process.exit(1);
}

const meetCode = extractMeetCode(rawCode);
if (!meetCode) {
  console.error(`Could not extract a Meet code from "${rawCode}"`);
  process.exit(1);
}

console.log(`Host (impersonated): ${hostEmail}`);
console.log(`Meet code:           ${meetCode}\n`);

try {
  const records = await findConferenceRecords({ hostEmail, meetCode, scheduledStart: null });
  if (records.length === 0) {
    console.log('No conference record found for this code.');
    console.log('Either no meeting ever ran on this link, or the impersonated user is not the space owner.');
    process.exit(2);
  }

  console.log(`CONFERENCE RECORDS (${records.length})`);
  for (const r of records) {
    console.log(`  ${r.name}`);
    console.log(`    start: ${r.startTime}   end: ${r.endTime || '(still running)'}`);
  }
  console.log('');

  const perRecord = [];
  for (const r of records) {
    perRecord.push(
      ...(await listParticipantsWithSessions({ hostEmail, conferenceRecordName: r.name }))
    );
  }
  const participants = mergeParticipants(perRecord);

  console.log(`PARTICIPANTS (${participants.length})`);
  for (const p of participants) {
    const email = p.userId ? await resolveUserEmail({ hostEmail, userId: p.userId }) : null;
    console.log(`\n  ${p.displayName || 'Unknown'}  [${p.kind}]${email ? `  <${email}>` : ''}`);
    console.log(`    first joined: ${p.earliestStartTime?.toISOString() || '—'}`);
    console.log(`    last left:    ${p.latestEndTime?.toISOString() || '(still in call)'}`);
    for (const s of p.sessions) {
      const dur = s.startTime && s.endTime
        ? `${Math.round((s.endTime - s.startTime) / 60000)} min`
        : '(open)';
      console.log(`    session: ${s.startTime?.toISOString()} → ${s.endTime?.toISOString() || 'now'}  ${dur}`);
    }
  }
  console.log('\nSpike PASSED — the Meet REST API is fully usable for this domain.');
} catch (err) {
  const status = err?.response?.status || err?.code;
  console.error(`\nSpike FAILED (${status || 'error'}): ${err?.message}`);
  if (status === 403) {
    console.error('→ Domain-wide delegation scopes are not authorized. See MEET_ATTENDANCE_SETUP.md.');
  }
  process.exit(3);
}
