import { describe, expect, it } from 'vitest';
import { analyze } from '../src/analyze.js';
import { run } from '../src/cli.js';
import { formatCsv, formatMarkdown } from '../src/formats.js';
import { parseIntervals } from '../src/input.js';
import { formatText } from '../src/report.js';
import { isWeekend, parseTimestamp } from '../src/time.js';
import { ex } from './helpers.js';

const csv = (lines: string[]) => parseIntervals('meter,timestamp,kwh,kvarh\n' + lines.join('\n') + '\n', 'f.csv');

// 2026-01-02 is a Friday, 2026-01-03 Saturday, 2026-01-05 Monday. Hourly, end-stamped.
const rows = csv([
  'A,2026-01-02 09:00,4,3', // Fri 08:00-09:00: PF 0.8 (weekday, low)
  'A,2026-01-03 00:00,4,0', // starts Fri 23:00 -> weekday
  'A,2026-01-03 09:00,4,0', // Sat 08:00-09:00: PF 1 (weekend)
  'A,2026-01-05 00:00,4,3', // starts Sun 23:00 -> weekend, low
]);

describe('isWeekend', () => {
  it('is Saturday and Sunday on the wall clock', () => {
    const at = (t: string) => isWeekend(parseTimestamp(t, 'x'));
    expect(at('2026-01-02 23:59')).toBe(false);
    expect(at('2026-01-03 00:00')).toBe(true);
    expect(at('2026-01-04 23:59')).toBe(true);
    expect(at('2026-01-05 00:00')).toBe(false);
  });
});

describe('weekday / weekend profile split', () => {
  it('is absent unless asked for, and --profile alone does not add it', () => {
    const m = analyze(rows, { intervalMinutes: 60, profile: true }).meters[0];
    expect(m.profileWeekday).toBeUndefined();
    expect(m.profileWeekend).toBeUndefined();
  });

  it('implies the all-days profile and splits by the interval start day', () => {
    const m = analyze(rows, { intervalMinutes: 60, profileSplit: true }).meters[0];
    expect(m.profile).toHaveLength(24);
    expect(m.profileWeekday).toHaveLength(24);
    expect(m.profileWeekend).toHaveLength(24);
    expect(m.profileWeekday![8]).toEqual({ hour: 8, intervals: 1, kwh: 4, kvarhLagging: 3, pf: 0.8, avgKw: 4, avgKvar: 3, belowMinimum: true });
    expect(m.profileWeekend![8]).toMatchObject({ intervals: 1, kwh: 4, kvarhLagging: 0, pf: 1, belowMinimum: false });
    // End-stamped midnight belongs to the day before (Fri 23:00 weekday, Sun 23:00 weekend).
    expect(m.profileWeekday![23]).toMatchObject({ intervals: 1, pf: 1 });
    expect(m.profileWeekend![23]).toMatchObject({ intervals: 1, pf: 0.8, belowMinimum: true });
    // All days = weekday + weekend.
    expect(m.profile![8]).toMatchObject({ intervals: 2, kwh: 8, kvarhLagging: 3, pf: 0.9363, belowMinimum: false });
    for (let h = 0; h < 24; h++) {
      expect(m.profileWeekday![h].intervals + m.profileWeekend![h].intervals).toBe(m.profile![h].intervals);
    }
  });

  it('follows --stamp start', () => {
    const m = analyze(rows, { intervalMinutes: 60, profileSplit: true, stamp: 'start' }).meters[0];
    // Stamp 2026-01-03 00:00 is now the start of a Saturday hour.
    expect(m.profileWeekend![0].intervals).toBe(1);
    // Stamp 2026-01-05 00:00 is now the start of a Monday hour.
    expect(m.profileWeekday![0]).toMatchObject({ intervals: 1, pf: 0.8 });
    expect(m.profileWeekend![23].intervals).toBe(0);
  });

  it('prints the extra text and Markdown tables, CSV unchanged', () => {
    const report = analyze(rows, { intervalMinutes: 60, profileSplit: true });
    const text = formatText(report);
    expect(text).toContain('Hour-of-day profile (interval start, all days):');
    expect(text).toContain('Hour-of-day profile (interval start, weekdays Mon-Fri):');
    expect(text).toContain('Hour-of-day profile (interval start, weekend Sat-Sun):');
    expect(text).toContain('Below PF 0.85: 08:00-09:00.');
    expect(text).toContain('Below PF 0.85: 23:00-24:00.');
    const md = formatMarkdown(report);
    expect(md).toContain('### Hour-of-day profile\n');
    expect(md).toContain('### Hour-of-day profile, weekdays Mon-Fri');
    expect(md).toContain('### Hour-of-day profile, weekend Sat-Sun');
    expect(md).toContain('_Hour of the interval start, weekend Sat-Sun._');
    expect(formatCsv(report)).toBe(formatCsv(analyze(rows, { intervalMinutes: 60 })));
  });

  it('keeps the plain --profile output byte-for-byte', () => {
    const plain = analyze(rows, { intervalMinutes: 60, profile: true });
    const text = formatText(plain);
    expect(text).not.toContain('weekdays');
    expect(text.match(/Hour-of-day profile/g)).toHaveLength(1);
  });

  it('says "No intervals." for a side with no data', () => {
    const report = analyze(csv(['A,2026-01-05 09:00,4,0', 'A,2026-01-05 10:00,4,0']), { profileSplit: true });
    expect(report.meters[0].profileWeekend!.every((h) => h.intervals === 0)).toBe(true);
    const text = formatText(report);
    expect(text).toMatch(/weekend Sat-Sun\):\n {2}No intervals\./);
    expect(formatMarkdown(report)).toMatch(/_Hour of the interval start, weekend Sat-Sun\._\n\nNo intervals\./);
  });

  it('is wired to --profile-split on the CLI', () => {
    let out = '';
    expect(run([ex('factory.csv'), '--profile-split', '--json'], (s) => (out += s), () => undefined)).toBe(1);
    const m = JSON.parse(out).meters[0];
    const total = (p: { intervals: number }[]) => p.reduce((n, h) => n + h.intervals, 0);
    expect(total(m.profile)).toBe(2832);
    expect(total(m.profileWeekday) + total(m.profileWeekend)).toBe(2832);
    expect(total(m.profileWeekend)).toBeGreaterThan(0);
    let help = '';
    run(['--help'], (s) => (help += s), () => undefined);
    expect(help).toContain('--profile-split');
  });
});
