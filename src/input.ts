import { parseCsv } from './csv.js';
import { InputError } from './errors.js';
import { parseTimestamp } from './time.js';

export interface ColumnOptions {
  timeColumn?: string;
  kwhColumn?: string;
  kvarhColumn?: string;
  /** Meter column; when not given, a column named "meter" is used if present, else everything is one meter. */
  meterColumn?: string;
}

/** One interval row as read: energy in the interval (not a cumulative register). */
export interface IntervalRow {
  meter: string;
  /** Timestamp as written, in wall-clock minutes. */
  stamp: number;
  kwh: number;
  /** Signed: positive = lagging (inductive), negative = leading (capacitive). */
  kvarh: number;
  /** "file:line" for findings. */
  where: string;
}

export const DEFAULT_METER = '(all)';

function findColumn(header: string[], name: string, file: string, flag: string): number {
  const want = name.trim().toLowerCase();
  const index = header.findIndex((h) => h.trim().toLowerCase() === want);
  if (index < 0) {
    throw new InputError(`${file}: no "${name}" column (header: ${header.join(', ')}); set it with ${flag}.`);
  }
  return index;
}

export function parseNumber(raw: string, where: string, what: string): number {
  const text = raw.trim();
  if (text === '' || !/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(text)) {
    throw new InputError(`${where}: ${what} "${raw}" is not a number.`);
  }
  return Number(text);
}

/** Reads one interval CSV (header row required). */
export function parseIntervals(text: string, file: string, options: ColumnOptions = {}): IntervalRow[] {
  const rows = parseCsv(text);
  if (rows.length === 0) {
    throw new InputError(`${file}: empty file.`);
  }
  const header = rows[0];
  const t = findColumn(header, options.timeColumn ?? 'timestamp', file, '--time-column');
  const p = findColumn(header, options.kwhColumn ?? 'kwh', file, '--kwh-column');
  const q = findColumn(header, options.kvarhColumn ?? 'kvarh', file, '--kvarh-column');
  let m = -1;
  if (options.meterColumn !== undefined) {
    m = findColumn(header, options.meterColumn, file, '--meter-column');
  } else {
    m = header.findIndex((h) => h.trim().toLowerCase() === 'meter');
  }
  const out: IntervalRow[] = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const where = `${file}:${i + 1}`;
    const need = Math.max(t, p, q, m);
    if (row.length <= need) {
      throw new InputError(`${where}: expected at least ${need + 1} fields, got ${row.length}.`);
    }
    const meter = m >= 0 ? row[m].trim() : DEFAULT_METER;
    if (meter === '') {
      throw new InputError(`${where}: empty meter.`);
    }
    out.push({
      meter,
      stamp: parseTimestamp(row[t], where),
      kwh: parseNumber(row[p], where, 'kWh'),
      kvarh: parseNumber(row[q], where, 'kVArh'),
      where,
    });
  }
  return out;
}

/** Bill charges that the surcharge applies to (RM kWh + RM kW + RM AFA), per month and optionally per meter. */
export type Charges = Map<string, number>;

export const chargeKey = (meter: string | null, month: string) => `${meter ?? '*'}|${month}`;

/** Reads a charges CSV: month (YYYY-MM), rm, optional meter. */
export function parseCharges(text: string, file: string): Charges {
  const rows = parseCsv(text);
  if (rows.length === 0) {
    throw new InputError(`${file}: empty file.`);
  }
  const header = rows[0];
  const mo = findColumn(header, 'month', file, 'a "month" header');
  const rm = findColumn(header, 'rm', file, 'an "rm" header');
  const me = header.findIndex((h) => h.trim().toLowerCase() === 'meter');
  const charges: Charges = new Map();
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const where = `${file}:${i + 1}`;
    if (row.length <= Math.max(mo, rm, me)) {
      throw new InputError(`${where}: missing fields.`);
    }
    const month = row[mo].trim();
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      throw new InputError(`${where}: month "${row[mo]}" is not YYYY-MM.`);
    }
    const amount = parseNumber(row[rm], where, 'RM amount');
    if (amount < 0) {
      throw new InputError(`${where}: RM amount must not be negative.`);
    }
    const meter = me >= 0 && row[me].trim() !== '' ? row[me].trim() : null;
    const key = chargeKey(meter, month);
    if (charges.has(key)) {
      throw new InputError(`${where}: charges for ${meter ?? 'all meters'} ${month} given twice.`);
    }
    charges.set(key, amount);
  }
  return charges;
}
