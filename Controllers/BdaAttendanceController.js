import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { DateTime } from 'luxon';
import { getCrmJwtSecret } from '../Middlewares/CrmAuth.js';
import { BdaAttendanceModel } from '../Schema_Models/BdaAttendance.js';
import {
  BdaAttendanceEndEventModel,
  END_SOURCES,
} from '../Schema_Models/BdaAttendanceEndEvent.js';
import { BdaAttendanceWarnDedupeModel } from '../Schema_Models/BdaAttendanceWarnDedupe.js';
import { CampaignBookingModel } from '../Schema_Models/CampaignBooking.js';
import { CrmUserModel } from '../Schema_Models/CrmUser.js';
import { DiscordConnect } from '../Utils/DiscordConnect.js';
import { setOtp, getOtp, decrementAttempts, deleteOtp, getOtpCacheStats } from '../Utils/CrmOtpCache.js';
import { sendBdaOtpEmail } from '../Utils/SendGridHelper.js';

// ==================== Helpers ====================

function formatIST(date) {
  if (!date) return 'N/A';
  return DateTime.fromJSDate(new Date(date))
    .setZone('Asia/Kolkata')
    .toFormat('dd MMM yyyy, hh:mm a');
}

// Present/Join/Leave/Manual → goes to the attendance webhook
async function sendPresentDiscord(message) {
  const url = process.env.DISCORD_BDA_ATTENDANCE_WEBHOOK_URL || null;
  if (!url) {
    console.warn('[BdaAttendance] DISCORD_BDA_ATTENDANCE_WEBHOOK_URL not configured');
    return;
  }
  await DiscordConnect(url, message, false);
}

// Leave/Duration → goes to the duration webhook (+ attendance webhook as fallback)
async function sendDurationDiscord(message) {
  const url = process.env.DISCORD_BDA_DURATION_WEBHOOK_URL || process.env.DISCORD_BDA_ATTENDANCE_WEBHOOK_URL || null;
  if (!url) {
    console.warn('[BdaAttendance] DISCORD_BDA_DURATION_WEBHOOK_URL not configured');
    return;
  }
  await DiscordConnect(url, message, false);
}

// Absent/Error → goes to the error webhook
async function sendAbsentDiscord(message) {
  const url = process.env.DISCORD_BDA_ABSENT_WEBHOOK_URL || null;
  if (!url) {
    console.warn('[BdaAttendance] DISCORD_BDA_ABSENT_WEBHOOK_URL not configured');
    return;
  }
  await DiscordConnect(url, message, false);
}

// Simple in-memory rate limiter
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60 * 60 * 1000; // 1 hour
const RATE_LIMIT_MAX = 10;

function checkRateLimit(key) {
  const now = Date.now();
  const entry = rateLimitMap.get(key);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW) {
    rateLimitMap.set(key, { windowStart: now, count: 1 });
    return true;
  }
  if (entry.count >= RATE_LIMIT_MAX) return false;
  entry.count++;
  return true;
}

// Cleanup rate limit map every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitMap) {
    if (now - entry.windowStart > RATE_LIMIT_WINDOW) {
      rateLimitMap.delete(key);
    }
  }
}, 10 * 60 * 1000);

// SSE connections map: bdaEmail -> Set<res>
const sseConnections = new Map();

export function notifyBdaSSE(bdaEmail, event, data) {
  const connections = sseConnections.get(bdaEmail);
  if (!connections || connections.size === 0) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of connections) {
    try {
      res.write(payload);
    } catch (err) {
      connections.delete(res);
    }
  }
}

// ==================== POST /api/bda-attendance/register ====================

// ==================== OTP Helpers ====================

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

const OTP_CACHE_PREFIX = 'bda_attendance:';

function otpCacheKey(email) {
  return `${OTP_CACHE_PREFIX}${normalizeEmail(email)}`;
}

function generateOtp() {
  return String(crypto.randomInt(100000, 1000000)); // 6 digits
}

function bdaOtpHash(email, otp) {
  const secret = process.env.CRM_OTP_HASH_SECRET || getCrmJwtSecret();
  const value = `${otpCacheKey(email)}|${String(otp).trim()}|${secret}`;
  return crypto.createHash('sha256').update(value).digest('hex');
}

/** CRM profile name, else email local-part, else email */
function bdaDisplayNameFromUser(user) {
  const email = normalizeEmail(user?.email);
  const rawName = user?.name != null ? String(user.name).trim() : '';
  if (rawName) return rawName;
  if (!email) return '';
  const local = email.split('@')[0];
  return local || email;
}

function assertBookingClaimedBy(booking, bdaEmail) {
  const claimed = booking?.claimedBy?.email;
  return claimed && normalizeEmail(claimed) === normalizeEmail(bdaEmail);
}

// ==================== Meet link + session close helpers (join/leave/end) ====================

function extractMeetCodeFromUrl(url) {
  if (!url || typeof url !== 'string') return null;
  const m = url.match(/meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})/i);
  if (m) return m[1].toLowerCase();
  const m2 = url.match(/meet\.google\.com\/([a-zA-Z0-9_-]+)/);
  if (!m2) return null;
  const seg = m2[1].toLowerCase();
  // Not a real room — would false-match bookings or imply "joined" incorrectly
  if (seg === 'landing' || seg === 'new' || seg === 'about' || seg === 'getting-started') {
    return null;
  }
  return seg;
}

