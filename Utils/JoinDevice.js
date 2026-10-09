// Which device did the BDA join the meeting from?
//
// Google's Meet API says WHO was in the call and whether they dialed in by phone ('phone' participants), but not
// whether a signed-in person used the phone app or a browser. So "mobile" is inferred the way the team asked:
// Google saw the BDA in the call, the extension was running and logged in on their PC at that time, yet no Meet tab
// on that PC was in this call. Then the BDA was in the call from somewhere else, almost always their phone.
//
//   phone_dial_in  Google lists the BDA as a phone (dial-in) participant
//   pc             the extension saw this call in a Meet tab (an extension_join, or a heartbeat with the tab in call)
//   mobile         Google saw the BDA; the extension heartbeated during the session but never saw the call
//   unknown        Google saw the BDA; the extension sent no heartbeat during the session (offline, another Chrome
//                  profile, laptop shut). Could be a PC without the extension or a phone, so we do not guess.
//   null           nobody saw the BDA join (not joined, or Google has not reported yet)
//
// Pure: no database. The caller passes the attendance row, the booking's meet code and the heartbeat log rows.

const toMs = (d) => (d == null ? NaN : d instanceof Date ? d.getTime() : new Date(d).getTime());

/** A heartbeat within this much of a session counts as "alive during the session" (heartbeats are every 60 s). */
const ALIVE_SLACK_MS = 2 * 60 * 1000;

/** One Discord line for the join device (Utils/JoinDevice.js), or '' when nobody saw the join. */
export function deviceLine(device) {
  const label = {
    pc: '💻 PC (the attendance extension saw the call)',
    mobile: '📱 Mobile (likely): Google saw the BDA while the extension ran on the PC without this call',
    phone_dial_in: '☎️ Dial-in by phone',
    unknown: '❔ Unknown: the extension was offline during the call',
  }[device];
  return label ? `**Device:** ${label}\n` : '';
}

export const JOIN_DEVICES = Object.freeze(['pc', 'mobile', 'phone_dial_in', 'unknown']);

function sessionsOf(row, nowMs) {
  return (Array.isArray(row?.sessions) ? row.sessions : [])
    .map((s) => ({ start: toMs(s.startTime), end: s.endTime ? toMs(s.endTime) : nowMs }))
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.end));
}

const within = (t, sessions, slack = 0) => sessions.some((s) => t >= s.start - slack && t <= s.end + slack);

/**
 * @param {object} p
 * @param {object|null} p.row attendance row (sessions from Google, signals, googleParticipantKind)
 * @param {string|null} p.meetCode the booking's Meet code
 * @param {Array<{at: Date, meetTabs: Array<{code, inCall}>}>} p.logs this BDA's heartbeats around the meeting
 * @param {number} [p.nowMs]
 * @returns {{ device: string|null, reason: string }}
 */
export function classifyJoinDevice({ row, meetCode, logs = [], nowMs = Date.now() }) {
  if (!row) return { device: null, reason: 'no_row' };
  if (row.googleParticipantKind === 'phone') return { device: 'phone_dial_in', reason: 'google_phone_participant' };

  const code = String(meetCode || '').toLowerCase();
  const sessions = sessionsOf(row, nowMs);
  const extensionJoined = (row.signals || []).some((s) => s.kind === 'extension_join');
  const tabInCall = (logs || []).some(
    (l) =>
      (sessions.length === 0 || within(toMs(l.at), sessions, ALIVE_SLACK_MS)) &&
      (l.meetTabs || []).some((t) => t?.inCall === true && code && String(t.code || '').toLowerCase() === code)
  );
  if (extensionJoined || tabInCall) return { device: 'pc', reason: extensionJoined ? 'extension_join' : 'heartbeat_tab_in_call' };

  // Without Google's sessions we only know what the extension saw, and it saw nothing.
  if (sessions.length === 0) return { device: null, reason: 'no_join_seen' };

  const aliveDuring = (logs || []).some((l) => within(toMs(l.at), sessions, ALIVE_SLACK_MS));
  if (aliveDuring) return { device: 'mobile', reason: 'extension_running_but_not_in_call' };
  return { device: 'unknown', reason: 'extension_offline_during_call' };
}

/** Load the heartbeats that matter for one meeting: from 5 min before the first session to its end (+slack). */
export async function loadHeartbeatsForSessions(bdaEmail, row, nowMs = Date.now()) {
  const sessions = sessionsOf(row, nowMs);
  if (!bdaEmail || sessions.length === 0) return [];
  const { BdaHeartbeatLogModel } = await import('../Schema_Models/BdaHeartbeatLog.js');
  const from = Math.min(...sessions.map((s) => s.start)) - 5 * 60 * 1000;
  const to = Math.max(...sessions.map((s) => s.end)) + ALIVE_SLACK_MS;
  return BdaHeartbeatLogModel.find({ bdaEmail, at: { $gte: new Date(from), $lte: new Date(to) } })
    .select('at meetTabs')
    .lean();
}
