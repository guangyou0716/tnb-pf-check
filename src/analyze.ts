import { InputError } from './errors.js';
import { chargeKey, type Charges, type IntervalRow } from './input.js';
import { averagePf, LIMITS, roundHalfUp, surchargePercent, type Supply } from './tariff.js';
import { formatMinutes, minutesInMonth, monthKey } from './time.js';

export interface AnalyzeOptions {
  supply?: Supply;
  /** Target average PF for capacitor sizing (default 0.90). */
  target?: number;
  /** Round the average PF to this many decimals before the surcharge (default: no rounding). */
  pfRound?: number;
  /** Timestamps mark the interval end (default) or start. */
  stamp?: 'end' | 'start';
  /** Interval length in minutes; inferred per meter (most common step) when not given. */
  intervalMinutes?: number;
  charges?: Charges;
  /** Add an hour-of-day PF profile per meter (hour of the interval start). */
  profile?: boolean;
}

export type FindingType = 'surcharge' | 'duplicate-timestamp' | 'negative-kwh' | 'gap' | 'irregular-step';

export interface Finding {
  type: FindingType;
  meter: string;
  month?: string;
  where?: string;
  message: string;
}

export interface MonthResult {
  month: string;
  intervals: number;
  /** Share of the calendar month covered by intervals (0..1). */
  coverage: number;
  kwh: number;
  kvarhLagging: number;
  kvarhLeading: number;
  /** Average PF (null when the month has no energy). */
  pf: number | null;
  /** PF the surcharge is computed from (rounded when --pf-round is set). */
  pfForSurcharge: number | null;
  surchargePercent: number;
  chargesRm: number | null;
  surchargeRm: number | null;
}

export interface Sizing {
  target: number;
  /** Smallest fixed bank (kVAr, 0.1 steps) that lifts every month to the target. */
  requiredKvar: number;
  /** Largest lagging kVAr seen in any interval (bank that cancels all lagging kVArh). */
  peakKvar: number;
  /** Leading kVArh the bank would add over the data (over-compensation at light load). */
  addedLeadingKvarh: number;
  /** Intervals where the bank would over-compensate. */
  overCompensatedIntervals: number;
  monthsAfter: { month: string; pf: number | null; surchargePercent: number }[];
}

export interface HourProfile {
  /** Hour of day 0..23 of the interval start (local wall clock). */
  hour: number;
  intervals: number;
  kwh: number;
  kvarhLagging: number;
  /** PF of the energy in this hour over all days (null when no energy). */
  pf: number | null;
  /** Mean kW and mean lagging kVAr over the intervals in this hour. */
  avgKw: number;
  avgKvar: number;
  /** PF below the supply minimum (the hours that drag the monthly average down). */
  belowMinimum: boolean;
}

export interface MeterResult {
  meter: string;
  intervalMinutes: number;
  rows: number;
  first: string;
  last: string;
  months: MonthResult[];
  sizing: Sizing;
  /** Present only with the profile option: 24 rows, hour 0..23. */
  profile?: HourProfile[];
}

export interface Report {
  supply: Supply;
  minimumPf: number;
  stamp: 'end' | 'start';
  meters: MeterResult[];
  findings: Finding[];
  summary: {
    meters: number;
    rows: number;
    months: number;
    surchargeMonths: number;
    surchargeRm: number | null;
  };
}

interface Interval {
  kwh: number;
  lag: number;
  lead: number;
  month: number;
}

const round = (value: number, digits: number) => {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
};

function inferInterval(stamps: number[], meter: string): number {
  const counts = new Map<number, number>();
  for (let i = 1; i < stamps.length; i++) {
    const d = stamps[i] - stamps[i - 1];
    if (d > 0) {
      counts.set(d, (counts.get(d) ?? 0) + 1);
    }
  }
  let best = 0;
  let bestCount = 0;
  for (const [d, c] of counts) {
    if (c > bestCount || (c === bestCount && d < best)) {
      best = d;
      bestCount = c;
    }
  }
  if (best === 0) {
    throw new InputError(`meter ${meter}: cannot infer the interval length from one timestamp; pass --interval.`);
  }
  return best;
}

function monthsAfterBank(intervals: Interval[], months: MonthResult[], kvar: number, intervalMinutes: number) {
  const supplied = (kvar * intervalMinutes) / 60;
  const lag = new Array<number>(months.length).fill(0);
  let added = 0;
  let over = 0;
  for (const iv of intervals) {
    const left = iv.lag - supplied;
    if (left > 0) {
      lag[iv.month] += left;
    } else if (left < 0) {
      added += -left;
      over++;
    }
  }
  return { lag, added, over };
}

