#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { analyze, type AnalyzeOptions } from './analyze.js';
import { InputError } from './errors.js';
import { parseCharges, parseIntervals, type ColumnOptions, type IntervalRow } from './input.js';
import { formatCsv, formatMarkdown } from './formats.js';
import { formatText } from './report.js';

export const VERSION = '0.1.0';

const HELP = `tnb-pf-check ${VERSION}
Monthly average power factor, TNB power factor surcharge and fixed capacitor sizing from interval data.

Usage: tnb-pf-check <intervals.csv>... [options]

Interval CSV: header with timestamp, kwh, kvarh (energy per interval; kvarh < 0 = leading) and an optional
meter column. Timestamps are local time: "YYYY-MM-DD HH:MM" or "DD/MM/YYYY HH:MM".

Options:
  --supply lv|hv        lv = below 132 kV, minimum PF 0.85 (default); hv = 132 kV and above, 0.90
  --target <pf>         target PF for capacitor sizing (default 0.90)
  --pf-round <digits>   round the average PF before the surcharge (e.g. 2); default: not rounded
  --charges <file>      CSV month,rm[,meter]: RM kWh + RM kW + RM AFA per month, to price the surcharge
  --stamp end|start     timestamps mark the interval end (default) or start
  --interval <min>      interval length in minutes (default: inferred per meter)
  --time-column <name>  default "timestamp"
  --kwh-column <name>   default "kwh"
  --kvarh-column <name> default "kvarh"
  --meter-column <name> default "meter" when present
  --profile             hour-of-day PF profile per meter (text / Markdown / JSON; not in --csv)
  --profile-split       also split that profile into weekdays (Mon-Fri) and weekend (Sat-Sun); implies --profile
  --apfc-step <kvar>    also size an automatic (APFC) bank of equal steps of this kVAr (text / Markdown / JSON)
  --limit <n>           findings shown in text / Markdown output (default 50)
  --json                JSON output
  --md                  Markdown report (summary, month tables, sizing, findings)
  --csv                 CSV, one row per meter-month (incl. PF after the sized bank)
  -h, --help, --version

Exit: 0 no findings, 1 findings (surcharge months or data issues), 2 input error.`;

interface Parsed {
  files: string[];
  columns: ColumnOptions;
  analyze: AnalyzeOptions;
  chargesFile?: string;
  format: 'text' | 'json' | 'md' | 'csv';
  limit: number;
}

function numberFlag(flag: string, value: string): number {
  const n = Number(value);
  if (value.trim() === '' || !Number.isFinite(n)) {
    throw new InputError(`${flag} needs a number, got "${value}".`);
  }
  return n;
}

export function parseArgs(argv: string[]): Parsed | 'help' | 'version' {
  const p: Parsed = { files: [], columns: {}, analyze: {}, format: 'text', limit: 50 };
  const setFormat = (f: Parsed['format']) => {
    if (p.format !== 'text' && p.format !== f) throw new InputError('use only one of --json, --md, --csv.');
    p.format = f;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new InputError(`${arg} needs a value.`);
      return v;
    };
    switch (arg) {
      case '-h':
      case '--help':
        return 'help';
      case '--version':
        return 'version';
      case '--json':
        setFormat('json');
        break;
      case '--md':
        setFormat('md');
        break;
      case '--csv':
        setFormat('csv');
        break;
      case '--supply': {
        const v = value();
        if (v !== 'lv' && v !== 'hv') throw new InputError('--supply must be lv or hv.');
        p.analyze.supply = v;
        break;
      }
      case '--target':
        p.analyze.target = numberFlag(arg, value());
        break;
      case '--pf-round': {
        const n = numberFlag(arg, value());
        if (!Number.isInteger(n) || n < 1 || n > 4) throw new InputError('--pf-round must be 1 to 4.');
        p.analyze.pfRound = n;
        break;
      }
      case '--charges':
        p.chargesFile = value();
        break;
      case '--stamp': {
        const v = value();
        if (v !== 'end' && v !== 'start') throw new InputError('--stamp must be end or start.');
        p.analyze.stamp = v;
        break;
      }
      case '--interval':
        p.analyze.intervalMinutes = numberFlag(arg, value());
        break;
      case '--time-column':
        p.columns.timeColumn = value();
        break;
      case '--kwh-column':
        p.columns.kwhColumn = value();
        break;
      case '--kvarh-column':
        p.columns.kvarhColumn = value();
        break;
      case '--meter-column':
        p.columns.meterColumn = value();
        break;
      case '--profile':
        p.analyze.profile = true;
        break;
      case '--profile-split':
        p.analyze.profileSplit = true;
        break;
      case '--apfc-step':
        p.analyze.apfcStepKvar = numberFlag(arg, value());
        break;
      case '--limit': {
        const n = numberFlag(arg, value());
        if (!Number.isInteger(n) || n < 0) throw new InputError('--limit must be a whole number >= 0.');
        p.limit = n;
        break;
      }
      default:
        if (arg.startsWith('-') && arg !== '-') throw new InputError(`unknown option ${arg} (see --help).`);
        p.files.push(arg);
    }
  }
  if (p.files.length === 0) throw new InputError('give at least one interval CSV (see --help).');
  return p;
}

const read = (file: string) => {
  try {
    return readFileSync(file === '-' ? 0 : file, 'utf8');
  } catch (e) {
    throw new InputError(`cannot read ${file}: ${(e as Error).message}`);
  }
};

export function run(argv: string[], out: (s: string) => void, err: (s: string) => void): number {
  try {
    const p = parseArgs(argv);
    if (p === 'help') {
      out(HELP + '\n');
      return 0;
    }
    if (p === 'version') {
      out(VERSION + '\n');
      return 0;
    }
    const rows: IntervalRow[] = [];
    for (const file of p.files) {
      for (const row of parseIntervals(read(file), file, p.columns)) rows.push(row);
    }
    if (p.chargesFile) p.analyze.charges = parseCharges(read(p.chargesFile), p.chargesFile);
    const report = analyze(rows, p.analyze);
    out(
      p.format === 'json'
        ? JSON.stringify(report, null, 2) + '\n'
        : p.format === 'md'
          ? formatMarkdown(report, p.limit)
          : p.format === 'csv'
            ? formatCsv(report)
            : formatText(report, p.limit),
    );
    return report.findings.length > 0 ? 1 : 0;
  } catch (e) {
    if (e instanceof InputError) {
      err(`tnb-pf-check: ${e.message}\n`);
      return 2;
    }
    throw e;
  }
}

const isMain = (() => {
  try {
    return process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isMain) {
  process.exitCode = run(process.argv.slice(2), (s) => process.stdout.write(s), (s) => process.stderr.write(s));
}
