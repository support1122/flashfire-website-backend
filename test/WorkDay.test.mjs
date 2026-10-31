import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_WORK_DAY_START_HOUR, isLeaveDayFor, workDayBounds, workDayOf, workDayStartHour, workMonthOf } from '../Utils/WorkDay.js';

const ist = (s) => new Date(`${s}+05:30`).getTime();

describe('work day', () => {
  it('defaults the boundary to 08:00 IST and honours a profile override', () => {
    assert.equal(DEFAULT_WORK_DAY_START_HOUR, 8);
    assert.equal(workDayStartHour(null), 8);
    assert.equal(workDayStartHour({ workDayStartHour: 14 }), 14);
    assert.equal(workDayStartHour({ workDayStartHour: 0 }), 0);
    assert.equal(workDayStartHour({ workDayStartHour: 30 }), 8, 'out of range falls back');
    assert.equal(workDayStartHour({ workDayStartHour: 7.5 }), 8, 'a fractional hour falls back');
  });

  it('puts a night shift on the day it began, not the calendar day it ends on', () => {
    // Kalpataru-style shift: 16:00 IST on the 29th to 06:30 IST on the 30th is one working day, the 29th.
    assert.equal(workDayOf(ist('2026-10-29T16:00:00')), '2026-10-29');
    assert.equal(workDayOf(ist('2026-10-29T23:30:00')), '2026-10-29');
    assert.equal(workDayOf(ist('2026-10-30T00:30:00')), '2026-10-29');
    assert.equal(workDayOf(ist('2026-10-30T06:30:00')), '2026-10-29');
    assert.equal(workDayOf(ist('2026-10-30T07:59:00')), '2026-10-29');
    assert.equal(workDayOf(ist('2026-10-30T08:00:00')), '2026-10-30', 'the boundary instant starts the next day');
    assert.equal(workDayOf(ist('2026-10-30T15:00:00')), '2026-10-30');
  });

  it('counts a shift that crosses a month end in the month it began', () => {
    assert.equal(workMonthOf(ist('2026-11-01T01:00:00')), '2026-10');
    assert.equal(workMonthOf(ist('2026-11-01T07:59:00')), '2026-10');
    assert.equal(workMonthOf(ist('2026-11-01T16:00:00')), '2026-11');
    assert.equal(workDayOf(ist('2027-01-01T02:00:00')), '2026-12-31', 'and across a year end');
  });

  it('uses the per-BDA hour when one is set', () => {
    const early = { workDayStartHour: 2 };
    assert.equal(workDayOf(ist('2026-10-30T01:00:00'), early), '2026-10-29');
    assert.equal(workDayOf(ist('2026-10-30T03:00:00'), early), '2026-10-30');
    assert.equal(workDayOf(ist('2026-10-30T03:00:00'), 2), '2026-10-30', 'an hour number works too');
  });

  it('gives the instants a working day covers', () => {
    const b = workDayBounds('2026-10-29');
    assert.equal(b.start.toISOString(), new Date(ist('2026-10-29T08:00:00')).toISOString());
    assert.equal(b.end.toISOString(), new Date(ist('2026-10-30T08:00:00')).toISOString());
    assert.equal(workDayBounds('nope'), null);
    assert.equal(workDayBounds('2026-02-31'), null);
  });

  it('treats the whole shift as leave when its day is a leave day', () => {
    const profile = { leaveDays: ['2026-10-29'] };
    assert.equal(isLeaveDayFor(profile, ist('2026-10-29T17:00:00')), true);
    assert.equal(isLeaveDayFor(profile, ist('2026-10-30T02:00:00')), true, 'the after-midnight part of the shift');
    assert.equal(isLeaveDayFor(profile, ist('2026-10-30T16:00:00')), false, 'the next shift');
    assert.equal(isLeaveDayFor(profile, ist('2026-10-29T07:00:00')), false, 'the previous shift ending that morning');
    assert.equal(isLeaveDayFor({}, ist('2026-10-29T17:00:00')), false);
  });
});
