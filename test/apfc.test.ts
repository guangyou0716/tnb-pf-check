import { describe, expect, it } from 'vitest';
import { analyze } from '../src/analyze.js';
import { run } from '../src/cli.js';
import { formatCsv, formatMarkdown } from '../src/formats.js';
import { parseIntervals } from '../src/input.js';
import { formatText } from '../src/report.js';

const csv = (lines: string[]) => parseIntervals('meter,timestamp,kwh,kvarh\n' + lines.join('\n') + '\n', 'f.csv');

// 30-min intervals. Heavy: 40 kWh + 30 kVArh (80 kW, 60 kVAr). Light: 10 kWh + 5 kVArh (20 kW, 10 kVAr).
// Before: 50 kWh, 35 kVArh -> PF 0.8192 (surcharged on LV).
// 10 kVAr steps: 1 step -> heavy 25 left, light 0 -> PF 50/hypot(50,25) = 0.8944 < 0.90;
// 2 steps -> heavy 20 left, light 0 (only 1 step fits under 10 kVAr) -> PF 50/hypot(50,20) = 0.9285.
const rows = csv(['A,2026-01-01 08:30,40,30', 'A,2026-01-01 09:00,10,5']);

describe('APFC stepped bank', () => {
  it('is absent unless asked for', () => {
    expect(analyze(rows).meters[0].apfc).toBeUndefined();
  });

  it('finds the fewest equal steps, never over-compensating', () => {
    const a = analyze(rows, { apfcStepKvar: 10 }).meters[0].apfc!;
    expect(a).toEqual({
      target: 0.9,
      stepKvar: 10,
      steps: 2,
      installedKvar: 20,
      targetMet: true,
      avgStepsOn: 1.5,
      fullIntervals: 1,
      monthsAfter: [{ month: '2026-01', pf: 0.9285, surchargePercent: 0 }],
    });
  });

  it('compares with the fixed bank, which over-compensates the light interval', () => {
    const m = analyze(rows, { apfcStepKvar: 10 }).meters[0];
    expect(m.sizing.overCompensatedIntervals).toBeGreaterThan(0);
  });

  it('needs no steps when every month already meets the target', () => {
    const a = analyze(csv(['A,2026-01-01 00:30,10,1', 'A,2026-01-01 01:00,10,1']), { apfcStepKvar: 5 }).meters[0].apfc!;
    expect(a).toMatchObject({ steps: 0, installedKvar: 0, targetMet: true, avgStepsOn: 0, fullIntervals: 0 });
  });

  it('reports the target as not met when all usable steps are not enough', () => {
    const a = analyze(rows, { apfcStepKvar: 40, target: 0.95 }).meters[0].apfc!;
    // 40 kVAr: heavy takes 1 (20 kVArh) -> 10 + 5 = 15 left -> PF 50/hypot(50,15) = 0.9578 >= 0.95: met.
    expect(a).toMatchObject({ steps: 1, targetMet: true });
    const b = analyze(rows, { apfcStepKvar: 40, target: 0.99 }).meters[0].apfc!;
    expect(b).toMatchObject({ steps: 1, installedKvar: 40, targetMet: false, monthsAfter: [{ month: '2026-01', pf: 0.9578 }] });
    const c = analyze(rows, { apfcStepKvar: 70 }).meters[0].apfc!;
    expect(c).toMatchObject({ steps: 0, targetMet: false });
    expect(formatText(analyze(rows, { apfcStepKvar: 70 }))).toContain('would never switch in; use a smaller step.');
    expect(formatText(analyze(rows, { apfcStepKvar: 40, target: 0.99 }))).toContain('even 1 step(s) (40.0 kVAr');
  });

  it('sizes each month: the worst month decides the step count', () => {
    const r = csv(['A,2026-01-01 08:30,40,30', 'A,2026-02-01 08:30,40,10']);
    const a = analyze(r, { apfcStepKvar: 10, intervalMinutes: 30 }).meters[0].apfc!;
    // Jan: 40 kWh, 30 kVArh needs lag <= 19.37 -> 3 steps (15 kVArh) leaves 15 -> PF 0.9363; 2 steps leaves 20 -> 0.8944.
    expect(a.steps).toBe(3);
    expect(a.monthsAfter.map((x) => x.month)).toEqual(['2026-01', '2026-02']);
    // Feb: 20 kVAr fits only 2 steps -> 0 left -> PF 1.
    expect(a.monthsAfter[1].pf).toBe(1);
  });

  it('applies --pf-round and the supply to the surcharge after the bank', () => {
    const a = analyze(rows, { apfcStepKvar: 10, supply: 'hv', target: 0.85 }).meters[0].apfc!;
    // 1 step -> PF 0.8944 meets the 0.85 target but is below the HV minimum 0.90, so a surcharge remains.
    expect(a.steps).toBe(1);
    expect(a.monthsAfter[0].surchargePercent).toBeGreaterThan(0);
    const rounded = analyze(rows, { apfcStepKvar: 10, supply: 'hv', target: 0.85, pfRound: 2 }).meters[0].apfc!;
    // 0.8944 rounds to 0.89 -> 1.5%.
    expect(rounded.monthsAfter[0].surchargePercent).toBe(1.5);
  });

  it('prints text and Markdown lines, leaves CSV unchanged', () => {
    const report = analyze(rows, { apfcStepKvar: 10 });
    const text = formatText(report);
    expect(text).toContain('APFC: 2 x 10.0 kVAr = 20.0 kVAr lifts every month to PF >= 0.90 with no leading kVArh (mean 1.5 step(s) in service, all steps in 1 interval(s)).');
    expect(text).toContain('  After: 2026-01 0.9285');
    const md = formatMarkdown(report);
    expect(md).toContain('APFC: **2 x 10.0 kVAr = 20.0 kVAr** lifts');
    expect(md).toContain('\n\nAfter: 2026-01 0.9285\n');
    expect(formatCsv(report)).toBe(formatCsv(analyze(rows)));
  });

  it('validates --apfc-step on the CLI', () => {
    const err: string[] = [];
    for (const v of ['0', '-5', 'abc', '200000']) {
      expect(run(['x.csv', '--apfc-step', v], () => {}, (s) => err.push(s))).toBe(2);
    }
    expect(err.join('')).toContain('--apfc-step');
    expect(() => analyze(rows, { apfcStepKvar: Number.NaN })).toThrow('--apfc-step');
  });
});
