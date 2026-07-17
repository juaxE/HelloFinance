import { describe, expect, it } from 'vitest';
import { zAccountCreate, zCategoryCreate, zIsoDate, zMonth, zHexColor } from './index';

describe('zIsoDate', () => {
  it('accepts a real calendar date', () => {
    expect(zIsoDate.safeParse('2026-07-16').success).toBe(true);
  });

  it('rejects a malformed or impossible date', () => {
    expect(zIsoDate.safeParse('2026-7-1').success).toBe(false);
    expect(zIsoDate.safeParse('2026-02-30').success).toBe(false);
    expect(zIsoDate.safeParse('2026-13-01').success).toBe(false);
  });
});

describe('zMonth / zHexColor', () => {
  it('validates month granularity', () => {
    expect(zMonth.safeParse('2026-07').success).toBe(true);
    expect(zMonth.safeParse('2026-00').success).toBe(false);
    expect(zMonth.safeParse('2026-13').success).toBe(false);
  });

  it('validates #rrggbb hex colors', () => {
    expect(zHexColor.safeParse('#a1b2c3').success).toBe(true);
    expect(zHexColor.safeParse('#abc').success).toBe(false);
    expect(zHexColor.safeParse('red').success).toBe(false);
  });
});

describe('zAccountCreate', () => {
  it('requires a non-empty name', () => {
    expect(zAccountCreate.safeParse({ name: '' }).success).toBe(false);
    expect(zAccountCreate.safeParse({ name: 'Main' }).success).toBe(true);
  });

  it('rejects a non-zero opening balance without an anchor date (decision 001-A)', () => {
    expect(
      zAccountCreate.safeParse({ name: 'Main', openingBalanceCents: 1000 }).success,
    ).toBe(false);
    expect(
      zAccountCreate.safeParse({
        name: 'Main',
        openingBalanceCents: 1000,
        openingBalanceDate: '2026-01-01',
      }).success,
    ).toBe(true);
  });
});

describe('zCategoryCreate', () => {
  it('does not accept a client-supplied system_key', () => {
    const parsed = zCategoryCreate.parse({ name: 'Groceries', systemKey: 'transfer' });
    expect('systemKey' in parsed).toBe(false);
  });
});
