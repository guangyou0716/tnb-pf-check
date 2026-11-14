import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { analyze } from '../src/analyze.js';
import { run } from '../src/cli.js';
import { CSV_DEMAND_HEADER, CSV_HEADER, formatCsv, formatMarkdown } from '../src/formats.js';
import { parseIntervals } from '../src/input.js';
import { formatText } from '../src/report.js';
import { ex } from './helpers.js';

const csv = (lines: string[]) => parseIntervals('meter,timestamp,kwh,kvarh\n' + lines.join('\n') + '\n', 'f.csv');

// 15-minute, end-stamped. Clock half hours: 00:00-00:30 = 20 kWh / 10 kVArh, 00:30-01:00 = 35 / 20.
// The 15-30 + 30-45 pair (40 kWh) straddles two half hours and must not count.
const quarter = csv(['A,2026-01-01 00:15,10,5', 'A,2026-01-01 00:30,10,5', 'A,2026-01-01 00:45,30,20', 'A,2026-01-01 01:00,5,0']);

describe('--demand (monthly MD and reactive MD)', () => {
  it('is absent unless asked for', () => {
    const report = analyze(quarter);
    expect(report.meters[0].months[0].demand).toBeUndefined();
    expect(report.meters[0].demandNote).toBeUndefined();
    expect(formatText(report)).not.toContain('Maximum demand');
    expect(formatMarkdown(report)).not.toContain('Maximum demand');
    expect(formatCsv(report).split('\n')[0]).toBe(CSV_HEADER.join(','));
  });

  it('is twice the largest 30-minute kWh / lagging kVArh of the example (hand-checked)', () => {
    const m = analyze(parseIntervals(readExample(), 'factory.csv'), { demand: true }).meters[0];
    // Every half hour is 50 kWh; January days 55 kVArh, February days 45 kVArh; bank 26.6 kVAr = 13.3 kVArh.
    expect(m.months.map((x) => x.demand)).toEqual([
      { mdKw: 100, mdAt: '2026-01-01 00:00', reactiveMdKvar: 110, reactiveMdAt: '2026-01-01 08:00', reactiveMdAfterBankKvar: 83.4 },
      { mdKw: 100, mdAt: '2026-02-01 00:00', reactiveMdKvar: 90, reactiveMdAt: '2026-02-01 08:00', reactiveMdAfterBankKvar: 63.4 },
    ]);
  });

  it('sums 15-minute intervals into clock half hours (not a sliding window)', () => {
    const d = analyze(quarter, { demand: true }).meters[0].months[0].demand!;
    expect(d.mdKw).toBe(70);
    expect(d.mdAt).toBe('2026-01-01 00:30');
    expect(d.reactiveMdKvar).toBe(40);
    expect(d.reactiveMdAt).toBe('2026-01-01 00:30');
  });

  it('follows --stamp start', () => {
    // Same stamps read as interval starts: half hours 00:00 = 10, 00:30 = 40 kWh, 01:00 = 5.
    const d = analyze(quarter, { demand: true, stamp: 'start' }).meters[0].months[0].demand!;
    expect(d.mdKw).toBe(80);
    expect(d.mdAt).toBe('2026-01-01 00:30');
  });

  it('counts only lagging kVArh and keeps the first half hour on a tie', () => {
    const d = analyze(csv(['A,2026-01-01 00:30,10,-50', 'A,2026-01-01 01:00,10,4', 'A,2026-01-01 01:30,10,4']), { demand: true }).meters[0].months[0]
      .demand!;
    expect(d.reactiveMdKvar).toBe(8);
    expect(d.reactiveMdAt).toBe('2026-01-01 00:30');
    expect(d.mdKw).toBe(20);
    expect(d.mdAt).toBe('2026-01-01 00:00');
  });

  it('is per month, by the month of the half hour', () => {
    const months = analyze(csv(['A,2026-01-31 23:30,10,8', 'A,2026-02-01 00:00,40,30', 'A,2026-02-01 00:30,20,1']), { demand: true }).meters[0].months;
    expect(months.map((x) => [x.month, x.demand!.mdKw, x.demand!.reactiveMdKvar, x.demand!.mdAt])).toEqual([
      ['2026-01', 80, 60, '2026-01-31 23:30'],
      ['2026-02', 40, 2, '2026-02-01 00:00'],
    ]);
  });

  it('clips each interval at zero with the bank (no negative kVArh from over-compensation)', () => {
    // 15-min: 0 and 10 kVArh in one half hour. A 20 kVAr bank supplies 5 kVArh per quarter: 0 + 5 = 5 -> 10 kVAr.
    const rows = csv(['A,2026-01-01 00:15,10,0', 'A,2026-01-01 00:30,10,10', 'A,2026-01-01 00:45,10,10', 'A,2026-01-01 01:00,10,10']);
    const m = analyze(rows, { demand: true, target: 0.99 }).meters[0];
    expect(m.sizing.requiredKvar).toBeGreaterThan(0);
    const supplied = m.sizing.requiredKvar / 4;
    expect(m.months[0].demand!.reactiveMdKvar).toBe(40);
    expect(m.months[0].demand!.reactiveMdAfterBankKvar).toBeCloseTo(2 * 2 * (10 - supplied), 3);
    const small = analyze(rows.slice(0, 2), { demand: true, target: 0.5, intervalMinutes: 15 }).meters[0];
    expect(small.sizing.requiredKvar).toBe(0);
    expect(small.months[0].demand!.reactiveMdAfterBankKvar).toBe(small.months[0].demand!.reactiveMdKvar);
  });

  it('gives a note and null values when the interval does not divide 30 minutes', () => {
    const report = analyze(csv(['A,2026-01-01 01:00,10,5', 'A,2026-01-01 02:00,10,5']), { demand: true });
    const m = report.meters[0];
    expect(m.demandNote).toMatch(/30 minutes or a divisor of 30 \(this meter has 60 min\)/);
    expect(m.months[0].demand).toEqual({ mdKw: null, mdAt: null, reactiveMdKvar: null, reactiveMdAt: null, reactiveMdAfterBankKvar: null });
    expect(formatText(report)).toContain('this meter has 60 min');
    expect(formatMarkdown(report)).toContain('this meter has 60 min');
    expect(formatCsv(report).split('\n')[1].endsWith(',,,,,')).toBe(true);
  });

  it('shows a table in text and Markdown and extra CSV columns', () => {
    const report = analyze(parseIntervals(readExample(), 'factory.csv'), { demand: true });
    const text = formatText(report);
    expect(text).toContain('TNB tariff booklet 1(o) / 1(r)');
    expect(text).toMatch(/2026-01 +100\.0 +2026-01-01 00:00 +110\.0 +2026-01-01 08:00 +83\.4/);
    const md = formatMarkdown(report);
    expect(md).toContain('### Maximum demand');
    expect(md).toContain('| Month | MD kW | MD at | Reactive MD kVAr | Reactive MD at | Reactive MD with 26.6 kVAr |');
    expect(md).toContain('| 2026-01 | 100.0 | 2026-01-01 00:00 | 110.0 | 2026-01-01 08:00 | 83.4 |');
    const lines = formatCsv(report).trim().split('\n');
    expect(lines[0]).toBe([...CSV_HEADER, ...CSV_DEMAND_HEADER].join(','));
    expect(lines[1].endsWith(',100,2026-01-01 00:00,110,2026-01-01 08:00,83.4')).toBe(true);
  });

  it('is wired to --demand on the CLI', () => {
    let out = '';
    expect(run([ex('factory.csv'), '--demand', '--json'], (s) => (out += s), () => undefined)).toBe(1);
    expect(JSON.parse(out).meters[0].months[1].demand.reactiveMdKvar).toBe(90);
    let help = '';
    run(['--help'], (s) => (help += s), () => undefined);
    expect(help).toContain('--demand');
  });
});

function readExample(): string {
  return readFileSync(ex('factory.csv'), 'utf8');
}