/** Lobby / home URL — not an actual Google Meet room */
function isGoogleMeetLandingUrl(url) {
  if (!url || typeof url !== 'string') return false;
  const s = url.trim().toLowerCase();
  if (!s.includes('meet.google.com')) return false;
  return /meet\.google\.com\/landing(\/|\?|#|$)/i.test(s);
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Find best-matching booking for a Meet URL (time window around now). */
async function findBookingByMeetLink(meetLink) {
  const code = extractMeetCodeFromUrl(meetLink);
  if (!code) return { bookingId: null, booking: null, candidates: 0 };

  const from = new Date(Date.now() - 48 * 60 * 60 * 1000);
  const to = new Date(Date.now() + 4 * 60 * 60 * 1000);
  const codeRe = escapeRegex(code);

  const bookings = await CampaignBookingModel.find({
    scheduledEventStartTime: { $gte: from, $lte: to },
    $or: [
      { googleMeetCode: new RegExp(`^${codeRe}$`, 'i') },
      { googleMeetUrl: { $regex: codeRe, $options: 'i' } },
      { calendlyMeetLink: { $regex: codeRe, $options: 'i' } },
    ],
  })
    .lean();

  if (!bookings.length) return { bookingId: null, booking: null, candidates: 0 };

  const now = Date.now();
  const scored = bookings.map((b) => ({
    b,
    d: Math.abs(new Date(b.scheduledEventStartTime).getTime() - now),
  }));
  scored.sort((a, b) => a.d - b.d);
  return {
    bookingId: scored[0].b.bookingId,
    booking: scored[0].b,
    candidates: bookings.length,
  };
}

function meetLinksRoughMatch(booking, meetLink) {
  const c1 = extractMeetCodeFromUrl(meetLink);
  if (!c1 || !booking) return { mismatch: false };

  const parts = [
    booking.googleMeetCode,
    extractMeetCodeFromUrl(booking.googleMeetUrl || ''),
    extractMeetCodeFromUrl(booking.calendlyMeetLink || ''),
  ]
    .filter(Boolean)
    .map((c) => String(c).toLowerCase());

  if (parts.length === 0) return { mismatch: false };
  const mismatch = !parts.some((c) => c === c1);
  return { mismatch };
}

/**
 * Close an open in-meet session (joinedAt set, leftAt cleared).
 * @returns {{ closed: boolean, attendance: object|null, leaveTime: Date|null, durationMs: number|null }}
 */
async function closeBdaAttendanceSession({
  bookingId,
  bdaEmail,
  bdaName,
  leftAt,
  sendDurationNotification = true,
}) {
  const attendance = await BdaAttendanceModel.findOne({ bookingId, bdaEmail });

  if (!attendance) {
    notifyBdaSSE(bdaEmail, 'attendance_update', { bookingId });
    return { closed: false, attendance: null, leaveTime: null, durationMs: null };
  }

  if (!attendance.joinedAt) {
    notifyBdaSSE(bdaEmail, 'attendance_update', { bookingId });
    return {
      closed: false,
      noOpenSession: true,
      attendance,
      leaveTime: attendance.leftAt ? new Date(attendance.leftAt) : null,
      durationMs: attendance.durationMs ?? null,
    };
  }

  const leaveTime = leftAt ? new Date(leftAt) : new Date();
  const segmentMs = Math.max(
    0,
    leaveTime.getTime() - new Date(attendance.joinedAt).getTime()
  );
  attendance.cumulativeDurationMs = (attendance.cumulativeDurationMs || 0) + segmentMs;
  attendance.durationMs = attendance.cumulativeDurationMs;
  attendance.leftAt = leaveTime;
  attendance.joinedAt = null;
  await attendance.save();

  if (sendDurationNotification) {
    const booking = await CampaignBookingModel.findOne({ bookingId }).lean();
    const durationMin = Math.round(attendance.cumulativeDurationMs / 60000);
    const message =
      `🚪 **BDA Left Meeting**\n` +
      `**BDA:** ${bdaName} (${bdaEmail})\n` +
      `**Client:** ${booking?.clientName || 'Unknown'}\n` +
      `**Duration (total):** ${durationMin} min\n` +
      `**Left At:** ${formatIST(leaveTime)}`;

    await sendDurationDiscord(message);
  }

  const durationMin = Math.round(attendance.cumulativeDurationMs / 60000);
  notifyBdaSSE(bdaEmail, 'attendance_update', {
    bookingId,
    status: attendance.status,
    leftAt: leaveTime,
    durationMin,
    durationMs: attendance.durationMs,
  });

  return {
    closed: true,
    attendance,
    leaveTime,
    durationMs: attendance.durationMs,
  };
}

async function persistEndEventAndMetadata({
  emailNorm,
  name,
  bookingId,
  meetLink,
  meetCode,
  endedAt,
  endSource,
  requestId,
  joinedAtSnapshot,
  durationMsSnapshot,
  linkMismatch,
  unresolvedBooking,
  sessionClosed,
  durationMsAfterClose,
}) {
  try {
    await BdaAttendanceEndEventModel.create({
      bdaEmail: emailNorm,
      bdaName: name || emailNorm,
      bookingId: bookingId || null,
      meetLink: meetLink || null,
      meetCode: meetCode || null,
      joinedAtSnapshot: joinedAtSnapshot ? new Date(joinedAtSnapshot) : null,
      endedAt,
      endSource,
      durationMsSnapshot:
        durationMsSnapshot != null && !Number.isNaN(Number(durationMsSnapshot))
          ? Number(durationMsSnapshot)
          : null,
      durationMsAfterClose:
        durationMsAfterClose != null ? Number(durationMsAfterClose) : null,
      requestId,
      linkMismatch: Boolean(linkMismatch),
      unresolvedBooking: Boolean(unresolvedBooking),
      sessionClosed: Boolean(sessionClosed),
    });
  } catch (err) {
    if (err.code === 11000) {
      return { stored: true, deduped: true };
    }
    throw err;
  }

  if (bookingId) {
    await BdaAttendanceModel.updateOne(
      { bookingId, bdaEmail: emailNorm },
      {
        $set: {
          lastEndSource: endSource,
          lastEndedAt: endedAt,
          lastEndMeetLink: meetLink || null,
        },
      }
    );
  }

  return { stored: true, deduped: false };
}

async function processReportEndEventCore({
  emailNorm,
  name,
  bookingId: bodyBookingId,
  meetLink,
  leftAt,
  endSource,
  requestId,
  joinedAtSnapshot,
  durationMsSnapshot,
}) {
  if (!requestId || typeof requestId !== 'string') {
    return { ok: false, status: 400, body: { success: false, error: 'requestId is required' } };
  }

  if (!END_SOURCES.includes(endSource)) {
    return {
      ok: false,
      status: 400,
      body: { success: false, error: 'Invalid endSource' },
    };
  }

  if (meetLink && !meetLink.includes('meet.google.com')) {
    return {
      ok: false,
      status: 400,
      body: { success: false, error: 'Invalid meet link' },
    };
  }

  const existing = await BdaAttendanceEndEventModel.findOne({
    bdaEmail: emailNorm,
    requestId,
  }).lean();

  if (existing) {
    return {
      ok: true,
      status: 200,
      body: {
        success: true,
        deduped: true,
        sessionClosed: existing.sessionClosed,
        eventStored: true,
      },
    };
  }

  let bookingId = bodyBookingId || null;
  let booking = null;
  let unresolvedBooking = false;

  if (bookingId) {
    booking = await CampaignBookingModel.findOne({ bookingId }).lean();
    if (!booking) {
      return {
        ok: false,
        status: 404,
        body: { success: false, error: 'Booking not found' },
      };
    }
  } else if (meetLink) {
    const found = await findBookingByMeetLink(meetLink);
    if (found.bookingId) {
      bookingId = found.bookingId;
      booking = found.booking;
    } else {
      unresolvedBooking = true;
    }
  } else {
    return {
      ok: false,
      status: 400,
      body: {
        success: false,
        error: 'bookingId or meetLink is required',
      },
    };
  }

  let linkMismatch = false;
  if (booking && meetLink) {
    linkMismatch = meetLinksRoughMatch(booking, meetLink).mismatch;
  }

  const endedAt = leftAt ? new Date(leftAt) : new Date();
  const meetCode = extractMeetCodeFromUrl(meetLink) || null;

  let sessionClosed = false;
  let durationMsAfterClose = null;

  if (bookingId) {
    const closeResult = await closeBdaAttendanceSession({
      bookingId,
      bdaEmail: emailNorm,
      bdaName: name,
      leftAt: endedAt,
      sendDurationNotification: true,
    });
    sessionClosed =
      closeResult.closed ||
      Boolean(closeResult.noOpenSession && closeResult.durationMs != null);
    durationMsAfterClose = closeResult.durationMs;
  }

  await persistEndEventAndMetadata({
    emailNorm,
    name,
    bookingId,
    meetLink,
    meetCode,
    endedAt,
    endSource,
    requestId,
    joinedAtSnapshot,
    durationMsSnapshot,
    linkMismatch,
    unresolvedBooking,
    sessionClosed,
    durationMsAfterClose,
  });

  return {
    ok: true,
    status: 200,
    body: {
      success: true,
      deduped: false,
      sessionClosed,
      eventStored: true,
      bookingId: bookingId || null,
      unresolvedBooking,
      linkMismatch,
      durationMs: durationMsAfterClose,
    },
  };
}

// ==================== POST /api/bda-attendance/request-otp ====================

export async function requestBdaOtp(req, res) {
  try {
    const email = normalizeEmail(req.body?.email);
    if (!email || !isValidEmail(email)) {
      return res.status(400).json({ success: false, error: 'Invalid email' });
    }

    // Rate limit by IP
    const ip = req.ip || req.connection?.remoteAddress || 'unknown';
    if (!checkRateLimit(`bda-otp:${ip}`)) {
      return res.status(429).json({ success: false, error: 'Too many attempts. Try again later.' });
    }

    // Check if user exists and is explicitly deactivated
    const user = await CrmUserModel.findOne({ email }).lean();
    if (user && user.isActive === false) {
      return res.status(200).json({
        success: true,
        message: 'If your email is authorized, you will receive an OTP.',
      });
    }

    // Generate and send OTP (even if user doesn't exist yet — will auto-create on verify)
    const otp = generateOtp();
    console.log(`[BDA OTP] ${email} -> ${otp}`);

    const ttlSeconds = Number(process.env.CRM_OTP_TTL_SECONDS || 300);
    const expiresAtMs = Date.now() + ttlSeconds * 1000;
    setOtp(otpCacheKey(email), { otpHash: bdaOtpHash(email, otp), expiresAtMs, attemptsLeft: 5 });

    const displayName = user ? bdaDisplayNameFromUser(user) : email.split('@')[0];
    await sendBdaOtpEmail(email, otp, displayName);

    return res.status(200).json({
      success: true,
      message: 'OTP sent',
      cache: getOtpCacheStats(),
    });
  } catch (error) {
    console.error('[BdaAttendance] requestBdaOtp error:', error?.message || error);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
}

// ==================== POST /api/bda-attendance/verify-otp ====================

export async function verifyBdaOtp(req, res) {
  try {
    const email = normalizeEmail(req.body?.email);
    const otp = String(req.body?.otp || '').trim();

    if (!email || !isValidEmail(email)) {
      return res.status(400).json({ success: false, error: 'Invalid email' });
    }
    if (!/^\d{6}$/.test(otp)) {
      return res.status(400).json({ success: false, error: 'Invalid OTP format. Enter 6 digits.' });
    }

    const key = otpCacheKey(email);
    const entry = getOtp(key);
    if (!entry) {
      return res.status(401).json({ success: false, error: 'OTP expired or not found. Request a new one.' });
    }

    const incomingHash = bdaOtpHash(email, otp);
    const ok = crypto.timingSafeEqual(Buffer.from(incomingHash), Buffer.from(entry.otpHash));
    if (!ok) {
      const remaining = decrementAttempts(key);
      const attemptsLeft = remaining?.attemptsLeft || 0;
      return res.status(401).json({
        success: false,
        error: attemptsLeft > 0
          ? `Invalid OTP. ${attemptsLeft} attempt${attemptsLeft > 1 ? 's' : ''} remaining.`
          : 'Too many failed attempts. Request a new OTP.',
      });
    }

    // OTP valid - delete it
    deleteOtp(key);

    // Find or auto-create CrmUser
    let user = await CrmUserModel.findOne({ email }).lean();

    if (user && user.isActive === false) {
      return res.status(403).json({ success: false, error: 'User not authorized' });
    }

    let isNewUser = false;
    if (!user) {
      // Auto-create CrmUser with placeholder name
      const placeholderName = email.split('@')[0];
      const created = await CrmUserModel.create({
        email,
        name: placeholderName,
        permissions: [],
        isActive: true,
      });
      user = created.toObject();
      isNewUser = true;
      console.log(`[BdaAttendance] Auto-created CrmUser for ${email}`);
    }

    const displayName = bdaDisplayNameFromUser(user);

    // Check if name needs to be set (placeholder or empty)
    const emailLocalPart = email.split('@')[0];
    const needsName = isNewUser || !user.name || user.name === emailLocalPart;

    // Issue 90-day JWT for BDA extension
    const token = jwt.sign(
      {
        role: 'bda_extension',
        email: user.email,
        name: displayName,
      },
      getCrmJwtSecret(),
      { expiresIn: '90d' }
    );

    return res.status(200).json({
      success: true,
      token,
      expiresIn: '90d',
      bda: { name: displayName, email: user.email },
      needsName,
    });
  } catch (error) {
    console.error('[BdaAttendance] verifyBdaOtp error:', error?.message || error);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
}

// ==================== POST /api/bda-attendance/update-name ====================

export async function updateBdaName(req, res) {
  try {
    const { email } = req.bdaUser;
    const emailNorm = normalizeEmail(email);
    const name = String(req.body?.name || '').trim();

    if (!name || name.length < 2 || name.length > 100) {
      return res.status(400).json({ success: false, error: 'Name must be 2-100 characters' });
    }

    const user = await CrmUserModel.findOneAndUpdate(
      { email: emailNorm },
      { $set: { name } },
      { new: true }
    ).lean();

    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    // Issue a new JWT with the updated name
    const newToken = jwt.sign(
      { role: 'bda_extension', email: user.email, name },
      getCrmJwtSecret(),
      { expiresIn: '90d' }
    );

    return res.status(200).json({
      success: true,
      token: newToken,
      bda: { name, email: user.email },
    });
  } catch (error) {
    console.error('[BdaAttendance] updateBdaName error:', error?.message || error);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
}

// ==================== POST /api/bda-attendance/create-test-meeting ====================

export async function createTestMeeting(req, res) {
  try {
    const { clientName, startTime, durationMinutes, bdaEmail, bdaName, googleMeetUrl } = req.body;

    if (!clientName) {
      return res.status(400).json({ success: false, error: 'clientName is required' });
    }

    const start = startTime ? new Date(startTime) : new Date(Date.now() + 5 * 60 * 1000); // default: 5 min from now
    const durMin = durationMinutes || 30;
    const end = new Date(start.getTime() + durMin * 60 * 1000);

    const booking = await CampaignBookingModel.create({
      bookingId: `test_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
      utmSource: 'test',
      clientName,
      clientEmail: `${clientName.toLowerCase().replace(/\s+/g, '.')}@test.com`,
      bookingStatus: 'scheduled',
      scheduledEventStartTime: start,
      scheduledEventEndTime: end,
      googleMeetUrl: googleMeetUrl || '',
      googleMeetCode: '',
      claimedBy: {
        email: normalizeEmail(bdaEmail || 'test@flashfirehq.com'),
        name: bdaName || 'Test BDA',
        claimedAt: new Date(),
      },
    });

    return res.status(200).json({
      success: true,
      booking: {
        bookingId: booking.bookingId,
        clientName: booking.clientName,
        start: start.toISOString(),
        end: end.toISOString(),
        bdaEmail: booking.claimedBy.email,
      },
    });
  } catch (error) {
    console.error('[BdaAttendance] createTestMeeting error:', error?.message || error);
    return res.status(500).json({ success: false, error: 'Server error' });
  }
}

// ==================== GET /api/bda-attendance/my-meetings ====================

export async function getMyMeetings(req, res) {
  try {
    const { email } = req.bdaUser;
    const emailNorm = normalizeEmail(email);
    const now = new Date();
    const horizonPast = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const horizonFuture = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);

    // Show ALL scheduled meetings to ALL BDAs (not filtered by claimedBy)
    const bookings = await CampaignBookingModel.find({
      bookingStatus: { $in: ['paid', 'scheduled', 'completed'] },
      scheduledEventStartTime: { $gte: horizonPast, $lte: horizonFuture },
    })
      .sort({ scheduledEventStartTime: 1 })
      .select(
        'bookingId clientName clientEmail scheduledEventStartTime scheduledEventEndTime googleMeetUrl googleMeetCode calendlyMeetLink claimedBy'
      )
      .limit(100)
      .lean();

    const ids = bookings.map((b) => b.bookingId);
    const attendanceRecords = await BdaAttendanceModel.find({
      bookingId: { $in: ids },
    }).lean();

    const attendanceByBooking = Object.fromEntries(
      attendanceRecords.map((a) => [
        a.bookingId,
        {
          status: a.status,
          source: a.source,
        },
      ])
    );

    const upcoming = [];
    const previous = [];

    for (const b of bookings) {
      const start = b.scheduledEventStartTime ? new Date(b.scheduledEventStartTime) : null;
      const dto = {
        bookingId: b.bookingId,
        clientName: b.clientName,
        clientEmail: b.clientEmail,
        scheduledStart: b.scheduledEventStartTime,
        scheduledEnd: b.scheduledEventEndTime,
        googleMeetUrl: b.googleMeetUrl,
        googleMeetCode: b.googleMeetCode,
        calendlyMeetLink: b.calendlyMeetLink,
        claimedBy: b.claimedBy ? { name: b.claimedBy.name, email: b.claimedBy.email } : null,
        attendance: attendanceByBooking[b.bookingId] || null,
      };
      if (start && start >= now) {
        upcoming.push(dto);
      } else {
        previous.push(dto);
      }
    }

    previous.sort((a, b) => new Date(b.scheduledStart) - new Date(a.scheduledStart));

    return res.status(200).json({
      success: true,
      upcoming,
      previous,
      serverTime: now.toISOString(),
    });
  } catch (error) {
    console.error('[BdaAttendance] getMyMeetings error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

// ==================== POST /api/bda-attendance/report-join ====================

export async function reportJoin(req, res) {
  try {
    const { email, name } = req.bdaUser;
    const emailNorm = normalizeEmail(email);
    const { bookingId, meetLink, joinedAt } = req.body;

    if (!bookingId) {
      return res.status(400).json({ success: false, error: 'bookingId is required' });
    }

    const booking = await CampaignBookingModel.findOne({ bookingId }).lean();

    if (!booking) {
      return res.status(404).json({ success: false, error: 'Booking not found' });
    }

    // Any BDA can report for any meeting (claimedBy check removed)

    if (meetLink && !meetLink.includes('meet.google.com')) {
      return res.status(400).json({ success: false, error: 'Invalid meet link' });
    }

    if (meetLink && isGoogleMeetLandingUrl(meetLink)) {
      const notes = `Google Meet landing page (not a real meeting room). URL: ${String(meetLink).slice(0, 240)}`;
      const prev = await BdaAttendanceModel.findOne({ bookingId, bdaEmail: emailNorm });

      const attendance = await BdaAttendanceModel.findOneAndUpdate(
        { bookingId, bdaEmail: emailNorm },
        {
          $set: {
            bdaName: name,
            bdaEmail: emailNorm,
            bookingId,
            status: 'absent',
            source: 'manual',
            markedAt: new Date(),
            joinedAt: null,
            leftAt: null,
            meetLink,
            meetingScheduledStart: booking.scheduledEventStartTime,
            meetingScheduledEnd: booking.scheduledEventEndTime || null,
            notes,
            cumulativeDurationMs: 0,
            durationMs: null,
          },
          $setOnInsert: {
            attendanceId: `bda_att_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          },
        },
        { upsert: true, new: true }
      );

      const wasAlreadyAbsent = prev?.status === 'absent';
      if (!wasAlreadyAbsent) {
        const absentMsg =
          `❌ **BDA Absent** (Meet landing URL)\n` +
          `**BDA:** ${name} (${emailNorm})\n` +
          `**Client:** ${booking.clientName}\n` +
          `**Meeting:** ${formatIST(booking.scheduledEventStartTime)}\n` +
          `_Reason: Join attempted from meet.google.com/landing — not a real Meet room._`;
        await sendAbsentDiscord(absentMsg);
        await BdaAttendanceModel.updateOne({ _id: attendance._id }, { discordNotified: true });
      }

      notifyBdaSSE(emailNorm, 'attendance_update', {
        bookingId,
        status: 'absent',
        source: 'manual',
      });

      return res.status(200).json({
        success: true,
        markedAbsent: true,
        attendanceId: attendance.attendanceId,
        message: 'Meet landing URL does not count as joined; marked absent.',
      });
    }

    const joinDate = joinedAt ? new Date(joinedAt) : new Date();
    let doc = await BdaAttendanceModel.findOne({ bookingId, bdaEmail: emailNorm });
    let notifyJoin = false;

    if (!doc) {
      notifyJoin = true;
      doc = new BdaAttendanceModel({
        attendanceId: `bda_att_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        bdaName: name,
        bdaEmail: emailNorm,
        bookingId,
        meetLink: meetLink || null,
        joinedAt: joinDate,
        leftAt: null,
        status: 'present',
        source: 'auto',
        markedAt: new Date(),
        meetingScheduledStart: booking.scheduledEventStartTime,
        meetingScheduledEnd: booking.scheduledEventEndTime || null,
      });
    } else {
      const openSession = Boolean(doc.joinedAt && !doc.leftAt);
      if (!openSession) {
        doc.joinedAt = joinDate;
        doc.leftAt = null;
        notifyJoin = true;
      }
      doc.bdaName = name;
      doc.bdaEmail = emailNorm;
      doc.meetLink = meetLink || doc.meetLink;
      doc.status = 'present';
      doc.source = 'auto';
      doc.markedAt = new Date();
      doc.meetingScheduledStart = booking.scheduledEventStartTime;
      doc.meetingScheduledEnd = booking.scheduledEventEndTime || null;
    }

    await doc.save();

    if (notifyJoin) {
      const message =
        `✅ **BDA Joined Meeting**\n` +
        `**BDA:** ${name} (${emailNorm})\n` +
        `**Client:** ${booking.clientName}\n` +
        `**Meeting:** ${formatIST(booking.scheduledEventStartTime)}\n` +
        `**Meet Link:** ${meetLink || 'N/A'}\n` +
        `**Joined At:** ${formatIST(joinDate)}`;

      await sendPresentDiscord(message);
      await BdaAttendanceModel.updateOne({ _id: doc._id }, { discordNotified: true });
    }

    notifyBdaSSE(emailNorm, 'attendance_update', {
      bookingId,
      status: 'present',
      source: 'auto',
      joinedAt: doc.joinedAt,
    });

    return res.status(200).json({
      success: true,
      attendanceId: doc.attendanceId,
    });
  } catch (error) {
    console.error('[BdaAttendance] reportJoin error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

// ==================== POST /api/bda-attendance/report-leave ====================

export async function reportLeave(req, res) {
  try {
    const { email, name } = req.bdaUser;
    const emailNorm = normalizeEmail(email);
    const { bookingId, leftAt } = req.body;

    if (!bookingId) {
      return res.status(400).json({ success: false, error: 'bookingId is required' });
    }

    const booking = await CampaignBookingModel.findOne({ bookingId }).lean();
    if (!booking) {
      return res.status(404).json({ success: false, error: 'Booking not found' });
    }

    const result = await closeBdaAttendanceSession({
      bookingId,
      bdaEmail: emailNorm,
      bdaName: name,
      leftAt,
      sendDurationNotification: true,
    });

    return res.status(200).json({ success: true, durationMs: result.durationMs });
  } catch (error) {
    console.error('[BdaAttendance] reportLeave error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

// ==================== POST /api/bda-attendance/report-end-event ====================

export async function reportEndEvent(req, res) {
  try {
    const { email, name } = req.bdaUser;
    const emailNorm = normalizeEmail(email);
    const {
      bookingId,
      meetLink,
      leftAt,
      endSource,
      requestId,
      joinedAtSnapshot,
      durationMsSnapshot,
    } = req.body;

    const out = await processReportEndEventCore({
      emailNorm,
      name,
      bookingId,
      meetLink,
      leftAt,
      endSource,
      requestId,
      joinedAtSnapshot,
      durationMsSnapshot,
    });

    if (!out.ok) {
      return res.status(out.status).json(out.body);
    }
    return res.status(200).json(out.body);
  } catch (error) {
    console.error('[BdaAttendance] reportEndEvent error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

// ==================== POST /api/bda-attendance/manual-mark ====================

export async function manualMark(req, res) {
  try {
    const { email, name } = req.bdaUser;
    const emailNorm = normalizeEmail(email);
    const { bookingId, meetLink } = req.body;

    if (!bookingId) {
      return res.status(400).json({ success: false, error: 'bookingId is required' });
    }

    const booking = await CampaignBookingModel.findOne({ bookingId }).lean();

    if (!booking) {
      return res.status(404).json({ success: false, error: 'Booking not found' });
    }

    // Any BDA can report for any meeting (claimedBy check removed)

    if (meetLink && isGoogleMeetLandingUrl(meetLink)) {
      return res.status(400).json({
        success: false,
        error: 'Cannot mark present from the Google Meet landing page. Open the real meeting link first.',
      });
    }

    const now = new Date();
    const meetStart = new Date(booking.scheduledEventStartTime);

    // Strict: only after meeting start time
    if (now < meetStart) {
      return res.status(400).json({
        success: false,
        error: 'Cannot mark attendance before meeting start time',
      });
    }

    // Strict: within 2 hours of meeting start
    const twoHoursAfter = new Date(meetStart.getTime() + 2 * 60 * 60 * 1000);
    if (now > twoHoursAfter) {
      return res.status(400).json({
        success: false,
        error: 'Cannot mark attendance more than 2 hours after meeting start',
      });
    }

    // Check if already present via auto
    const existing = await BdaAttendanceModel.findOne({
      bookingId,
      bdaEmail: emailNorm,
      status: 'present',
      source: 'auto',
    });

    if (existing) {
      return res.status(400).json({
        success: false,
        error: 'Attendance already recorded automatically',
      });
    }

    // Upsert
    const attendance = await BdaAttendanceModel.findOneAndUpdate(
      { bookingId, bdaEmail: emailNorm },
      {
        $set: {
          bdaName: name,
          bdaEmail: emailNorm,
          bookingId,
          status: 'manual',
          source: 'manual',
          markedAt: now,
          meetLink: meetLink || booking.googleMeetUrl || null,
          meetingScheduledStart: booking.scheduledEventStartTime,
          meetingScheduledEnd: booking.scheduledEventEndTime || null,
        },
        $setOnInsert: {
          attendanceId: `bda_att_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        },
      },
      { upsert: true, new: true }
    );

    // Discord notification
    const resolvedMeetLink = meetLink || booking.googleMeetUrl || 'N/A';
    const message =
      `✋ **BDA Manual Attendance**\n` +
      `**BDA:** ${name} (${emailNorm})\n` +
      `**Client:** ${booking.clientName}\n` +
      `**Meeting:** ${formatIST(booking.scheduledEventStartTime)}\n` +
      `**Meet Link:** ${resolvedMeetLink}\n` +
      `_Note: Auto-detection did not trigger; BDA manually confirmed attendance._`;

    await sendPresentDiscord(message);
    await BdaAttendanceModel.updateOne(
      { _id: attendance._id },
      { discordNotified: true }
    );

    // Notify SSE
    notifyBdaSSE(emailNorm, 'attendance_update', {
      bookingId,
      status: 'manual',
      source: 'manual',
      markedAt: now,
    });

    return res.status(200).json({
      success: true,
      attendanceId: attendance.attendanceId,
    });
  } catch (error) {
    console.error('[BdaAttendance] manualMark error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

// ==================== POST /api/bda-attendance/mark-absent ====================

export async function markAbsent(req, res) {
  try {
    const { email, name } = req.bdaUser;
    const emailNorm = normalizeEmail(email);
    const { bookingId, reason } = req.body;

    if (!bookingId) {
      return res.status(400).json({ success: false, error: 'bookingId is required' });
    }

    const booking = await CampaignBookingModel.findOne({ bookingId }).lean();

    if (!booking) {
      return res.status(404).json({ success: false, error: 'Booking not found' });
    }

    // Any BDA can report for any meeting (claimedBy check removed)

    // Don't overwrite any existing attendance record (present, manual, or already absent)
    const existing = await BdaAttendanceModel.findOne({
      bookingId,
      bdaEmail: emailNorm,
    });

    if (existing) {
      // Already has a record - return success (idempotent) but don't re-notify
      return res.status(200).json({
        success: true,
        message: existing.status === 'absent' ? 'Already marked absent' : 'Attendance already recorded',
      });
    }

    const attendance = await BdaAttendanceModel.create({
      attendanceId: `bda_att_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      bdaName: name,
      bdaEmail: emailNorm,
      bookingId,
      status: 'absent',
      source: 'manual',
      markedAt: new Date(),
      meetingScheduledStart: booking.scheduledEventStartTime,
      meetingScheduledEnd: booking.scheduledEventEndTime || null,
      notes: reason || 'No response to popup',
      discordNotified: true,
    });

    const message =
      `❌ **BDA Absent**\n` +
      `**BDA:** ${name} (${emailNorm})\n` +
      `**Client:** ${booking.clientName}\n` +
      `**Meeting:** ${formatIST(booking.scheduledEventStartTime)}\n` +
      `_Reason: ${reason || 'No response after 5min popup'}_`;

    await sendAbsentDiscord(message);

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('[BdaAttendance] markAbsent error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

// ==================== POST /api/bda-attendance/warn-absent ====================

const WARN_DISCORD_LINE = '';

export async function warnAbsent(req, res) {
  try {
    const { email } = req.bdaUser;
    const emailNorm = normalizeEmail(email);
    const { bookingId } = req.body;

    if (!bookingId) {
      return res.status(400).json({ success: false, error: 'bookingId is required' });
    }

    const booking = await CampaignBookingModel.findOne({ bookingId }).lean();

    if (!booking) {
      return res.status(404).json({ success: false, error: 'Booking not found' });
    }

    // Any BDA can report for any meeting (claimedBy check removed)

    const existing = await BdaAttendanceModel.findOne({
      bookingId,
      bdaEmail: emailNorm,
      status: { $in: ['present', 'manual'] },
    });

    if (existing) {
      return res.status(200).json({ success: true, skipped: true, message: 'Already in meeting' });
    }

    const webhookUrl =
      process.env.BDA_ATTENDANCE_WARN_WEBHOOK_URL ||
      process.env.DISCORD_BDA_ATTENDANCE_WEBHOOK_URL ||
      process.env.DISCORD_MEET_WEB_HOOK_URL;

    try {
      await BdaAttendanceWarnDedupeModel.create({
        bookingId,
        bdaEmail: emailNorm,
        sentAt: new Date(),
      });
    } catch (err) {
      if (err.code === 11000) {
        return res.status(200).json({ success: true, skipped: true, reason: 'already_warned' });
      }
      throw err;
    }

    if (!webhookUrl) {
      console.warn('[BdaAttendance] warn-absent: no Discord webhook configured');
      await BdaAttendanceWarnDedupeModel.deleteOne({ bookingId, bdaEmail: emailNorm }).catch(() => {});
      return res.status(200).json({ success: true, skipped: true, reason: 'no_webhook' });
    }

    // try {
    //   const response = await fetch(webhookUrl, {
    //     method: 'POST',
    //     headers: { 'Content-Type': 'application/json' },
    //     body: JSON.stringify({ content: WARN_DISCORD_LINE }),
    //   });
    //   if (!response.ok) {
    //     await BdaAttendanceWarnDedupeModel.deleteOne({ bookingId, bdaEmail: emailNorm }).catch(() => {});
    //     return res.status(502).json({ success: false, error: 'Discord delivery failed' });
    //   }
    // } catch (err) {
    //   await BdaAttendanceWarnDedupeModel.deleteOne({ bookingId, bdaEmail: emailNorm }).catch(() => {});
    //   return res.status(502).json({ success: false, error: 'Discord delivery failed' });
    // }

    notifyBdaSSE(emailNorm, 'attendance_update', { bookingId });

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('[BdaAttendance] warnAbsent error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

// ==================== GET /api/bda-attendance/sse ====================

export async function sseConnection(req, res) {
  try {
    const token = req.query.token;
    if (!token) {
      return res.status(401).json({ success: false, error: 'Token required' });
    }

    let payload;
    try {
      payload = jwt.verify(token, getCrmJwtSecret());
    } catch (err) {
      return res.status(401).json({ success: false, error: 'Invalid or expired token' });
    }

    if (payload?.role !== 'bda_extension') {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }

    const email = payload.email;

    // Set up SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.flushHeaders();

    // Initial keepalive to confirm connection (some clients need an initial push)
    res.write(':ok\n\n');

    // Register connection
    if (!sseConnections.has(email)) {
      sseConnections.set(email, new Set());
    }
    sseConnections.get(email).add(res);

    // Send connected event
    res.write(`event: connected\ndata: ${JSON.stringify({ email, serverTime: new Date().toISOString() })}\n\n`);

    // Heartbeat every 30s
    const heartbeatInterval = setInterval(() => {
      try {
        res.write(`event: heartbeat\ndata: ${JSON.stringify({ serverTime: new Date().toISOString() })}\n\n`);
      } catch (err) {
        clearInterval(heartbeatInterval);
      }
    }, 30000);

    // Cleanup on close
    req.on('close', () => {
      clearInterval(heartbeatInterval);
      const connections = sseConnections.get(email);
      if (connections) {
        connections.delete(res);
        if (connections.size === 0) {
          sseConnections.delete(email);
        }
      }
    });
  } catch (error) {
    console.error('[BdaAttendance] SSE error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

// ==================== POST /api/bda-attendance/beacon-leave ====================
// Fire-and-forget endpoint for navigator.sendBeacon (no auth header — token in body)

export async function beaconLeave(req, res) {
  try {
    const {
      bookingId,
      leftAt,
      token: bodyToken,
      endRequestId,
      endMeetLink,
      endSource,
      joinedAtSnapshot,
      durationMsSnapshot,
    } = req.body;

    if (!bookingId || !bodyToken) {
      return res.status(200).json({ success: false, error: 'Missing required fields' });
    }

    let payload;
    try {
      payload = jwt.verify(bodyToken, getCrmJwtSecret());
    } catch {
      return res.status(200).json({ success: false, error: 'Invalid token' });
    }

    if (payload?.role !== 'bda_extension') {
      return res.status(200).json({ success: false, error: 'Forbidden' });
    }

    const emailNorm = normalizeEmail(payload.email);
    const name = payload.name || emailNorm;

    const closeResult = await closeBdaAttendanceSession({
      bookingId,
      bdaEmail: emailNorm,
      bdaName: name,
      leftAt,
      sendDurationNotification: true,
    });

    if (!closeResult.closed) {
      return res.status(200).json({ success: true, message: 'No open session' });
    }

    if (
      endRequestId &&
      endSource &&
      END_SOURCES.includes(String(endSource))
    ) {
      const existing = await BdaAttendanceEndEventModel.findOne({
        bdaEmail: emailNorm,
        requestId: String(endRequestId),
      });
      if (!existing) {
        const booking = await CampaignBookingModel.findOne({ bookingId }).lean();
        const meetLink = endMeetLink || null;
        let linkMismatch = false;
        if (booking && meetLink) {
          linkMismatch = meetLinksRoughMatch(booking, meetLink).mismatch;
        }
        await persistEndEventAndMetadata({
          emailNorm,
          name,
          bookingId,
          meetLink,
          meetCode: extractMeetCodeFromUrl(meetLink),
          endedAt: closeResult.leaveTime,
          endSource: String(endSource),
          requestId: String(endRequestId),
          joinedAtSnapshot,
          durationMsSnapshot,
          linkMismatch,
          unresolvedBooking: false,
          sessionClosed: true,
          durationMsAfterClose: closeResult.durationMs,
        });
      }
    }

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('[BdaAttendance] beaconLeave error:', error);
    return res.status(200).json({ success: true });
  }
}

// ==================== POST /api/bda-attendance/beacon-end-event ====================
// sendBeacon when bookingId may be unknown — token in body; resolves booking via meet link

export async function beaconReportEndEvent(req, res) {
  try {
    const {
      token: bodyToken,
      meetLink,
      leftAt,
      endSource,
      requestId,
      joinedAtSnapshot,
      durationMsSnapshot,
    } = req.body;

    if (!bodyToken || !requestId) {
      return res.status(200).json({ success: false, error: 'Missing required fields' });
    }

    let payload;
    try {
      payload = jwt.verify(bodyToken, getCrmJwtSecret());
    } catch {
      return res.status(200).json({ success: false, error: 'Invalid token' });
    }

    if (payload?.role !== 'bda_extension') {
      return res.status(200).json({ success: false, error: 'Forbidden' });
    }

    const emailNorm = normalizeEmail(payload.email);
    const name = payload.name || emailNorm;

    const out = await processReportEndEventCore({
      emailNorm,
      name,
      bookingId: undefined,
      meetLink,
      leftAt,
      endSource,
      requestId,
      joinedAtSnapshot,
      durationMsSnapshot,
    });

    return res.status(200).json(out.ok ? out.body : { success: false, ...out.body });
  } catch (error) {
    console.error('[BdaAttendance] beaconReportEndEvent error:', error);
    return res.status(200).json({ success: true });
  }
}

// ==================== GET /api/bda-attendance/by-booking/:bookingId ====================

export async function getAttendanceByBooking(req, res) {
  try {
    const { bookingId } = req.params;

    const attendance = await BdaAttendanceModel.findOne({ bookingId }).lean();

    return res.status(200).json({
      success: true,
      attendance: attendance
        ? {
            status: attendance.status,
            source: attendance.source,
            bdaName: attendance.bdaName,
            bdaEmail: attendance.bdaEmail,
            joinedAt: attendance.joinedAt,
            leftAt: attendance.leftAt,
            markedAt: attendance.markedAt,
            meetLink: attendance.meetLink,
          }
        : null,
    });
  } catch (error) {
    console.error('[BdaAttendance] getAttendanceByBooking error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

// ==================== GET /api/bda-attendance/bulk ====================

export async function getAttendanceBulk(req, res) {
  try {
    const bookingIdsParam = req.query.bookingIds;
    if (!bookingIdsParam) {
      return res.status(400).json({ success: false, error: 'bookingIds query param required' });
    }

    const bookingIds = bookingIdsParam.split(',').filter(Boolean).slice(0, 100);

    const records = await BdaAttendanceModel.find({
      bookingId: { $in: bookingIds },
    }).lean();

    const attendanceMap = {};
    for (const att of records) {
      attendanceMap[att.bookingId] = {
        status: att.status,
        source: att.source,
        bdaName: att.bdaName,
        bdaEmail: att.bdaEmail,
        joinedAt: att.joinedAt,
        leftAt: att.leftAt,
        markedAt: att.markedAt,
      };
    }

    // Fill nulls for missing
    for (const id of bookingIds) {
      if (!attendanceMap[id]) {
        attendanceMap[id] = null;
      }
    }

    return res.status(200).json({ success: true, attendanceMap });
  } catch (error) {
    console.error('[BdaAttendance] getAttendanceBulk error:', error);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}
