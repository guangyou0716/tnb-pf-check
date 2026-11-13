#!/usr/bin/env node
// Writes examples/factory.csv: one meter, 30-min intervals (stamped at the interval end), Jan + Feb 2026.
// Every interval 50 kWh. Day intervals (start 08:00-19:30): Jan 55 kVArh, Feb 45. Night: Jan 20, Feb 15.
// Jan average PF = 2400 / hypot(2400, 1800) = 0.80 exactly; Feb = 2400 / hypot(2400, 1440) = 0.8575.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const out = ['meter,timestamp,kwh,kvarh'];
const start = Date.UTC(2026, 0, 1);
const end = Date.UTC(2026, 2, 1);
for (let t = start; t < end; t += 30 * 60_000) {
  const d = new Date(t);
  const day = d.getUTCHours() >= 8 && d.getUTCHours() < 20;
  const jan = d.getUTCMonth() === 0;
  const kvarh = day ? (jan ? 55 : 45) : jan ? 20 : 15;
  const stamp = new Date(t + 30 * 60_000).toISOString().slice(0, 16).replace('T', ' ');
  out.push(`MSB-1,${stamp},50,${kvarh}`);
}
writeFileSync(fileURLToPath(new URL('../examples/factory.csv', import.meta.url)), out.join('\n') + '\n');
