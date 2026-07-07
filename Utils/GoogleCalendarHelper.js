import fs from 'fs';
import { google } from 'googleapis';
import { Logger } from './Logger.js';

function getJwtClient() {
  let clientEmail = process.env.GOOGLE_CLIENT_EMAIL;
  let privateKey = process.env.GOOGLE_PRIVATE_KEY;

  // Preferred: whole JSON key in one env var, or a key file path
  // (same credential sources as MeetApiHelper).
  const inlineJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON;
  const keyFile = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE;
  if (inlineJson) {
    try {
      const parsed = JSON.parse(inlineJson);
      clientEmail = parsed.client_email;
      privateKey = parsed.private_key;
    } catch (e) {
      Logger.warn('GOOGLE_SERVICE_ACCOUNT_KEY_JSON is not valid JSON', { error: e?.message });
    }
  } else if (keyFile && fs.existsSync(keyFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
      clientEmail = parsed.client_email;
      privateKey = parsed.private_key;
    } catch (e) {
      Logger.warn('Failed to read GOOGLE_SERVICE_ACCOUNT_KEY_FILE', { error: e?.message });
    }
  }

  if (!clientEmail || !privateKey) {
    return null;
  }
  // Replace escaped newlines if present
  privateKey = privateKey.replace(/\\n/g, '\n');
  // NOTE: positional JWT args are broken in this google-auth-library version
  // ("No key or keyFile set") — always use the options object.
  return new google.auth.JWT({
    email: clientEmail,
    key: privateKey,
    scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
  });
}

export async function isEventPresent({ calendarId, eventStartISO, inviteeEmail, windowMinutes = 15 }) {
  try {
    const jwtClient = getJwtClient();
    if (!jwtClient) {
      Logger.warn('Google Calendar credentials not configured; skipping event check');
      return true; // do not block calls if not configured
    }

    const calendar = google.calendar({ version: 'v3', auth: jwtClient });
    const start = new Date(eventStartISO);
    if (Number.isNaN(start.getTime())) {
      Logger.warn('Invalid eventStartISO supplied to isEventPresent', { eventStartISO });
      return true;
    }

    const timeMin = new Date(start.getTime() - windowMinutes * 60 * 1000).toISOString();
    const timeMax = new Date(start.getTime() + windowMinutes * 60 * 1000).toISOString();

    const res = await calendar.events.list({
      calendarId,
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 10
    });

    const items = res?.data?.items || [];
    if (items.length === 0) {
      Logger.info('No calendar events found in window', { calendarId, timeMin, timeMax });
      return false;
    }

    const normalizedEmail = (inviteeEmail || '').trim().toLowerCase();
    const match = items.find(evt => {
      if (evt.status === 'cancelled') return false;
      const attendees = evt.attendees || [];
      if (!normalizedEmail) return true; // if no email to match, assume present
      return attendees.some(a => (a.email || '').trim().toLowerCase() === normalizedEmail);
    });

    return Boolean(match);
  } catch (err) {
    Logger.error('Google Calendar check failed', { error: err?.message });
    // Fail-open to avoid blocking legitimate calls if Google API fails
    return true;
  }
}


