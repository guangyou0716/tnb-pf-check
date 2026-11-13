import { describe, expect, it } from 'vitest';
import { InputError } from '../src/errors.js';
import { parseCharges, parseIntervals } from '../src/input.js';
import { monthKey, parseTimestamp } from '../src/time.js';

describe('parseTimestamp', () => {
  it('reads ISO and day-first formats as wall clock', () => {
    const a = parseTimestamp('2026-01-31 23:30', 'x');
    expect(parseTimestamp('2026-01-31T23:30:00', 'x')).toBe(a);
    expect(parseTimestamp('31/01/2026 23:30', 'x')).toBe(a);
    expect(monthKey(a)).toBe('2026-01');
  });
  it('accepts 24:00 as the end of the day', () => {
    expect(parseTimestamp('2026-01-31 24:00', 'x')).toBe(parseTimestamp('2026-02-01 00:00', 'x'));
  });
  it('refuses zones, bad dates and seconds', () => {
    expect(() => parseTimestamp('2026-01-31T23:30Z', 'f:2')).toThrow(/f:2/);
    expect(() => parseTimestamp('2026-02-30 00:00', 'x')).toThrow(InputError);
    expect(() => parseTimestamp('2026-01-01 24:30', 'x')).toThrow(InputError);
    expect(() => parseTimestamp('2026-01-01 10:00:15', 'x')).toThrow(/seconds/);
  });
});

describe('parseIntervals', () => {
  it('finds columns by name (case-insensitive) and uses the meter column when present', () => {
    const rows = parseIntervals('Meter,Timestamp,KWH,kVArh\nA,2026-01-01 00:30,5,-1\n', 'f.csv');
    expect(rows).toEqual([{ meter: 'A', stamp: parseTimestamp('2026-01-01 00:30', 'x'), kwh: 5, kvarh: -1, where: 'f.csv:2' }]);
  });
  it('supports custom column names and no meter column', () => {
    const rows = parseIntervals('t,p,q\n2026-01-01 00:30,5,2\n', 'f.csv', { timeColumn: 't', kwhColumn: 'p', kvarhColumn: 'q' });
    expect(rows[0].meter).toBe('(all)');
  });
  it('reports missing columns and bad numbers with the line', () => {
    expect(() => parseIntervals('timestamp,kwh\n', 'f.csv')).toThrow(/no "kvarh" column.*--kvarh-column/);
    expect(() => parseIntervals('timestamp,kwh,kvarh\n2026-01-01 00:30,abc,1\n', 'f.csv')).toThrow(/f.csv:2: kWh "abc"/);
    expect(() => parseIntervals('timestamp,kwh,kvarh\n2026-01-01 00:30,1,\n', 'f.csv')).toThrow(/kVArh ""/);
    expect(() => parseIntervals('timestamp,kwh,kvarh\n2026-01-01 00:30,1\n', 'f.csv')).toThrow(/expected at least 3/);
    expect(() => parseIntervals('', 'f.csv')).toThrow(/empty/);
  });
});

describe('parseCharges', () => {
  it('reads month,rm with an optional meter', () => {
    const c = parseCharges('month,rm,meter\n2026-01,100.5,\n2026-01,50,A\n', 'c.csv');
    expect(c.get('*|2026-01')).toBe(100.5);
    expect(c.get('A|2026-01')).toBe(50);
  });
  it('refuses bad months, negatives and repeats', () => {
    expect(() => parseCharges('month,rm\n2026-13,1\n', 'c.csv')).toThrow(/YYYY-MM/);
    expect(() => parseCharges('month,rm\n2026-01,-1\n', 'c.csv')).toThrow(/negative/);
    expect(() => parseCharges('month,rm\n2026-01,1\n2026-01,2\n', 'c.csv')).toThrow(/twice/);
  });
});
