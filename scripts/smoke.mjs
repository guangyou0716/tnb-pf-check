#!/usr/bin/env node
// End-to-end check of the built CLI (dist/cli.js), run directly and through a symlink like an npm bin.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const cli = join(root, 'dist', 'cli.js');
const ex = (n) => join(root, 'examples', n);
const fail = (message) => {
  console.error(`smoke: FAIL ${message}`);
  process.exit(1);
};
const run = (bin, args) => spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

const dir = mkdtempSync(join(tmpdir(), 'tnb-pf-smoke-'));
const link = join(dir, 'tnb-pf-check');
symlinkSync(cli, link);
for (const bin of [cli, link]) {
  const r = run(bin, [ex('factory.csv'), '--charges', ex('charges.csv'), '--json']);
  const d = r.stdout ? JSON.parse(r.stdout) : {};
  if (r.status !== 1 || d.summary?.surchargeRm !== 3000 || d.meters?.[0]?.sizing?.requiredKvar !== 26.6) {
    fail(`example via ${bin}: status ${r.status} ${JSON.stringify(d.summary)} ${r.stderr}`);
  }
}
console.log('smoke: ok example (direct and via symlink): Jan PF 0.80 -> 7.5% = RM 3,000; fixed bank 26.6 kVAr');

// 20 meters x one year of 30-min data = 350,400 rows; meter M7 has a poor PF all year.
const lines = ['meter,timestamp,kwh,kvarh'];
const start = Date.UTC(2026, 0, 1);
for (let m = 0; m < 20; m++) {
  for (let i = 1; i <= 365 * 48; i++) {
    const t = new Date(start + i * 30 * 60_000).toISOString().slice(0, 16).replace('T', ' ');
    const kwh = 40 + (i % 7);
    const kvarh = m === 7 ? kwh * 0.9 : kwh * 0.4;
    lines.push(`M${m},${t},${kwh},${kvarh.toFixed(3)}`);
  }
}
writeFileSync(join(dir, 'year.csv'), lines.join('\n') + '\n');
const t0 = Date.now();
const big = run(cli, [join(dir, 'year.csv'), '--json']);
const bd = big.stdout ? JSON.parse(big.stdout) : {};
const ms = Date.now() - t0;
if (big.status !== 1 || bd.summary?.rows !== 350_400 || bd.summary?.months !== 240 || bd.summary?.surchargeMonths !== 12) {
  fail(`large: status ${big.status} ${JSON.stringify(bd.summary)} ${big.stderr}`);
}
if (bd.findings.some((f) => f.meter !== 'M7' || f.type !== 'surcharge')) fail('large: unexpected findings');
console.log(`smoke: ok large (20 meters x 1 year of 30-min data = 350,400 rows; M7 surcharged 12 months) in ${ms} ms`);
