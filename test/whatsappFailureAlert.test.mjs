import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  formatWhatsAppFailureReport,
  findSentMessage,
  verifyFailuresWithWati,
  dedupeFailures
} from '../Utils/WhatsAppFailureAlert.js';

const until = new Date('2026-10-01T03:30:00Z'); // 09:00 IST
const since = new Date(until.getTime() - 12 * 60 * 60 * 1000);

function failure(overrides = {}) {
  const at = overrides.at || new Date('2026-09-30T15:59:38Z'); // 21:29 IST
  return {
    source: 'workflow',
    at,
    phone: '+447428100073',
    name: 'Test Client',
    label: 'workflow_x · meta_1',
    error: 'API usage limit exceeded',
    templates: ['meta_1'],
    matchFrom: new Date(at.getTime() - 2 * 60 * 1000),
    matchTo: new Date(at.getTime() + 30 * 60 * 1000),
    ...overrides
  };
}

function watiItem(template, created, statusString = 'SENT') {
  return {
    eventType: 'broadcastMessage',
    eventDescription: `Broadcast message with using "${template}" template was received 30|09|2026`,
    created,
    statusString
  };
}

describe('findSentMessage', () => {
  const f = failure();

  it('matches the same template inside the window', () => {
    const hit = findSentMessage(f, [watiItem('meta_1', '2026-09-30T16:00:28.475Z')]);
    assert.equal(hit.status, 'SENT');
    assert.equal(hit.at.toISOString(), '2026-09-30T16:00:28.475Z');
  });

  it('ignores other templates, failed messages and sends outside the window', () => {
    assert.equal(findSentMessage(f, [watiItem('meta_2', '2026-09-30T16:00:28Z')]), null);
    assert.equal(findSentMessage(f, [watiItem('meta_1', '2026-09-30T16:00:28Z', 'FAILED')]), null);
    assert.equal(findSentMessage(f, [watiItem('meta_1', '2026-10-01T00:00:03Z')]), null);
    assert.equal(findSentMessage(f, [{ eventType: 'text', created: '2026-09-30T16:00:28Z' }]), null);
  });
});

describe('verifyFailuresWithWati', () => {
  it('looks up each phone once and marks sent / not sent / unchecked', async () => {
    const calls = [];
    const fetchMessages = async (digits) => {
      calls.push(digits);
      if (digits === '15550000000') return { success: false, error: 'boom' };
      return { success: true, items: [watiItem('meta_1', '2026-09-30T16:00:28Z')] };
    };
    const failures = [
      failure(),
      failure({ label: 'workflow_x · meta_1 again' }),
      failure({ phone: '+919999999999', templates: ['meta_9'] }),
      failure({ phone: '+15550000000' }),
      failure({ phone: null })
    ];
    await verifyFailuresWithWati(failures, { fetchMessages, gapMs: 0 });
    assert.deepEqual(calls, ['447428100073', '919999999999', '15550000000']);
    assert.ok(failures[0].wati.sent);
    assert.ok(failures[1].wati.sent);
    assert.deepEqual(failures[2].wati, { checked: true, sent: null });
    assert.equal(failures[3].wati.checked, false);
    assert.match(failures[3].wati.reason, /boom/);
    assert.equal(failures[4].wati.reason, 'no phone');
  });
});

describe('dedupeFailures', () => {
  it('collapses the double-logged row for one send', () => {
    const a = failure();
    const b = failure({ at: new Date(a.at.getTime() + 15000) });
    const later = failure({ at: new Date(a.at.getTime() + 10 * 60 * 1000) });
    assert.equal(dedupeFailures([a, b, later]).length, 2);
  });
});

describe('formatWhatsAppFailureReport', () => {
  it('reports an all-clear with the IST window when nothing failed', () => {
    const msg = formatWhatsAppFailureReport([], since, until);
    assert.match(msg, /no failed messages/);
    assert.match(msg, /30 Sep 21:00 - 01 Oct 09:00 IST/);
  });

  it('says nothing to do when WATI sent every errored message, with the send time', () => {
    const f = failure({ error: 'timeout of 15000ms exceeded' });
    f.wati = { checked: true, sent: { at: new Date('2026-09-30T16:00:28.475Z'), status: 'SENT', template: 'meta_1' } };
    const msg = formatWhatsAppFailureReport([f], since, until);
    assert.match(msg, /^✅ .*1 send error\(s\) logged, but WATI confirms every message went out\. Nothing to do\./);
    assert.match(msg, /Sent anyway, confirmed in WATI \(1\)/);
    assert.match(msg, /logged "timeout of 15000ms exceeded" at 30 Sep 21:29 → sent 30 Sep 21:30:28 IST \(SENT\)/);
    assert.doesNotMatch(msg, /Not sent/);
  });

  it('splits not-sent from sent-anyway and counts only real failures', () => {
    const sent = failure({ error: 'timeout of 15000ms exceeded' });
    sent.wati = { checked: true, sent: { at: new Date('2026-09-30T16:00:28Z'), status: 'DELIVERED', template: 'meta_1' } };
    const lost = [failure(), failure({ source: 'reminder', label: 'meeting reminder (5min)' }), failure({ source: 'campaign', name: null, error: 'Invalid WhatsApp number' })];
    lost[0].wati = { checked: true, sent: null };
    lost[1].wati = { checked: true, sent: null };
    lost[2].wati = { checked: false, reason: 'WATI lookup failed: boom' };
    const msg = formatWhatsAppFailureReport([sent, ...lost], since, until);
    assert.match(msg, /^⚠️ \*\*WhatsApp: 3 message\(s\) NOT sent \(last 12h\)\*\* · 1 more logged an error but WATI sent them anyway/);
    assert.match(msg, /Workflow messages: 1\n• Meeting reminders: 1\n• Campaign messages: 1/);
    assert.match(msg, /Could not verify in WATI: 1 \(counted as not sent\)/);
    assert.match(msg, /2 of 3 were WATI rate\/usage-limit rejections/);
    assert.match(msg, /• 2× API usage limit exceeded\n• 1× Invalid WhatsApp number/);
    assert.match(msg, /❌ Not sent \(3\)/);
    assert.match(msg, /not in WATI/);
    assert.match(msg, /→ sent 30 Sep 21:30:28 IST \(DELIVERED\)/);
  });

  it('stays under the Discord 2000-char limit for large batches', () => {
    const failures = Array.from({ length: 500 }, (_, i) => {
      const f = failure({ error: `Distinct error number ${i} `.repeat(20), label: 'x'.repeat(200) });
      f.wati = i % 2 ? { checked: true, sent: null } : { checked: true, sent: { at: new Date(), status: 'SENT', template: 'meta_1' } };
      return f;
    });
    const msg = formatWhatsAppFailureReport(failures, since, until);
    assert.ok(msg.length < 2000, `message is ${msg.length} chars`);
    assert.match(msg, /Top errors/);
    assert.match(msg, /…and \d+ more/);
  });
});
