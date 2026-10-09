// Pure tests (no database): the phone key that links a call to a booking, and the no-show fine that depends on it.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { bookingPhoneKey, normalizeLeadPhone } from '../Utils/CallLinking.js';

describe('normalizeLeadPhone', () => {
  it('gives the same 10 digit key for every common way of writing a number', () => {
    for (const raw of ['+1 415 555 0100', '4155550100', '(415) 555-0100', '1-415-555-0100', '+14155550100']) {
      assert.equal(normalizeLeadPhone(raw), '4155550100', raw);
    }
    assert.equal(normalizeLeadPhone('+91 98765 43210'), '9876543210');
  });

  it('drops an extension instead of corrupting the key', () => {
    for (const raw of ['+1 415 555 0100 x123', '415-555-0100 ext. 22', '415 555 0100 ext 7', '4155550100 #5', '4155550100 extension 12']) {
      assert.equal(normalizeLeadPhone(raw), '4155550100', raw);
    }
  });

  it('returns null for anything that cannot be a callable number', () => {
    for (const raw of [null, undefined, '', 'N/A', '---', '12345', 'call me', '12345678']) {
      assert.equal(normalizeLeadPhone(raw), null, String(raw));
    }
  });
});

describe('bookingPhoneKey', () => {
  it('trusts a stored key only when it is a real 10 digit key', () => {
    assert.equal(bookingPhoneKey({ normalizedClientPhone: '4155550100', clientPhone: 'ignored' }), '4155550100');
    // An older booking saved the corrupted key from an extension number: it is recomputed from the raw phone.
    assert.equal(bookingPhoneKey({ normalizedClientPhone: '550100x123', clientPhone: '+1 415 555 0100 x123' }), '4155550100');
  });

  it('falls back to clientPhone when no key was stored, and is null when neither works', () => {
    assert.equal(bookingPhoneKey({ clientPhone: '(415) 555-0100' }), '4155550100');
    assert.equal(bookingPhoneKey({ clientPhone: 'N/A' }), null);
    assert.equal(bookingPhoneKey({}), null);
    assert.equal(bookingPhoneKey(null), null);
  });
});
