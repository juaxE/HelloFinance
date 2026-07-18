import { describe, expect, it } from 'vitest';
import { normalizeCounterparty } from '../src/import/normalize';
import expected from '../../../fixtures/expected.json';

describe('counterparty normalization (spec 002, AC 002-6)', () => {
  it('matches every example in fixtures/expected.json.normalizationExamples', () => {
    for (const { raw, normalized } of expected.normalizationExamples) {
      expect(normalizeCounterparty(raw)).toBe(normalized);
    }
  });

  it('tolerates optional spacing around noise-prefix stars', () => {
    expect(normalizeCounterparty('PAYPAL*NETFLIX')).toBe('NETFLIX');
    expect(normalizeCounterparty('PAYPAL  *  NETFLIX')).toBe('NETFLIX');
    expect(normalizeCounterparty('VFI *SOME SHOP')).toBe('SOME SHOP');
  });

  it('does not collapse a merchant that merely starts with a brand-like prefix', () => {
    // "K-MARKETPLACE" must not collapse to "K-MARKET" (word-boundary check).
    expect(normalizeCounterparty('K-Marketplace Oy')).toBe('K-MARKETPLACE OY');
  });

  it('leaves unknown merchants as their full normalized string (only known brands merge)', () => {
    expect(normalizeCounterparty('Studio Pausa')).toBe('STUDIO PAUSA');
  });

  it('keeps distinct MobilePay senders distinct (person name is part of the identity)', () => {
    expect(normalizeCounterparty('MobilePay Aino V')).toBe('MOBILEPAY AINO V');
    expect(normalizeCounterparty('MobilePay Ville K')).toBe('MOBILEPAY VILLE K');
  });

  it('is a pure function (idempotent on already-normalized input)', () => {
    for (const { normalized } of expected.normalizationExamples) {
      expect(normalizeCounterparty(normalized)).toBe(normalized);
    }
  });
});
