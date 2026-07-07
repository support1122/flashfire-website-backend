import { google } from 'googleapis';
import fs from 'fs';

// ---------------------------------------------------------------------------
// Google Meet REST API v2 helper (service account + domain-wide delegation).
//
// The service account impersonates the meeting HOST (the Calendly round-robin
// host, who is the Meet space owner because Calendly creates the Meet on the
// host's Google Calendar). As organizer, the impersonated user can list
// conference records, participants, and participant sessions.
//
// Credentials: GOOGLE_SERVICE_ACCOUNT_KEY_FILE (path to the JSON key,
// preferred) or GOOGLE_CLIENT_EMAIL + GOOGLE_PRIVATE_KEY.
//
// One-time admin setup required (see MEET_ATTENDANCE_SETUP.md):
//   Google Admin console → Security → API controls → Domain-wide delegation →
//   authorize the service account client ID for the scopes below.
// ---------------------------------------------------------------------------

const MEET_SCOPES = [
  'https://www.googleapis.com/auth/meetings.space.readonly',
];
const DIRECTORY_SCOPES = [
  'https://www.googleapis.com/auth/admin.directory.user.readonly',
];

// Meet codes look like abc-mnop-xyz (3-4-3 lowercase letters).
const MEET_CODE_RE = /([a-z]{3,4})-([a-z]{4})-([a-z]{3,4})/i;

/** Extract a Meet code from a bare code or any meet.google.com URL. Null if none. */
export function extractMeetCode(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const m = raw.match(MEET_CODE_RE);
  return m ? `${m[1]}-${m[2]}-${m[3]}`.toLowerCase() : null;
}

/**
 * Resolve a Calendly "…/events/{uuid}/google_meet" join URL to the real
 * meet.google.com URL by following its 302 redirect (no auth needed).
 * Returns the Meet URL or null.
 */
export async function resolveCalendlyMeetUrl(calendlyUrl) {
  if (!calendlyUrl || !/calendly\.com\/events\/.+\/google_meet/i.test(calendlyUrl)) {
    return null;
  }
  try {
    const res = await fetch(calendlyUrl, { method: 'HEAD', redirect: 'manual' });
    const location = res.headers.get('location') || '';
    return /meet\.google\.com/i.test(location) ? location : null;
  } catch {
    return null;
  }
}

let cachedKey = null;

function loadCredentials() {
  if (cachedKey) return cachedKey;

  // 1. Whole JSON key pasted into one env var (easiest on Render & co.).
  const inlineJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON;
  if (inlineJson) {
    try {
      const parsed = JSON.parse(inlineJson);
      if (parsed.client_email && parsed.private_key) {
        cachedKey = { clientEmail: parsed.client_email, privateKey: parsed.private_key };
        return cachedKey;
      }
    } catch (e) {
      console.error('[MeetApiHelper] GOOGLE_SERVICE_ACCOUNT_KEY_JSON is not valid JSON:', e?.message);
    }
  }

  // 2. Path to the JSON key file on disk.
  const keyFile = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE;
  if (keyFile && fs.existsSync(keyFile)) {
    const parsed = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
    cachedKey = { clientEmail: parsed.client_email, privateKey: parsed.private_key };
    return cachedKey;
  }

  // 3. Separate email + private key env vars.
  const clientEmail = process.env.GOOGLE_CLIENT_EMAIL;
  let privateKey = process.env.GOOGLE_PRIVATE_KEY;
  if (!clientEmail || !privateKey) return null;
  privateKey = privateKey.replace(/\\n/g, '\n');
  cachedKey = { clientEmail, privateKey };
  return cachedKey;
}

/** True when service-account credentials are configured. */
export function hasMeetApiCredentials() {
  return loadCredentials() !== null;
}

function getJwtClient(subjectEmail, scopes) {
  const creds = loadCredentials();
  if (!creds || !subjectEmail) return null;
  // NOTE: positional JWT args are broken in this google-auth-library version
  // ("No key or keyFile set") — always use the options object.
  return new google.auth.JWT({
    email: creds.clientEmail,
    key: creds.privateKey,
    scopes,
    subject: subjectEmail, // DWD: the Workspace user this request acts as
  });
}

export function meetClientFor(hostEmail) {
  const auth = getJwtClient(hostEmail, MEET_SCOPES);
  if (!auth) return null;
  return google.meet({ version: 'v2', auth });
}

/**
 * All conference records for a meet code inside the booking's window.
 * A Meet code is reused across instances ("end call for everyone" + rejoin
 * starts a NEW record), so one booking can span several records. We take every
 * record that started between (scheduledStart - 30 min) and (windowEnd),
 * oldest first.
 * Returns [{ name, startTime, endTime }].
 */
export async function findConferenceRecords({ hostEmail, meetCode, scheduledStart, windowEnd }) {
  const meet = meetClientFor(hostEmail);
  if (!meet) return [];

  const res = await meet.conferenceRecords.list({
    filter: `space.meeting_code = "${meetCode}"`,
    pageSize: 25,
  });
  const records = res?.data?.conferenceRecords || [];

  const notBefore = scheduledStart
    ? new Date(new Date(scheduledStart).getTime() - 30 * 60 * 1000)
    : null;
  const notAfter = windowEnd ? new Date(windowEnd) : null;

  return records
    .filter((r) => {
      const start = new Date(r.startTime);
      if (notBefore && start < notBefore) return false;
      if (notAfter && start > notAfter) return false;
      return true;
    })
    .sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
}