function sizeBank(intervals: Interval[], months: MonthResult[], intervalMinutes: number, target: number, supply: Supply, pfRound: number | undefined): Sizing {
  const hours = intervalMinutes / 60;
  let peak = 0;
  for (const iv of intervals) {
    peak = Math.max(peak, iv.lag / hours);
  }
  const ok = (kvar: number) => {
    const { lag } = monthsAfterBank(intervals, months, kvar, intervalMinutes);
    return months.every((m, i) => {
      const pf = averagePf(m.kwh, lag[i]);
      return pf === null || pf >= target - 1e-12;
    });
  };
  let required = 0;
  if (!ok(0)) {
    let lo = 0;
    let hi = peak;
    for (let i = 0; i < 60 && hi - lo > 1e-6; i++) {
      const mid = (lo + hi) / 2;
      if (ok(mid)) hi = mid;
      else lo = mid;
    }
    required = Math.ceil(round(hi * 10, 6)) / 10;
    // A month with energy but no kWh can never reach the target; cap at the peak bank.
    if (!ok(required)) {
      required = Math.ceil(round(peak * 10, 6)) / 10;
    }
  }
  const after = monthsAfterBank(intervals, months, required, intervalMinutes);
  return {
    target,
    requiredKvar: required,
    peakKvar: round(peak, 3),
    addedLeadingKvarh: round(after.added, 3),
    overCompensatedIntervals: after.over,
    monthsAfter: months.map((m, i) => {
      const pf = averagePf(m.kwh, after.lag[i]);
      const used = pf === null ? null : pfRound === undefined ? pf : roundHalfUp(pf, pfRound);
      return { month: m.month, pf: pf === null ? null : round(pf, 4), surchargePercent: used === null ? 0 : surchargePercent(used, supply) };
    }),
  };
}

function hourProfile(hours: { intervals: number; kwh: number; lag: number }[], step: number, supply: Supply): HourProfile[] {
  const h = step / 60;
  return hours.map((x, hour) => {
    const pf = averagePf(x.kwh, x.lag);
    return {
      hour,
      intervals: x.intervals,
      kwh: round(x.kwh, 3),
      kvarhLagging: round(x.lag, 3),
      pf: pf === null ? null : round(pf, 4),
      avgKw: x.intervals === 0 ? 0 : round(x.kwh / (x.intervals * h), 3),
      avgKvar: x.intervals === 0 ? 0 : round(x.lag / (x.intervals * h), 3),
      belowMinimum: pf !== null && pf < LIMITS[supply].minimum,
    };
  });
}

