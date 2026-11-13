import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { analyze } from '../src/analyze.js';
import { run } from '../src/cli.js';
import { CSV_HEADER, csvCell, formatCsv, formatMarkdown } from '../src/formats.js';
import { parseCharges, parseIntervals } from '../src/input.js';
import { ex } from './helpers.js';

const call = (args: string[]) => {
  let out = '';
  let err = '';
  const code = run(args, (s) => (out += s), (s) => (err += s));
  return { code, out, err };
};

const factory = () =>
  analyze(parseIntervals(readFileSync(ex('factory.csv'), 'utf8'), 'factory.csv'), {
    charges: parseCharges(readFileSync(ex('charges.csv'), 'utf8'), 'charges.csv'),
  });

describe('csvCell', () => {
  it('quotes, guards formulas and leaves numbers alone', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('-x')).toBe("'-x");
    expect(csvCell('@a')).toBe("'@a");
    expect(csvCell(-1.5)).toBe('-1.5');
    expect(csvCell(null)).toBe('');
    expect(csvCell(Number.NaN)).toBe('');
  });
});

describe('formatCsv', () => {
  it('writes one row per meter-month with the bank result', () => {
    const lines = formatCsv(factory()).trimEnd().split('\n');
    expect(lines[0]).toBe(CSV_HEADER.join(','));
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe('MSB-1,2026-01,1488,30,1,74400,55800,0,0.8,0.8,0.85,7.5,40000,3000,0.9,26.6,0.9001,0');
    expect(lines[2]).toBe('MSB-1,2026-02,1344,30,1,67200,40320,0,0.8575,0.8575,0.85,0,36000,0,0.9,26.6,0.9485,0');
  });

  it('leaves RM cells empty without charges and guards meter names', () => {
    const rows = parseIntervals('meter,timestamp,kwh,kvarh\n=evil,2026-01-01 00:30,10,5\n=evil,2026-01-01 01:00,10,5\n', 'x.csv');
    const lines = formatCsv(analyze(rows)).trimEnd().split('\n');
    const cells = lines[1].split(',');
    expect(cells[0]).toBe("'=evil");
    expect(cells[CSV_HEADER.indexOf('charges_rm')]).toBe('');
    expect(cells[CSV_HEADER.indexOf('surcharge_rm')]).toBe('');
  });
});

describe('formatMarkdown', () => {
  it('renders summary, month table with PF after the bank, and findings', () => {
    const md = formatMarkdown(factory());
    expect(md).toContain('# tnb-pf-check report');
    expect(md).toContain('- Surcharge months: 1, surcharge RM 3,000.00');
    expect(md).toContain('| Month | Cover | kWh | kVArh lag | kVArh lead | Avg PF | Surcharge | RM | PF with 26.6 kVAr |');
    expect(md).toContain('| 2026-01 | 100% | 74,400.0 | 55,800.0 | 0.0 | 0.8000 | 7.5% | 3,000.00 | 0.9001 |');
    expect(md).toContain('a fixed **26.6 kVAr** bank');
    expect(md).toContain('## Findings (1)');
    expect(md).toMatch(/\| surcharge \| MSB-1 \| 2026-01 \|/);
  });

  it('escapes pipes and honours the limit', () => {
    const rows = parseIntervals('meter,timestamp,kwh,kvarh\na|b,2026-01-01 00:30,10,5\na|b,2026-01-01 01:00,10,5\na|b,2026-01-01 03:00,10,5\n', 'x.csv');
    const md = formatMarkdown(analyze(rows), 0);
    expect(md).toContain('## Meter a\\|b');
    expect(md).toMatch(/more \(use --limit or --json\)/);
  });

  it('says no bank is needed for a good meter', () => {
    const md = formatMarkdown(analyze(parseIntervals(readFileSync(ex('good.csv'), 'utf8'), 'good.csv')));
    expect(md).toContain('no fixed bank needed');
    expect(md).toContain('No findings.');
    expect(md).not.toContain('PF with');
  });
});

describe('cli formats', () => {
  it('--csv and --md keep the exit code', () => {
    const csv = call([ex('factory.csv'), '--csv']);
    expect(csv.code).toBe(1);
    expect(csv.out.split('\n')[0]).toBe(CSV_HEADER.join(','));
    const md = call([ex('factory.csv'), '--md']);
    expect(md.code).toBe(1);
    expect(md.out).toContain('# tnb-pf-check report');
  });

  it('rejects two formats', () => {
    expect(call([ex('factory.csv'), '--csv', '--md']).err).toMatch(/only one of --json, --md, --csv/);
    expect(call([ex('factory.csv'), '--json', '--csv']).code).toBe(2);
    expect(call([ex('factory.csv'), '--md', '--md']).code).toBe(1);
  });
});
