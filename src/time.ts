import { InputError } from './errors.js';

const ISO = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?$/;
const DMY = /^(\d{1,2})\/(\d{1,2})\/(\d{4})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?$/;

/**
 * Parses a local wall-clock timestamp ("2026-01-31 23:30", "2026-01-31T23:30:00" or "31/01/2026 23:30",
 * day first) into minutes since 1970-01-01 00:00 of that wall clock. Malaysia has no daylight saving, so the
 * wall clock is used as is. Time zone suffixes are refused so a UTC export is not silently shifted by 8 hours.
 * "24:00" is accepted as midnight at the end of that day.
 */
export function parseTimestamp(raw: string, where: string): number {
  const text = raw.trim();
  let m = ISO.exec(text);
  let y: number, mo: number, d: number;
  if (m) {
    [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  } else {
    m = DMY.exec(text);
    if (!m) {
      throw new InputError(
        `${where}: timestamp "${raw}" is not "YYYY-MM-DD HH:MM[:SS]" or "DD/MM/YYYY HH:MM[:SS]" (local time, no zone).`,
      );
    }
    [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  }
  const h = Number(m[4]);
  const mi = Number(m[5]);
  const s = m[6] === undefined ? 0 : Number(m[6]);
  const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const midnight24 = h === 24 && mi === 0 && s === 0;
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth || (h > 23 && !midnight24) || mi > 59 || s > 59) {
    throw new InputError(`${where}: timestamp "${raw}" is not a valid date/time.`);
  }
  if (s !== 0) {
    throw new InputError(`${where}: timestamp "${raw}" has seconds; interval data must be on whole minutes.`);
  }
  return Date.UTC(y, mo - 1, d, h, mi) / 60_000;
}

/** "YYYY-MM" of the wall-clock minute. */
export function monthKey(minutes: number): string {
  const date = new Date(minutes * 60_000);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function formatMinutes(minutes: number): string {
  return new Date(minutes * 60_000).toISOString().slice(0, 16).replace('T', ' ');
}

/** Number of minutes in the calendar month "YYYY-MM". */
export function minutesInMonth(key: string): number {
  const [y, m] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate() * 1440;
}