/** Latest matching record (spike/back-compat convenience). */
export async function findConferenceRecord({ hostEmail, meetCode, scheduledStart }) {
  const records = await findConferenceRecords({ hostEmail, meetCode, scheduledStart });
  return records[records.length - 1] || null;
}

/**
 * List all participants of a conference record with their sessions.
 * Returns [{ name, displayName, kind: 'signedin'|'anonymous'|'phone',
 *            userId, earliestStartTime, latestEndTime,
 *            sessions: [{ startTime, endTime }] }]
 */
export async function listParticipantsWithSessions({ hostEmail, conferenceRecordName }) {
  const meet = meetClientFor(hostEmail);
  if (!meet) return [];

  const participants = [];
  let pageToken = undefined;
  do {
    const res = await meet.conferenceRecords.participants.list({
      parent: conferenceRecordName,
      pageSize: 100,
      pageToken,
    });
    participants.push(...(res?.data?.participants || []));
    pageToken = res?.data?.nextPageToken || undefined;
  } while (pageToken);

  const out = [];
  for (const p of participants) {
    const kind = p.signedinUser ? 'signedin' : p.anonymousUser ? 'anonymous' : 'phone';
    const identity = p.signedinUser || p.anonymousUser || p.phoneUser || {};

    const sessions = [];
    let sessionToken = undefined;
    do {
      const sres = await meet.conferenceRecords.participants.participantSessions.list({
        parent: p.name,
        pageSize: 100,
        pageToken: sessionToken,
      });
      for (const s of sres?.data?.participantSessions || []) {
        sessions.push({
          startTime: s.startTime ? new Date(s.startTime) : null,
          endTime: s.endTime ? new Date(s.endTime) : null,
        });
      }
      sessionToken = sres?.data?.nextPageToken || undefined;
    } while (sessionToken);

    out.push({
      name: p.name,
      displayName: identity.displayName || null,
      kind,
      // "users/{id}" — interoperable with Admin SDK Directory API.
      userId: p.signedinUser?.user || null,
      earliestStartTime: p.earliestStartTime ? new Date(p.earliestStartTime) : null,
      latestEndTime: p.latestEndTime ? new Date(p.latestEndTime) : null,
      sessions,
    });
  }
  return out;
}

/**
 * Merge participants of the same person across multiple conference records
 * (same code restarted). Identity key: signed-in user ID, else display name.
 */
export function mergeParticipants(perRecordParticipants) {
  const byKey = new Map();
  for (const p of perRecordParticipants) {
    const key = p.userId || `anon:${(p.displayName || '').toLowerCase()}`;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, { ...p, sessions: [...p.sessions] });
      continue;
    }
    prev.sessions.push(...p.sessions);
    if (p.earliestStartTime && (!prev.earliestStartTime || p.earliestStartTime < prev.earliestStartTime)) {
      prev.earliestStartTime = p.earliestStartTime;
    }
    // latestEndTime: null means still in the call — that wins.
    if (prev.latestEndTime !== null) {
      prev.latestEndTime =
        p.latestEndTime === null
          ? null
          : p.latestEndTime > prev.latestEndTime
            ? p.latestEndTime
            : prev.latestEndTime;
    }
  }
  const merged = [...byKey.values()];
  for (const p of merged) {
    p.sessions.sort((a, b) => (a.startTime || 0) - (b.startTime || 0));
  }
  return merged;
}

// Directory ID → email cache (process lifetime; user IDs are stable).
const emailCache = new Map();

/**
 * Resolve a Meet participant user ID ("users/12345") to a primary email.
 * Tries domain_public view as the host first (works for non-admin users on
 * public fields), then falls back to an admin impersonation if
 * GOOGLE_ADMIN_IMPERSONATE is set. Returns lowercase email or null.
 */
export async function resolveUserEmail({ hostEmail, userId }) {
  if (!userId) return null;
  const id = userId.replace(/^users\//, '');
  if (emailCache.has(id)) return emailCache.get(id);

  const attempts = [
    { subject: hostEmail, viewType: 'domain_public' },
    ...(process.env.GOOGLE_ADMIN_IMPERSONATE
      ? [{ subject: process.env.GOOGLE_ADMIN_IMPERSONATE, viewType: undefined }]
      : []),
  ];

  for (const attempt of attempts) {
    try {
      const auth = getJwtClient(attempt.subject, DIRECTORY_SCOPES);
      if (!auth) continue;
      const admin = google.admin({ version: 'directory_v1', auth });
      const res = await admin.users.get({
        userKey: id,
        ...(attempt.viewType ? { viewType: attempt.viewType } : {}),
        fields: 'primaryEmail',
      });
      const email = (res?.data?.primaryEmail || '').toLowerCase() || null;
      if (email) {
        emailCache.set(id, email);
        return email;
      }
    } catch {
      // Fall through to next attempt / null — displayName matching still works.
    }
  }
  emailCache.set(id, null);
  return null;
}
