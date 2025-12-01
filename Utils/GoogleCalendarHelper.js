import { google } from 'googleapis';
import { Logger } from './Logger.js';

function getJwtClient() {
  const clientEmail = process.env.GOOGLE_CLIENT_EMAIL;
  let privateKey = process.env.GOOGLE_PRIVATE_KEY;
  if (!clientEmail || !privateKey) {
    return null;
  }
  // Replace escaped newlines if present
  privateKey = privateKey.replace(/\\n/g, '\n');
  return new google.auth.JWT(
    clientEmail,
    null,
    privateKey,
    ['https://www.googleapis.com/auth/calendar.readonly']
  );
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


