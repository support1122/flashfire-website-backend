import { DateTime } from 'luxon';

// A BDA's working day is not the 00:00 to 24:00 IST calendar day. The team takes US-hours meetings, so a shift runs
// from late afternoon IST to early morning IST the next day (the meetings in October start between 15:00 and 06:30).
// A meeting at 01:00 IST on the 30th belongs to the shift that began on the 29th.
//
// The day boundary is an hour (IST) that falls in the quiet stretch between two shifts. It is 08:00 IST for everyone
// unless the BDA's profile sets workDayStartHour. Leave days, the monthly fine counter and the day shown in the CRM all
// use this day, so one shift is never split in two by midnight.

const IST_ZONE = 'Asia/Kolkata';
const HOUR_MS = 60 * 60 * 1000;
export const DEFAULT_WORK_DAY_START_HOUR = 8;

/** The boundary hour for a profile: its own workDayStartHour (0 to 23), else the default. */
export function workDayStartHour(profile) {
  const h = profile?.workDayStartHour;
  return Number.isInteger(h) && h >= 0 && h <= 23 ? h : DEFAULT_WORK_DAY_START_HOUR;
}

/** 'YYYY-MM-DD' of the work day an instant falls in: the IST date of (instant minus the boundary hour). */
export function workDayOf(when, profileOrHour = null) {
  const ms = when instanceof Date ? when.getTime() : typeof when === 'number' ? when : new Date(when).getTime();
  const hour = typeof profileOrHour === 'number' ? profileOrHour : workDayStartHour(profileOrHour);
  return DateTime.fromMillis(ms - hour * HOUR_MS, { zone: IST_ZONE }).toFormat('yyyy-LL-dd');
}

/** 'YYYY-MM' of the work day, the month key a fine is counted in. */
export function workMonthOf(when, profileOrHour = null) {
  return workDayOf(when, profileOrHour).slice(0, 7);
}

/** [start, end) instants of a work day ('YYYY-MM-DD'), or null for a malformed day. */
export function workDayBounds(day, profileOrHour = null) {
  const hour = typeof profileOrHour === 'number' ? profileOrHour : workDayStartHour(profileOrHour);
  const start = DateTime.fromFormat(String(day ?? ''), 'yyyy-LL-dd', { zone: IST_ZONE });
  if (!start.isValid) return null;
  const from = start.plus({ hours: hour });
  return { start: from.toJSDate(), end: from.plus({ days: 1 }).toJSDate() };
}

/** True when the work day of `when` is one of the profile's approved leave days. */
export function isLeaveDayFor(profile, when) {
  return (profile?.leaveDays || []).includes(workDayOf(when, profile));
}
