import type { ApfcSizing, HourProfile, MeterResult, Report } from './analyze.js';

const num = (v: number, d: number) => v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const pct = (v: number) => `${Math.round(v * 1000) / 10}%`;

function table(head: string[], rows: string[][]): string[] {
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (r: string[]) => r.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join('  ').trimEnd();
  return [line(head), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)];
}

const hh = (h: number) => `${String(h).padStart(2, '0')}:00`;
export const hourLabel = (h: number) => `${hh(h)}-${hh(h + 1)}`;

/** Hours with data (for the profile tables) and the below-minimum hours as merged ranges ("08:00-20:00"). */
export function profileRows(profile: HourProfile[]) {
  const used = profile.filter((p) => p.intervals > 0);
  const below: string[] = [];
  let from = -1;
  for (let h = 0; h <= 24; h++) {
    const low = h < 24 && profile[h]?.belowMinimum === true;
    if (low && from < 0) from = h;
    if (!low && from >= 0) {
      below.push(`${hh(from)}-${hh(h)}`);
      from = -1;
    }
  }
  return { used, below };
}

/** The profile tables to print for a meter: all days, then weekdays / weekend with --profile-split. */
export function profileSections(m: MeterResult): { label: string; rows: HourProfile[] }[] {
  const out: { label: string; rows: HourProfile[] }[] = [];
  if (m.profile) out.push({ label: 'all days', rows: m.profile });
  if (m.profileWeekday) out.push({ label: 'weekdays Mon-Fri', rows: m.profileWeekday });
  if (m.profileWeekend) out.push({ label: 'weekend Sat-Sun', rows: m.profileWeekend });
  return out;
}

/** One-paragraph APFC result, shared by text and Markdown (bold marks the installed size in Markdown). */
export function apfcLines(a: ApfcSizing, bold = false): string[] {
  const b = (t: string) => (bold ? `**${t}**` : t);
  const kv = (v: number) => v.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 3 });
  const after = `After: ${a.monthsAfter.map((x) => `${x.month} ${x.pf === null ? '-' : x.pf.toFixed(4)}`).join(', ')}`;
  if (a.steps === 0 && a.targetMet) {
    return [`APFC (${kv(a.stepKvar)} kVAr steps): no steps needed, every month already reaches PF ${a.target.toFixed(2)}.`];
  }
  if (!a.targetMet && a.steps === 0) {
    return [`APFC (${kv(a.stepKvar)} kVAr steps): one step is more than the lagging kVAr of any interval, so it would never switch in; use a smaller step.`];
  }
  if (!a.targetMet) {
    return [
      `APFC (${kv(a.stepKvar)} kVAr steps): even ${a.steps} step(s) (${kv(a.installedKvar)} kVAr, all the load can use without leading) leave a month below PF ${a.target.toFixed(2)}; use a smaller step.`,
      `  ${after}`,
    ];
  }
  return [
    `APFC: ${b(`${a.steps} x ${kv(a.stepKvar)} kVAr = ${kv(a.installedKvar)} kVAr`)} lifts every month to PF >= ${a.target.toFixed(2)} with no leading kVArh (mean ${num(a.avgStepsOn, 1)} step(s) in service, all steps in ${a.fullIntervals} interval(s)).`,
    `  ${after}`,
  ];
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
    if (m.apfc) out.push(...apfcLines(m.apfc));
    for (const sec of profileSections(m)) {
      const { used, below } = profileRows(sec.rows);
      out.push('', `Hour-of-day profile (interval start, ${sec.label}):`);
      if (used.length === 0) {
        out.push('  No intervals.');
        continue;
      }
      out.push(
        ...table(
          ['Hour', 'Intervals', 'kWh', 'kVArh lag', 'Avg kW', 'Avg kVAr', 'PF', ''],
          used.map((p) => [hourLabel(p.hour), String(p.intervals), num(p.kwh, 1), num(p.kvarhLagging, 1), num(p.avgKw, 1), num(p.avgKvar, 1), p.pf === null ? '-' : p.pf.toFixed(4), p.belowMinimum ? 'low' : '']),
        ),
      );
      out.push(below.length === 0 ? `  No hour is below PF ${report.minimumPf.toFixed(2)}.` : `  Below PF ${report.minimumPf.toFixed(2)}: ${below.join(', ')}.`);
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
