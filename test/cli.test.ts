import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { ex, root } from './helpers.js';

const call = (args: string[]) => {
  let out = '';
  let err = '';
  const code = run(args, (s) => (out += s), (s) => (err += s));
  return { code, out, err };
};

describe('cli', () => {
  it('runs the example: January 0.80 -> 7.5% = RM 3,000; 26.6 kVAr bank', () => {
    const r = call([ex('factory.csv'), '--charges', ex('charges.csv')]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('2026-01   100%  74,400.0   55,800.0         0.0  0.8000       7.5%  3,000.00');
    expect(r.out).toContain('2026-02   100%  67,200.0   40,320.0         0.0  0.8575         0%      0.00');
    expect(r.out).toContain('a fixed 26.6 kVAr bank lifts every month to PF >= 0.90');
    expect(r.out).toContain('Surcharge months: 1, surcharge RM 3,000.00');
  });

  it('prints JSON', () => {
    const r = call([ex('factory.csv'), '--json', '--supply', 'hv']);
    const d = JSON.parse(r.out);
    expect(d.summary).toMatchObject({ meters: 1, rows: 2832, surchargeMonths: 2, surchargeRm: null });
    // Feb PF = 2400 / hypot(2400, 1440) = 0.857493 -> (0.90 - PF) / 0.01 * 1.5 = 6.3761%.
    expect(d.meters[0].months[1].surchargePercent).toBeCloseTo(6.3761, 4);
    expect(d.meters[0].months[0].surchargePercent).toBe(15);
  });

  it('exits 0 with no findings', () => {
    const ok = call([join(root, 'examples', 'good.csv')]);
    expect(ok.code).toBe(0);
    expect(ok.out).toContain('No findings.');
    expect(ok.out).toContain('no fixed bank needed');
  });

  it('exits 2 on input errors', () => {
    expect(call([]).code).toBe(2);
    expect(call(['--supply', 'mv', 'x.csv']).err).toMatch(/lv or hv/);
    expect(call(['--bogus']).err).toMatch(/unknown option/);
    expect(call(['missing.csv']).err).toMatch(/cannot read missing.csv/);
    expect(call([ex('factory.csv'), '--pf-round', '7']).code).toBe(2);
    expect(call([ex('factory.csv'), '--target']).err).toMatch(/needs a value/);
  });

  it('prints help and version', () => {
    expect(call(['--help']).out).toMatch(/Usage: tnb-pf-check/);
    expect(call(['--version']).out).toBe('0.1.0\n');
  });

});
