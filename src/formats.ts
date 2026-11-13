import type { Report } from './analyze.js';
import { hourLabel, profileRows } from './report.js';

/** One CSV cell: quoted when needed; cells starting with = + - @ tab or CR (text, not numbers) get a leading ' so spreadsheets do not run them as formulas. */
export function csvCell(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  let s = v;
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const csvLine = (cells: (string | number | null | undefined)[]) => cells.map(csvCell).join(',');

/** Markdown table cell: backslashes and pipes escaped, line breaks flattened. */
const mdCell = (v: string | number) => String(v).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n|\r/g, ' ');

const mdTable = (head: string[], rows: (string | number)[][], right: boolean[]) => [
  `| ${head.map(mdCell).join(' | ')} |`,
  `| ${right.map((r) => (r ? '---:' : '---')).join(' | ')} |`,
  ...rows.map((r) => `| ${r.map(mdCell).join(' | ')} |`),
];

const r = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;
const fixed = (v: number, d: number) => v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const pct = (v: number) => `${Math.round(v * 1000) / 10}%`;

export const CSV_HEADER = [
  'meter',
  'month',
  'intervals',
  'interval_min',
  'coverage',
  'kwh',
  'kvarh_lagging',
  'kvarh_leading',
  'avg_pf',
  'pf_for_surcharge',
  'minimum_pf',
  'surcharge_percent',
  'charges_rm',
  'surcharge_rm',
  'target_pf',
  'bank_kvar',
  'pf_after_bank',
  'surcharge_percent_after_bank',
];

/** CSV, one row per meter-month, with the fixed bank sized for that meter and the month's PF after it. */
export function formatCsv(report: Report): string {
  const lines = [CSV_HEADER.join(',')];
  for (const m of report.meters) {
    const after = new Map(m.sizing.monthsAfter.map((a) => [a.month, a]));
    for (const x of m.months) {
      const a = after.get(x.month);
      lines.push(
        csvLine([
          m.meter,
          x.month,
          x.intervals,
          m.intervalMinutes,
          r(x.coverage, 4),
          r(x.kwh, 3),
          r(x.kvarhLagging, 3),
          r(x.kvarhLeading, 3),
          x.pf === null ? null : r(x.pf, 6),
          x.pfForSurcharge === null ? null : r(x.pfForSurcharge, 6),
          report.minimumPf,
          r(x.surchargePercent, 4),
          x.chargesRm,
          x.surchargeRm === null ? null : r(x.surchargeRm, 2),
          m.sizing.target,
          m.sizing.requiredKvar,
          a === undefined || a.pf === null ? null : r(a.pf, 6),
          a === undefined ? null : r(a.surchargePercent, 4),
        ]),
      );
    }
  }
  return lines.join('\n') + '\n';
}

/** Markdown report: summary, one month table per meter, capacitor sizing, findings (up to limit). */
export function formatMarkdown(report: Report, limit = 50): string {
  const s = report.summary;
  const out: string[] = ['# tnb-pf-check report', ''];
  out.push(
    `- Meters: ${s.meters}, intervals: ${s.rows}, meter-months: ${s.months}`,
    `- Supply: ${report.supply.toUpperCase()} (minimum PF ${report.minimumPf.toFixed(2)}); timestamps = interval ${report.stamp}`,
    `- Surcharge months: ${s.surchargeMonths}${s.surchargeRm === null ? '' : `, surcharge RM ${fixed(s.surchargeRm, 2)}`}`,
  );
  for (const m of report.meters) {
    out.push('', `## Meter ${mdCell(m.meter)}`, '', `${m.rows} intervals of ${m.intervalMinutes} min, ${m.first} .. ${m.last}`, '');
    const withRm = m.months.some((x) => x.chargesRm !== null);
    const z = m.sizing;
    const after = new Map(z.monthsAfter.map((a) => [a.month, a]));
    const head = ['Month', 'Cover', 'kWh', 'kVArh lag', 'kVArh lead', 'Avg PF', 'Surcharge'];
    if (withRm) head.push('RM');
    if (z.requiredKvar > 0) head.push(`PF with ${fixed(z.requiredKvar, 1)} kVAr`);
    out.push(
      ...mdTable(
        head,
        m.months.map((x) => {
          const row: string[] = [x.month, pct(x.coverage), fixed(x.kwh, 1), fixed(x.kvarhLagging, 1), fixed(x.kvarhLeading, 1), x.pfForSurcharge === null ? '-' : x.pfForSurcharge.toFixed(4), `${r(x.surchargePercent, 4)}%`];
          if (withRm) row.push(x.surchargeRm === null ? '-' : fixed(x.surchargeRm, 2));
          if (z.requiredKvar > 0) {
            const a = after.get(x.month);
            row.push(a === undefined || a.pf === null ? '-' : a.pf.toFixed(4));
          }
          return row;
        }),
        head.map((_, i) => i > 0),
      ),
    );
    out.push('');
    if (z.requiredKvar === 0) {
      out.push(`Capacitor: every month already reaches PF ${z.target.toFixed(2)}; no fixed bank needed (peak lagging ${fixed(z.peakKvar, 1)} kVAr).`);
    } else {
      out.push(`Capacitor: a fixed **${fixed(z.requiredKvar, 1)} kVAr** bank lifts every month to PF >= ${z.target.toFixed(2)} (peak lagging ${fixed(z.peakKvar, 1)} kVAr).`);
      if (z.overCompensatedIntervals > 0) {
        out.push('', `Over-compensation: ${z.overCompensatedIntervals} interval(s), ${fixed(z.addedLeadingKvarh, 1)} kVArh leading at light load; consider an automatic (stepped) bank.`);
      }
    }
    if (m.profile) {
      const { used, below } = profileRows(m.profile);
      out.push('', '### Hour-of-day profile', '', '_Hour of the interval start, all days._', '');
      out.push(
        ...mdTable(
          ['Hour', 'Intervals', 'kWh', 'kVArh lag', 'Avg kW', 'Avg kVAr', 'PF', 'Below minimum'],
          used.map((p) => [hourLabel(p.hour), p.intervals, fixed(p.kwh, 1), fixed(p.kvarhLagging, 1), fixed(p.avgKw, 1), fixed(p.avgKvar, 1), p.pf === null ? '-' : p.pf.toFixed(4), p.belowMinimum ? 'yes' : '']),
          [false, true, true, true, true, true, true, false],
        ),
      );
      out.push('', below.length === 0 ? `No hour is below PF ${report.minimumPf.toFixed(2)}.` : `Below PF ${report.minimumPf.toFixed(2)}: ${below.join(', ')}.`);
    }
  }
  out.push('', `## Findings (${report.findings.length})`, '');
  if (report.findings.length === 0) {
    out.push('No findings.');
  } else {
    out.push(
      ...mdTable(
        ['Type', 'Meter', 'Month', 'Where', 'Message'],
        report.findings.slice(0, limit).map((f) => [f.type, f.meter, f.month ?? '', f.where ?? '', f.message]),
        [false, false, false, false, false],
      ),
    );
    if (report.findings.length > limit) out.push('', `${report.findings.length - limit} more (use --limit or --json).`);
  }
  out.push('', '_Estimate only, not a TNB tool: check the PF and charges on your bill. Surcharge base = RM kWh + RM kW + RM AFA._');
  return out.join('\n') + '\n';
}
