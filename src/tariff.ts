/**
 * TNB power factor surcharge (tariff booklet section 2.9; tnb.com.my "Charges & Penalties").
 * Supply below 132 kV: minimum 0.85; 1.5% of the bill per 0.01 below 0.85 down to 0.75, plus 3% per 0.01
 * below 0.75. High voltage (132 kV and above) / special contract: the same with 0.90 and 0.80.
 * The surcharge base is the month's RM kWh + RM kW + RM AFA charges.
 */
export type Supply = 'lv' | 'hv';

export interface PfLimits {
  minimum: number;
  lower: number;
}

export const LIMITS: Record<Supply, PfLimits> = {
  lv: { minimum: 0.85, lower: 0.75 },
  hv: { minimum: 0.9, lower: 0.8 },
};

/** Average power factor from energy totals: cos(atan(kVArh / kWh)). Null when there is no energy at all. */
export function averagePf(kwh: number, kvarhLagging: number): number | null {
  if (kwh <= 0) {
    return kvarhLagging > 0 ? 0 : null;
  }
  return kwh / Math.hypot(kwh, kvarhLagging);
}

/** Rounds half up to `digits` decimals (with a small guard against binary noise like 0.845 -> 0.84499...). */
export function roundHalfUp(value: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(value * f + 1e-9) / f;
}

/** Surcharge in percent of the bill (rounded to 4 decimals to drop binary noise). */
export function surchargePercent(pf: number, supply: Supply): number {
  const { minimum, lower } = LIMITS[supply];
  if (pf >= minimum) {
    return 0;
  }
  let pct: number;
  if (pf >= lower) {
    pct = ((minimum - pf) / 0.01) * 1.5;
  } else {
    pct = ((minimum - lower) / 0.01) * 1.5 + ((lower - pf) / 0.01) * 3;
  }
  return Math.round(pct * 10_000) / 10_000;
}
