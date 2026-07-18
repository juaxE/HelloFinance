/**
 * Month arithmetic (spec 003) — the due-month formula and short-month clamping
 * in isolation, so the route tests can assume they are right.
 */
import { describe, expect, it } from 'vitest';
import {
  addMonths,
  clampDayToMonth,
  daysInMonth,
  isTemplateDue,
  isTemplateEnded,
  monthOf,
  monthsBetween,
  previousMonth,
} from '../src/budgets/months';

describe('month arithmetic', () => {
  it('monthsBetween counts calendar months, signed, across year boundaries', () => {
    expect(monthsBetween('2025-07', '2025-07')).toBe(0);
    expect(monthsBetween('2025-07', '2025-10')).toBe(3);
    expect(monthsBetween('2025-10', '2026-10')).toBe(12);
    expect(monthsBetween('2025-12', '2026-01')).toBe(1);
    expect(monthsBetween('2026-01', '2025-12')).toBe(-1);
  });

  it('addMonths and previousMonth wrap years correctly', () => {
    expect(addMonths('2025-12', 1)).toBe('2026-01');
    expect(addMonths('2026-01', -1)).toBe('2025-12');
    expect(addMonths('2025-07', 18)).toBe('2027-01');
    expect(previousMonth('2026-01')).toBe('2025-12');
  });

  it('daysInMonth handles 30-day months and leap Februaries', () => {
    expect(daysInMonth('2025-01')).toBe(31);
    expect(daysInMonth('2025-06')).toBe(30);
    expect(daysInMonth('2025-02')).toBe(28);
    expect(daysInMonth('2024-02')).toBe(29);
  });

  it('clampDayToMonth clamps day 31 to the last day, and leaves valid days alone', () => {
    expect(clampDayToMonth(31, '2025-01')).toBe(31);
    expect(clampDayToMonth(31, '2025-06')).toBe(30);
    expect(clampDayToMonth(31, '2025-02')).toBe(28);
    expect(clampDayToMonth(31, '2024-02')).toBe(29);
    expect(clampDayToMonth(5, '2025-02')).toBe(5);
  });

  it('isTemplateDue respects the start anchor, the cadence phase, and the end month', () => {
    const quarterly = { startMonth: '2025-07', endMonth: null, intervalMonths: 3 };
    expect(isTemplateDue(quarterly, '2025-06')).toBe(false); // before start
    expect(isTemplateDue(quarterly, '2025-07')).toBe(true);
    expect(isTemplateDue(quarterly, '2025-08')).toBe(false);
    expect(isTemplateDue(quarterly, '2025-10')).toBe(true);
    expect(isTemplateDue(quarterly, '2026-04')).toBe(true);

    const ended = { startMonth: '2025-07', endMonth: '2025-09', intervalMonths: 1 };
    expect(isTemplateDue(ended, '2025-09')).toBe(true); // inclusive
    expect(isTemplateDue(ended, '2025-10')).toBe(false);
  });

  it('isTemplateEnded is false for an open template and for one ending this month', () => {
    expect(isTemplateEnded({ endMonth: null }, '2026-03')).toBe(false);
    expect(isTemplateEnded({ endMonth: '2026-03' }, '2026-03')).toBe(false);
    expect(isTemplateEnded({ endMonth: '2026-02' }, '2026-03')).toBe(true);
  });

  it('monthOf reads a Date as its local calendar month', () => {
    expect(monthOf(new Date(2026, 2, 15))).toBe('2026-03');
    expect(monthOf(new Date(2025, 11, 31))).toBe('2025-12');
  });
});
