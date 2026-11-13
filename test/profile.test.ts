import { describe, expect, it } from 'vitest';
import { analyze } from '../src/analyze.js';
import { run } from '../src/cli.js';
import { formatCsv, formatMarkdown } from '../src/formats.js';
import { parseIntervals } from '../src/input.js';
import { formatText } from '../src/report.js';
import { ex } from './helpers.js';

const csv = (lines: string[]) => parseIntervals('meter,timestamp,kwh,kvarh\n' + lines.join('\n') + '\n', 'f.csv');

// Two days of 30-min data. 08:00-09:00 (stamps 08:30, 09:00 end) are poor: 4 kWh + 3 kVArh -> PF 0.8.
// 23:30-24:00 (stamp 00:00 of the next day) is good: 4 kWh + 0 kVArh -> PF 1.
const rows = csv([
  'A,2026-01-01 08:30,4,3',
  'A,2026-01-01 09:00,4,3',
  'A,2026-01-02 00:00,4,0',
  'A,2026-01-02 08:30,4,3',
  'A,2026-01-02 09:00,4,3',
]);

describe('hour-of-day profile', () => {
  it('is absent unless asked for', () => {
    expect(analyze(rows, { intervalMinutes: 30 }).meters[0].profile).toBeUndefined();
  });

  it('buckets by the interval start hour, end-stamped midnight goes to 23:00', () => {
    const p = analyze(rows, { intervalMinutes: 30, profile: true }).meters[0].profile!;
    expect(p).toHaveLength(24);
    expect(p[8]).toEqual({ hour: 8, intervals: 4, kwh: 16, kvarhLagging: 12, pf: 0.8, avgKw: 8, avgKvar: 6, belowMinimum: true });
    expect(p[23]).toMatchObject({ hour: 23, intervals: 1, kwh: 4, pf: 1, avgKw: 8, belowMinimum: false });
    expect(p[0]).toMatchObject({ intervals: 0, kwh: 0, pf: null, avgKw: 0, belowMinimum: false });
    expect(p.reduce((n, h) => n + h.intervals, 0)).toBe(5);
  });

  it('uses the stamp as the start with stamp=start', () => {
    const p = analyze(rows, { intervalMinutes: 30, profile: true, stamp: 'start' }).meters[0].profile!;
    expect(p[0].intervals).toBe(1);
    expect(p[8].intervals).toBe(2);
    expect(p[9].intervals).toBe(2);
  });

  it('uses the supply minimum for belowMinimum', () => {
    const r = csv(['A,2026-01-01 00:30,100,58', 'A,2026-01-01 01:00,100,58']);
    // PF = 100 / hypot(100, 58) = 0.865 -> fine for lv (0.85), low for hv (0.90).
    expect(analyze(r, { profile: true }).meters[0].profile![0].belowMinimum).toBe(false);
    expect(analyze(r, { profile: true, supply: 'hv' }).meters[0].profile![0].belowMinimum).toBe(true);
  });

  it('prints text and Markdown tables with the low hours, CSV unchanged', () => {
    const report = analyze(rows, { intervalMinutes: 30, profile: true });
    const text = formatText(report);
    expect(text).toContain('Hour-of-day profile (interval start, all days):');
    expect(text).toMatch(/08:00-09:00\s+4\s+16\.0\s+12\.0\s+8\.0\s+6\.0\s+0\.8000\s+low/);
    expect(text).toContain('Below PF 0.85: 08:00-09:00.');
    expect(text).not.toContain('00:00-01:00');
    const md = formatMarkdown(report);
    expect(md).toContain('### Hour-of-day profile');
    expect(md).toContain('| 08:00-09:00 | 4 | 16.0 | 12.0 | 8.0 | 6.0 | 0.8000 | yes |');
    expect(md).toContain('| 23:00-24:00 | 1 | 4.0 | 0.0 | 8.0 | 0.0 | 1.0000 |  |');
    expect(formatCsv(report)).toBe(formatCsv(analyze(rows, { intervalMinutes: 30 })));
    expect(formatText(analyze(rows, { intervalMinutes: 30 }))).not.toContain('Hour-of-day');
  });

  it('says so when no hour is low', () => {
    const md = formatMarkdown(analyze(csv(['A,2026-01-01 00:30,4,0', 'A,2026-01-01 01:00,4,0']), { profile: true }));
    expect(md).toContain('No hour is below PF 0.85.');
  });

  it('is wired to --profile on the CLI (JSON includes it)', () => {
    let out = '';
    const code = run([ex('factory.csv'), '--profile', '--json'], (s) => (out += s), () => undefined);
    expect(code).toBe(1);
    const p = JSON.parse(out).meters[0].profile;
    expect(p).toHaveLength(24);
    expect(p.reduce((n: number, h: { intervals: number }) => n + h.intervals, 0)).toBe(2832);
    let text = '';
    run([ex('factory.csv'), '--profile'], (s) => (text += s), () => undefined);
    // Example: 55 kVArh per 30 min from 08:00 to 20:00 in January -> those hours are low; merged into one range.
    expect(text).toContain('Below PF 0.85: 08:00-20:00.');
  });

  it('merges separate low ranges', () => {
    const r = csv(['A,2026-01-01 01:00,4,3', 'A,2026-01-01 02:00,4,0', 'A,2026-01-01 03:00,4,3', 'A,2026-01-01 04:00,4,3', 'A,2026-01-02 00:00,4,3']);
    expect(formatText(analyze(r, { intervalMinutes: 60, profile: true }))).toContain('Below PF 0.85: 00:00-01:00, 02:00-04:00, 23:00-24:00.');
  });
});
