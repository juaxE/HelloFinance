/**
 * Bank-adapter interface (spec 002). The import pipeline (dedup, staging,
 * labeling, commit) is adapter-agnostic and consumes `ParsedTransaction[]`;
 * S-Pankki (./spankki.ts) is the only implementation for now.
 */
export interface ParsedTransaction {
  paymentDate: string; // YYYY-MM-DD (from Maksupäivä)
  bookingDate: string; // YYYY-MM-DD (from Kirjauspäivä)
  amountCents: number; // signed
  type: string; // Tapahtumalaji
  payer: string | null; // Maksaja
  payee: string | null; // Saajan nimi
  counterparty: string; // payee if amountCents<0 else payer (raw, pre-normalization)
  counterpartyIban: string | null; // spaces stripped
  counterpartyBic: string | null; // spaces stripped
  reference: string | null; // Viitenumero
  message: string | null; // Viesti, unwrapped
  archiveId: string | null; // Arkistointitunnus (null only for future banks)
}

export type DetectedEncoding = 'utf-8' | 'iso-8859-1';

export interface BankAdapter {
  id: 's-pankki';
  /** Sniff bytes -> encoding. Throws on a structurally invalid file. */
  detectEncoding(bytes: Uint8Array): DetectedEncoding;
  parse(bytes: Uint8Array): { encoding: DetectedEncoding; rows: ParsedTransaction[] };
}

/** Thrown by an adapter when the file is not structurally a valid export for it. */
export class BankAdapterParseError extends Error {}
