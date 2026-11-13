import type { Report } from './analyze.js';

const num = (v: number, d: number) => v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const pct = (v: number) => `${Math.round(v * 1000) / 10}%`;

function table(head: string[], rows: string[][]): string[] {
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (r: string[]) => r.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join('  ').trimEnd();
  return [line(head), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)];
}

export function formatText(report: Report, limit = 50): string {
  const out: string[] = [];
  const s = report.summary;
  out.push(
    `tnb-pf-check: ${s.meters} meter(s), ${s.rows} intervals, ${s.months} meter-month(s); supply ${report.supply.toUpperCase()} (minimum PF ${report.minimumPf.toFixed(2)}); timestamps = interval ${report.stamp}`,
  );
  out.push(`Surcharge months: ${s.surchargeMonths}${s.surchargeRm === null ? '' : `, surcharge RM ${num(s.surchargeRm, 2)}`}`);
  for (const m of report.meters) {
    out.push('', `Meter ${m.meter}: ${m.rows} intervals of ${m.intervalMinutes} min, ${m.first} .. ${m.last}`);
    const withRm = m.months.some((x) => x.chargesRm !== null);
    const head = ['Month', 'Cover', 'kWh', 'kVArh lag', 'kVArh lead', 'Avg PF', 'Surcharge'];
    if (withRm) head.push('RM');
    out.push(
      ...table(
        head,
        m.months.map((x) => {
          const row = [x.month, pct(x.coverage), num(x.kwh, 1), num(x.kvarhLagging, 1), num(x.kvarhLeading, 1), x.pfForSurcharge === null ? '-' : x.pfForSurcharge.toFixed(4), `${x.surchargePercent}%`];
          if (withRm) row.push(x.surchargeRm === null ? '-' : num(x.surchargeRm, 2));
          return row;
        }),
      ),
    );
    const z = m.sizing;
    if (z.requiredKvar === 0) {
      out.push(`Capacitor: every month already reaches PF ${z.target.toFixed(2)}; no fixed bank needed (peak lagging ${num(z.peakKvar, 1)} kVAr).`);
    } else {
      out.push(
        `Capacitor: a fixed ${num(z.requiredKvar, 1)} kVAr bank lifts every month to PF >= ${z.target.toFixed(2)} (peak lagging ${num(z.peakKvar, 1)} kVAr).`,
        `  After: ${z.monthsAfter.map((a) => `${a.month} ${a.pf === null ? '-' : a.pf.toFixed(4)}`).join(', ')}`,
      );
      if (z.overCompensatedIntervals > 0) {
        out.push(`  Over-compensation: ${z.overCompensatedIntervals} interval(s), ${num(z.addedLeadingKvarh, 1)} kVArh leading at light load; consider an automatic (stepped) bank.`);
      }
    }
  }
  out.push('');
  if (report.findings.length === 0) {
    out.push('No findings.');
  } else {
    out.push(`Findings (${report.findings.length}):`);
    for (const f of report.findings.slice(0, limit)) {
      out.push(`  [${f.type}] ${f.meter}${f.month ? ` ${f.month}` : ''}${f.where ? ` ${f.where}` : ''}: ${f.message}`);
    }
    if (report.findings.length > limit) {
      out.push(`  ... ${report.findings.length - limit} more (use --limit or --json).`);
    }
  }
  out.push('', 'Estimate only, not a TNB tool: check the PF and charges on your bill. Surcharge base = RM kWh + RM kW + RM AFA.');
  return out.join('\n') + '\n';
}
