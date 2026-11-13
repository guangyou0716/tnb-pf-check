import { describe, expect, it } from 'vitest';
import { averagePf, roundHalfUp, surchargePercent } from '../src/tariff.js';

describe('surchargePercent (TNB tariff booklet 2.9)', () => {
  it('is zero at or above the minimum', () => {
    expect(surchargePercent(0.85, 'lv')).toBe(0);
    expect(surchargePercent(0.99, 'lv')).toBe(0);
    expect(surchargePercent(0.9, 'hv')).toBe(0);
  });
  it('matches the published examples for supply below 132 kV', () => {
    expect(surchargePercent(0.8, 'lv')).toBe(7.5);
    expect(surchargePercent(0.78, 'lv')).toBe(10.5);
    expect(surchargePercent(0.75, 'lv')).toBe(15);
    expect(surchargePercent(0.7, 'lv')).toBe(30);
  });
  it('uses 0.90 / 0.80 for high voltage', () => {
    expect(surchargePercent(0.85, 'hv')).toBe(7.5);
    expect(surchargePercent(0.8, 'hv')).toBe(15);
    expect(surchargePercent(0.75, 'hv')).toBe(30);
  });
  it('is continuous between hundredths', () => {
    expect(surchargePercent(0.845, 'lv')).toBe(0.75);
  });
});

describe('averagePf', () => {
  it('is cos(atan(kVArh / kWh))', () => {
    expect(averagePf(2400, 1800)).toBeCloseTo(0.8, 12);
    expect(averagePf(100, 0)).toBe(1);
    expect(averagePf(4, 3)).toBeCloseTo(0.8, 12);
  });
  it('handles no energy', () => {
    expect(averagePf(0, 0)).toBeNull();
    expect(averagePf(0, 5)).toBe(0);
  });
});

describe('roundHalfUp', () => {
  it('rounds .5 up despite binary noise', () => {
    expect(roundHalfUp(0.845, 2)).toBe(0.85);
    expect(roundHalfUp(0.8449, 2)).toBe(0.84);
    expect(roundHalfUp(0.835, 2)).toBe(0.84);
  });
});
