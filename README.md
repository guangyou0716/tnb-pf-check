# tnb-pf-check

Offline CLI (and TypeScript library) that reads **interval kWh / kVArh load-profile data** from a meter and shows,
per meter and calendar month:

- the **average power factor** the way TNB defines it: cos(atan(total kVArh / total kWh)) for the month;
- whether the month would get a **TNB power factor surcharge**, how many percent, and the RM amount when you give
  the month's charges;
- the smallest **fixed capacitor bank** (kVAr) that would lift every month to a target PF, simulated interval by
  interval on your own profile, with a warning when the bank would over-compensate at light load.

It also flags data problems: duplicate timestamps, gaps, irregular steps and negative kWh.

No runtime dependencies, no network, reads local CSV files only. **Estimate only, not a TNB tool**: always check
the PF and charges on your bill.

## TNB rule used

From the TNB tariff booklet (section 2.9, "Power factor") and tnb.com.my *Commercial & Industrial > Charges &
Penalties*:

| Supply (`--supply`) | Minimum PF | Surcharge |
| --- | --- | --- |
| `lv` (default): below 132 kV | 0.85 | 1.5% of the bill per 0.01 below 0.85 down to 0.75, plus 3% per 0.01 below 0.75 |
| `hv`: 132 kV and above, special contract | 0.90 | 1.5% per 0.01 below 0.90 down to 0.80, plus 3% per 0.01 below 0.80 |

Examples (`lv`): PF 0.80 -> 7.5%, 0.78 -> 10.5%, 0.70 -> 30%. The surcharge base is the month's
**RM kWh + RM kW + RM AFA** charges. The tool uses the unrounded PF by default (TNB's web formula
`[(0.85 - PF) / 0.01] x 1.5%`); pass `--pf-round 2` if your bill rounds the PF to two decimals first.
Domestic and street-light tariffs are not surcharged; this tool does not check your tariff category.

## Install / build

```sh
npm ci
npm run build
node dist/cli.js --help
```

Node 20 or newer.

## Input

Interval CSV with a header row. Each row is the energy **in that interval** (not a cumulative register):

```csv
meter,timestamp,kwh,kvarh
MSB-1,2026-01-01 00:30,50,20
MSB-1,2026-01-01 01:00,50,20
```

- `timestamp`: local time, `YYYY-MM-DD HH:MM` (or `T`) or day-first `DD/MM/YYYY HH:MM`. No time zone (a UTC
  export would be off by 8 hours, so zones are refused). `24:00` is accepted. By default a timestamp marks the
  **end** of its interval (so `2026-02-01 00:00` belongs to January); use `--stamp start` otherwise.
- `kvarh`: positive = lagging (inductive). Negative values are counted as **leading** kVArh, reported separately
  and not netted against lagging.
- `meter` (optional): several meters in one file; without it everything is one meter. Several files are read
  together.
- Column names are case-insensitive and can be changed with `--time-column`, `--kwh-column`, `--kvarh-column`,
  `--meter-column`. Extra columns are ignored.

The interval length is inferred per meter (most common step); set it with `--interval <minutes>` for a meter
with a single row.

Optional `--charges charges.csv`: `month,rm[,meter]` - the month's RM kWh + RM kW + RM AFA. A row with a meter
wins over a row without one.

## Usage

```sh
node dist/cli.js examples/factory.csv --charges examples/charges.csv
```

```text
tnb-pf-check: 1 meter(s), 2832 intervals, 2 meter-month(s); supply LV (minimum PF 0.85); timestamps = interval end
Surcharge months: 1, surcharge RM 3,000.00

Meter MSB-1: 2832 intervals of 30 min, 2026-01-01 00:30 .. 2026-03-01 00:00
Month    Cover       kWh  kVArh lag  kVArh lead  Avg PF  Surcharge        RM
-------  -----  --------  ---------  ----------  ------  ---------  --------
2026-01   100%  74,400.0   55,800.0         0.0  0.8000       7.5%  3,000.00
2026-02   100%  67,200.0   40,320.0         0.0  0.8575         0%      0.00
Capacitor: a fixed 26.6 kVAr bank lifts every month to PF >= 0.90 (peak lagging 110.0 kVAr).
  After: 2026-01 0.9001, 2026-02 0.9485

Findings (1):
  [surcharge] MSB-1 2026-01: average PF 0.8000 is below 0.85: surcharge 7.5% = RM 3000.00 on RM 40000.00.
```