export function analyze(rows: IntervalRow[], options: AnalyzeOptions = {}): Report {
  const supply = options.supply ?? 'lv';
  const target = options.target ?? 0.9;
  const stamp = options.stamp ?? 'end';
  if (!(target > 0 && target <= 1)) {
    throw new InputError('--target must be above 0 and at most 1.');
  }
  if (options.intervalMinutes !== undefined && !(Number.isInteger(options.intervalMinutes) && options.intervalMinutes >= 1 && options.intervalMinutes <= 1440)) {
    throw new InputError('--interval must be a whole number of minutes from 1 to 1440.');
  }
  if (rows.length === 0) {
    throw new InputError('no interval rows.');
  }
  const findings: Finding[] = [];
  const byMeter = new Map<string, IntervalRow[]>();
  for (const row of rows) {
    let list = byMeter.get(row.meter);
    if (!list) {
      list = [];
      byMeter.set(row.meter, list);
    }
    list.push(row);
  }
  const meters: MeterResult[] = [];
  let surchargeRm: number | null = null;
  for (const [meter, list] of [...byMeter].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    const sorted = list.map((r, i) => ({ r, i })).sort((a, b) => a.r.stamp - b.r.stamp || a.i - b.i).map((x) => x.r);
    const unique: IntervalRow[] = [];
    for (const row of sorted) {
      const prev = unique[unique.length - 1];
      if (prev && prev.stamp === row.stamp) {
        findings.push({ type: 'duplicate-timestamp', meter, where: row.where, message: `${formatMinutes(row.stamp)} already read at ${prev.where}; this row is ignored.` });
        continue;
      }
      unique.push(row);
    }
    const step = options.intervalMinutes ?? inferInterval(unique.map((r) => r.stamp), meter);
    const monthIndex = new Map<string, number>();
    const months: MonthResult[] = [];
    const intervals: Interval[] = [];
    const hours = options.profile ? Array.from({ length: 24 }, () => ({ intervals: 0, kwh: 0, lag: 0 })) : null;
    for (let i = 0; i < unique.length; i++) {
      const row = unique[i];
      if (i > 0) {
        const d = row.stamp - unique[i - 1].stamp;
        if (d > step && d % step === 0) {
          findings.push({ type: 'gap', meter, where: row.where, message: `${d / step - 1} interval(s) missing between ${formatMinutes(unique[i - 1].stamp)} and ${formatMinutes(row.stamp)}.` });
        } else if (d !== step) {
          findings.push({ type: 'irregular-step', meter, where: row.where, message: `${d} min after ${formatMinutes(unique[i - 1].stamp)} (interval is ${step} min).` });
        }
      }
      let kwh = row.kwh;
      if (kwh < 0) {
        findings.push({ type: 'negative-kwh', meter, where: row.where, message: `kWh ${row.kwh} at ${formatMinutes(row.stamp)} (export?) is counted as 0.` });
        kwh = 0;
      }
      const start = stamp === 'end' ? row.stamp - step : row.stamp;
      const key = monthKey(start);
      let mi = monthIndex.get(key);
      if (mi === undefined) {
        mi = months.length;
        monthIndex.set(key, mi);
        months.push({ month: key, intervals: 0, coverage: 0, kwh: 0, kvarhLagging: 0, kvarhLeading: 0, pf: null, pfForSurcharge: null, surchargePercent: 0, chargesRm: null, surchargeRm: null });
      }
      const m = months[mi];
      const lag = row.kvarh > 0 ? row.kvarh : 0;
      const lead = row.kvarh < 0 ? -row.kvarh : 0;
      m.intervals++;
      m.kwh += kwh;
      m.kvarhLagging += lag;
      m.kvarhLeading += lead;
      intervals.push({ kwh, lag, lead, month: mi });
      if (hours) {
        const h = hours[Math.floor((((start % 1440) + 1440) % 1440) / 60)];
        h.intervals++;
        h.kwh += kwh;
        h.lag += lag;
      }
    }
    for (const m of months) {
      m.coverage = round((m.intervals * step) / minutesInMonth(m.month), 4);
      const pf = averagePf(m.kwh, m.kvarhLagging);
      m.pf = pf === null ? null : round(pf, 4);
      m.pfForSurcharge = pf === null ? null : options.pfRound === undefined ? round(pf, 4) : roundHalfUp(pf, options.pfRound);
      // Surcharge from the unrounded PF unless --pf-round is set.
      const used = pf === null ? null : options.pfRound === undefined ? pf : roundHalfUp(pf, options.pfRound);
      m.surchargePercent = used === null ? 0 : surchargePercent(used, supply);
      const charges = options.charges?.get(chargeKey(meter, m.month)) ?? options.charges?.get(chargeKey(null, m.month));
      if (charges !== undefined) {
        m.chargesRm = charges;
        m.surchargeRm = round((charges * m.surchargePercent) / 100, 2);
        surchargeRm = round((surchargeRm ?? 0) + m.surchargeRm, 2);
      }
      m.kwh = round(m.kwh, 3);
      m.kvarhLagging = round(m.kvarhLagging, 3);
      m.kvarhLeading = round(m.kvarhLeading, 3);
      if (m.surchargePercent > 0) {
        const rm = m.surchargeRm === null ? '' : ` = RM ${m.surchargeRm.toFixed(2)} on RM ${m.chargesRm!.toFixed(2)}`;
        findings.push({ type: 'surcharge', meter, month: m.month, message: `average PF ${m.pfForSurcharge!.toFixed(4)} is below ${LIMITS[supply].minimum.toFixed(2)}: surcharge ${m.surchargePercent}%${rm}.` });
      }
    }
    meters.push({
      meter,
      intervalMinutes: step,
      rows: unique.length,
      first: formatMinutes(unique[0].stamp),
      last: formatMinutes(unique[unique.length - 1].stamp),
      months,
      sizing: sizeBank(intervals, months, step, target, supply, options.pfRound),
      ...(hours ? { profile: hourProfile(hours, step, supply) } : {}),
    });
  }
  const order: FindingType[] = ['surcharge', 'gap', 'irregular-step', 'duplicate-timestamp', 'negative-kwh'];
  findings.sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type));
  return {
    supply,
    minimumPf: LIMITS[supply].minimum,
    stamp,
    meters,
    findings,
    summary: {
      meters: meters.length,
      rows: meters.reduce((n, m) => n + m.rows, 0),
      months: meters.reduce((n, m) => n + m.months.length, 0),
      surchargeMonths: findings.filter((f) => f.type === 'surcharge').length,
      surchargeRm,
    },
  };
}
