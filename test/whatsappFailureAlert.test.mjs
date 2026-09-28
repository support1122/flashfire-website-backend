import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { formatWhatsAppFailureReport } from '../Utils/WhatsAppFailureAlert.js';

const until = new Date('2026-09-28T03:30:00Z'); // 09:00 IST
const since = new Date(until.getTime() - 12 * 60 * 60 * 1000);

function failure(overrides = {}) {
  return {
    source: 'workflow',
    at: new Date('2026-09-27T17:31:00Z'),
    phone: '+919876543210',
    name: 'Test Client',
    label: 'No-show follow up · meta_2',
    error: 'API usage limit exceeded',
    ...overrides
  };
}

describe('formatWhatsAppFailureReport', () => {
  it('reports an all-clear with the IST window when nothing failed', () => {
    const msg = formatWhatsAppFailureReport([], since, until);
    assert.match(msg, /no failed messages/);
    assert.match(msg, /27 Sep 21:00 - 28 Sep 09:00 IST/);
  });

  it('counts per source, flags rate limits and ranks errors', () => {
    const failures = [
      failure(),
      failure(),
      failure({ source: 'reminder', label: 'meeting reminder (5min)' }),
      failure({ source: 'campaign', name: null, error: 'Invalid WhatsApp number' })
    ];
    const msg = formatWhatsAppFailureReport(failures, since, until);
    assert.match(msg, /failures \(last 12h\): 4/);
    assert.match(msg, /Workflow messages: 2/);
    assert.match(msg, /Meeting reminders: 1/);
    assert.match(msg, /Campaign messages: 1/);
    assert.match(msg, /3 of 4 were WATI rate\/usage-limit rejections/);
    assert.match(msg, /• 3× API usage limit exceeded\n• 1× Invalid WhatsApp number/);
    assert.match(msg, /27 Sep 23:01 · Test Client \+919876543210/);
  });

  it('stays under the Discord 2000-char limit for large batches', () => {
    const failures = Array.from({ length: 500 }, (_, i) =>
      failure({ error: `Distinct error number ${i} `.repeat(20), label: 'x'.repeat(200) })
    );
    const msg = formatWhatsAppFailureReport(failures, since, until);
    assert.ok(msg.length < 2000, `message is ${msg.length} chars`);
    assert.match(msg, /…and \d+ more/);
    assert.match(msg, /Top errors/);
  });
});
