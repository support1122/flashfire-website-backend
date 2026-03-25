import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMeetingStartToDate,
  normalizePhoneForReminders,
  buildCallId,
  buildWhatsAppReminderId,
  extractCalendlyPhoneFromPayload,
} from '../Utils/MeetingReminderUtils.js';

describe('MeetingReminderUtils', () => {
  it('parseMeetingStartToDate parses Zulu ISO', () => {
    const d = parseMeetingStartToDate('2026-03-24T17:00:00.000Z');
    assert.equal(d.getTime(), Date.parse('2026-03-24T17:00:00.000Z'));
  });

  it('normalizePhoneForReminders strips formatting', () => {
    assert.equal(normalizePhoneForReminders('+1 (660) 441-8159'), '+16604418159');
  });

  it('buildCallId and buildWhatsAppReminderId are stable', () => {
    const ms = 1710000000000;
    assert.equal(buildCallId('+15551234567', ms), 'call_+15551234567_1710000000000');
    assert.equal(
      buildWhatsAppReminderId('5min', '+15551234567', ms),
      'whatsapp_reminder_5min_+15551234567_1710000000000'
    );
  });

  it('extractCalendlyPhoneFromPayload prefers phone number question', () => {
    const p = {
      questions_and_answers: [{ question: 'Phone Number', answer: '+1 555 111 2222' }],
      invitee: { phone_number: '+19998887777' },
    };
    assert.equal(extractCalendlyPhoneFromPayload(p), '+15551112222');
  });
});
