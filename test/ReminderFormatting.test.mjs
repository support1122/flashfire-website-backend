import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { headlineForSendTime } from '../Utils/DiscordMeetReminderScheduler.js';
import { resolveUnknownWhatsAppMeetingDisplay } from '../Utils/WhatsAppReminderScheduler.js';

describe('headlineForSendTime', () => {
  it('returns safe default for null and invalid Date', () => {
    assert.match(headlineForSendTime(null), /Meeting reminder/);
    assert.match(headlineForSendTime(new Date(NaN)), /Meeting reminder/);
    assert.match(headlineForSendTime(undefined), /Meeting reminder/);
  });

  it('returns countdown-style headline for valid future start', () => {
    const future = new Date(Date.now() + 10 * 60 * 1000);
    const h = headlineForSendTime(future);
    assert.match(h, /minutes/i);
  });
});

describe('resolveUnknownWhatsAppMeetingDisplay', () => {
  it('prefers meetingStartISO and metadata.inviteeTimezone', () => {
    const d = resolveUnknownWhatsAppMeetingDisplay({
      meetingStartISO: '2026-06-15T17:00:00.000Z',
      metadata: { inviteeTimezone: 'America/New_York' },
    });
    assert.ok(d.resolvedMeetingTime.includes('–'));
    assert.ok(d.resolvedTimezone.length > 0);
  });

  it('uses metadata.reminderOffsetMinutes when ISO is unusable', () => {
    const scheduledFor = new Date('2026-06-15T16:55:00.000Z');
    const d = resolveUnknownWhatsAppMeetingDisplay({
      meetingStartISO: '',
      scheduledFor,
      metadata: { reminderOffsetMinutes: 5, inviteeTimezone: 'UTC' },
    });
    assert.ok(d.resolvedMeetingTime.length > 0);
  });

  it('uses metadata.reminderType offset when reminderOffsetMinutes absent', () => {
    const meetingStart = new Date('2026-06-15T17:00:00.000Z');
    const scheduledFor = new Date(meetingStart.getTime() - 3 * 60 * 60 * 1000);
    const d = resolveUnknownWhatsAppMeetingDisplay({
      meetingStartISO: '',
      scheduledFor,
      metadata: { reminderType: '3h', inviteeTimezone: 'UTC' },
    });
    assert.ok(d.resolvedMeetingTime.length > 0);
  });
});