The example is synthetic (made by `scripts/make-example.mjs`) and hand-checkable: every 30-min interval is
50 kWh; January has 55 kVArh in the day and 20 at night, so 2,400 kWh and 1,800 kVArh a day = PF 0.80 exactly.

Options: `--supply lv|hv`, `--target <pf>` (sizing target, default 0.90), `--pf-round <digits>`,
`--charges <file>`, `--stamp end|start`, `--interval <min>`, column names, `--limit <n>` (findings in text /
Markdown output), and one output format: `--json`, `--md` (Markdown report with a "PF with N kVAr" column) or
`--csv` (one row per meter-month: energy, average PF, surcharge %, RM, sized bank, PF and surcharge after it;
text cells starting with `= + - @` get a leading `'` so spreadsheets do not run them as formulas).

`--profile` adds an hour-of-day table per meter (text, Markdown and JSON `meters[].profile`; not in `--csv`):
kWh, lagging kVArh, mean kW / kVAr and PF of each hour (by interval start, over all days), with the hours below
the supply minimum merged into ranges, e.g. for the example:

```text
08:00-09:00        118  5,900.0    5,930.0   100.0     100.5  0.7053  low
...
  Below PF 0.85: 08:00-20:00.
```

This shows when the PF is poor (and what kVAr is drawn then), which helps decide between a fixed bank, a
stepped (APFC) bank or switching a bank with the day shift.

`--profile-split` (implies `--profile`) adds the same table twice more: over weekdays (Mon-Fri) and over the
weekend (Sat-Sun), by the day of the interval start (JSON `meters[].profileWeekday` / `profileWeekend`). A
plant that runs a weekday day shift often has a poor PF only on weekdays; this shows whether the weekend needs
the bank at all. Public holidays are not known and count as their weekday.

Exit codes: `0` no findings, `1` findings (a surcharge month or a data issue), `2` input error.

### Capacitor sizing

A fixed bank of Q kVAr is assumed connected all the time and supplies Q x interval-hours kVArh in every interval.
Where that is more than the interval's lagging kVArh the rest becomes leading kVArh (over-compensation, shown as
a warning: an automatic stepped bank avoids it). The tool searches for the smallest Q (0.1 kVAr steps) that
brings every month's average PF to `--target`; `peakKvar` is the largest lagging kVAr in any interval. This is
a first estimate for discussion with your electrical contractor, not a design: it ignores harmonics, voltage,
standard bank sizes and gaps in the data.

### Automatic (APFC) bank

`--apfc-step <kvar>` also sizes an automatic bank of equal steps (text, Markdown and JSON `meters[].apfc`; not in
`--csv`). In each interval the simulated controller switches in as many steps as fit under that interval's mean
lagging kVAr, so it never over-compensates; the tool finds the fewest steps that lift every month to `--target`:

```
APFC: 2 x 10.0 kVAr = 20.0 kVAr lifts every month to PF >= 0.90 with no leading kVArh (mean 1.5 step(s) in service, all steps in 1 interval(s)).
  After: 2026-01 0.9285
```

If even every step the load can use leaves a month below the target (`targetMet: false`), the step is too coarse
for the load: try a smaller one. Real controllers switch on measured kVAr with delays and hysteresis; this
interval-mean model is a first estimate, like the fixed-bank sizing.

## Library

```ts
import { analyze, parseIntervals } from 'tnb-pf-check';
const report = analyze(parseIntervals(csvText, 'load.csv'), { supply: 'lv', target: 0.9 });
```

## Development

```sh
npm run check   # lint + typecheck + tests
npm run build && npm run smoke
```

## Licence

MIT
