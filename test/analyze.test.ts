import { describe, expect, it } from 'vitest';
import { analyze } from '../src/analyze.js';
import { parseCharges, parseIntervals } from '../src/input.js';

const csv = (lines: string[]) => parseIntervals('meter,timestamp,kwh,kvarh\n' + lines.join('\n') + '\n', 'f.csv');

describe('analyze', () => {
  it('assigns an end-stamped midnight row to the previous month, start-stamped to the next', () => {
    const rows = csv(['A,2026-01-31 23:30,10,0', 'A,2026-02-01 00:00,10,10', 'A,2026-02-01 00:30,10,0']);
    const end = analyze(rows).meters[0].months;
    expect(end.map((m) => [m.month, m.intervals])).toEqual([['2026-01', 2], ['2026-02', 1]]);
    const start = analyze(rows, { stamp: 'start' }).meters[0].months;
    expect(start.map((m) => [m.month, m.intervals])).toEqual([['2026-01', 1], ['2026-02', 2]]);
  });

  it('computes the monthly average PF from lagging kVArh only and reports leading separately', () => {
    const r = analyze(csv(['A,2026-01-01 00:30,4,3', 'A,2026-01-01 01:00,4,3', 'A,2026-01-01 01:30,2,-5']));
    const m = r.meters[0].months[0];
    expect(m.kvarhLagging).toBe(6);
    expect(m.kvarhLeading).toBe(5);
    expect(m.pf).toBeCloseTo(10 / Math.hypot(10, 6), 4);
    expect(m.coverage).toBeCloseTo(90 / (31 * 1440), 4);
  });

  it('flags surcharge months, prices them with charges (meter-specific first) and sums RM', () => {
    const rows = csv(['A,2026-01-01 00:30,4,3', 'A,2026-01-01 01:00,4,3', 'B,2026-01-01 00:30,4,3', 'B,2026-01-01 01:00,4,3']);
    const charges = parseCharges('month,rm,meter\n2026-01,1000,\n2026-01,2000,B\n', 'c.csv');
    const r = analyze(rows, { charges });
    expect(r.meters.map((m) => m.months[0].surchargeRm)).toEqual([75, 150]);
    expect(r.summary).toMatchObject({ meters: 2, surchargeMonths: 2, surchargeRm: 225 });
    expect(r.findings.map((f) => f.type)).toEqual(['surcharge', 'surcharge']);
  });

  it('uses the hv limits', () => {
    const r = analyze(csv(['A,2026-01-01 00:30,4,3', 'A,2026-01-01 01:00,4,3']), { supply: 'hv' });
    expect(r.meters[0].months[0].surchargePercent).toBe(15);
    expect(r.minimumPf).toBe(0.9);
  });

  it('rounds the PF before the surcharge only with pfRound', () => {
    // PF = 0.8449 -> continuous (0.85 - 0.8449) / 0.01 * 1.5 = 0.765%; rounded to 0.84 -> 1.5%.
    const q = Math.sqrt(1 / 0.8449 ** 2 - 1) * 100;
    const rows = csv([`A,2026-01-01 00:30,100,${q}`, 'A,2026-01-01 01:00,0,0']);
    expect(analyze(rows).meters[0].months[0].surchargePercent).toBeCloseTo(0.765, 4);
    const rounded = analyze(rows, { pfRound: 2 }).meters[0].months[0];
    expect(rounded.pfForSurcharge).toBe(0.84);
    expect(rounded.surchargePercent).toBe(1.5);
  });

  it('reports duplicates (first wins), gaps, irregular steps and negative kWh', () => {
    const r = analyze(
      csv([
        'A,2026-01-01 00:30,1,0',
        'A,2026-01-01 01:00,1,0',
        'A,2026-01-01 01:00,9,9',
        'A,2026-01-01 02:30,1,0',
        'A,2026-01-01 02:40,-2,0',
        'A,2026-01-01 03:10,1,0',
      ]),
    );
    expect(r.meters[0].intervalMinutes).toBe(30);
    expect(r.meters[0].rows).toBe(5);
    expect(r.meters[0].months[0].kwh).toBe(4);
    expect(r.findings.map((f) => f.type)).toEqual(['gap', 'irregular-step', 'duplicate-timestamp', 'negative-kwh']);
    expect(r.findings[0].message).toMatch(/^2 interval\(s\) missing/);
    expect(r.findings[2].where).toBe('f.csv:4');
  });

  it('sorts rows per meter regardless of file order', () => {
    const r = analyze(csv(['A,2026-01-01 01:30,1,0', 'A,2026-01-01 00:30,1,0', 'A,2026-01-01 01:00,1,0']));
    expect(r.findings).toEqual([]);
    expect(r.meters[0].first).toBe('2026-01-01 00:30');
  });

  it('needs --interval when a meter has a single row', () => {
    expect(() => analyze(csv(['A,2026-01-01 00:30,1,0']))).toThrow(/--interval/);
    expect(analyze(csv(['A,2026-01-01 00:30,1,0']), { intervalMinutes: 30 }).meters[0].rows).toBe(1);
    expect(() => analyze(csv(['A,2026-01-01 00:30,1,0']), { intervalMinutes: 0 })).toThrow(/--interval/);
    expect(() => analyze(csv(['A,2026-01-01 00:30,1,0']), { target: 1.2 })).toThrow(/--target/);
  });

  describe('capacitor sizing', () => {
    it('is zero when every month already meets the target', () => {
      const z = analyze(csv(['A,2026-01-01 00:30,10,1', 'A,2026-01-01 01:00,10,1'])).meters[0].sizing;
      expect(z.requiredKvar).toBe(0);
      expect(z.peakKvar).toBe(2);
    });

    it('finds the smallest fixed bank and reports over-compensation at light load', () => {
      // 30-min intervals: heavy 100 kWh / 75 kVArh, light 10 kWh / 2 kVArh. Month: 110 kWh, 77 kVArh, PF 0.819.
      // Target 0.90 -> lagging must be <= 110 * tan(acos 0.9) = 53.276 kVArh.
      // Bank Q supplies Q/2 kVArh per interval: 75 - Q/2 + max(0, 2 - Q/2) <= 53.276 -> Q >= 43.45 -> 43.5 kVAr.
      const z = analyze(csv(['A,2026-01-01 00:30,100,75', 'A,2026-01-01 01:00,10,2'])).meters[0].sizing;
      expect(z.requiredKvar).toBe(43.5);
      expect(z.peakKvar).toBe(150);
      expect(z.overCompensatedIntervals).toBe(1);
      expect(z.addedLeadingKvarh).toBeCloseTo(43.5 / 2 - 2, 6);
      expect(z.monthsAfter[0].pf).toBeGreaterThanOrEqual(0.9);
      expect(z.monthsAfter[0].surchargePercent).toBe(0);
    });

    it('sizes for the worst month and honours the target', () => {
      const rows = csv(['A,2026-01-01 00:30,10,10', 'A,2026-01-01 01:00,10,10', 'A,2026-02-01 00:30,10,5', 'A,2026-02-01 01:00,10,5']);
      const z90 = analyze(rows, { intervalMinutes: 30 }).meters[0].sizing;
      // Jan: 20 kWh, 20 kVArh: 20 - Q <= 9.6864 -> Q >= 10.3136 -> 10.4.
      expect(z90.requiredKvar).toBe(10.4);
      const z95 = analyze(rows, { intervalMinutes: 30, target: 0.95 }).meters[0].sizing;
      expect(z95.requiredKvar).toBeGreaterThan(z90.requiredKvar);
      const z100 = analyze(rows, { intervalMinutes: 30, target: 1 }).meters[0].sizing;
      expect(z100.requiredKvar).toBe(20);
    });

    it('handles a month with reactive energy but no kWh', () => {
      const z = analyze(csv(['A,2026-01-01 00:30,0,3', 'A,2026-01-01 01:00,0,3'])).meters[0].sizing;
      expect(z.requiredKvar).toBe(6);
      expect(z.monthsAfter[0].pf).toBeNull();
    });
  });
});
