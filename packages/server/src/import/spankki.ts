import type { BankAdapter, DetectedEncoding, ParsedTransaction } from './adapter';
import { BankAdapterParseError } from './adapter';

/**
 * S-Pankki CSV adapter (spec 002 "S-Pankki adapter — parsing rules"). Verified
 * against `fixtures/synthetic/*.csv`.
 */

const HEADER_COLUMNS = [
  'Kirjauspäivä',
  'Maksupäivä',
  'Summa',
  'Tapahtumalaji',
  'Maksaja',
  'Saajan nimi',
  'Saajan tilinumero',
  'Saajan BIC-tunnus',
  'Viitenumero',
  'Viesti',
  'Arkistointitunnus',
] as const;

// Header tokens that must be present for the file to plausibly be an S-Pankki
// export (a mismatch means wrong file/bank, per spec).
const REQUIRED_HEADER_TOKENS = ['Kirjauspäivä', 'Arkistointitunnus'];

function decodeBytes(bytes: Uint8Array): { encoding: DetectedEncoding; text: string } {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return { encoding: 'utf-8', text: stripBom(text) };
  } catch {
    // Not valid UTF-8 -> assume ISO-8859-1 (every byte is a valid Latin-1
    // code point, so this decode never throws).
    const text = new TextDecoder('iso-8859-1').decode(bytes);
    return { encoding: 'iso-8859-1', text };
  }
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/).filter((line) => line.length > 0);
}

/** '-' means empty for iban/bic/reference/payer/payee fields (not the message). */
function emptyDash(raw: string): string | null {
  const trimmed = raw.trim();
  return trimmed === '-' ? null : trimmed;
}

/** Viesti is wrapped `'...'`; the empty case is the wrapped dash `'-'`. */
function unwrapMessage(raw: string): string | null {
  const trimmed = raw.trim();
  const unwrapped =
    trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")
      ? trimmed.slice(1, -1)
      : trimmed;
  return unwrapped === '-' ? null : unwrapped;
}

function stripWhitespace(value: string | null): string | null {
  return value === null ? null : value.replace(/\s+/g, '');
}

/** `DD.MM.YYYY` -> `YYYY-MM-DD`. */
function parseDate(raw: string): string {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(raw.trim());
  if (!m) {
    throw new BankAdapterParseError(`invalid date "${raw}"`);
  }
  const [, day, month, year] = m;
  return `${year}-${month}-${day}`;
}

/**
 * `-83,22` / `+2826,41` -> integer cents. Sign and integer/fractional parts
 * are parsed separately (not `parseFloat`) so there is no float-drift risk.
 */
function parseAmountCents(raw: string): number {
  const m = /^([+-])(\d+),(\d{1,2})$/.exec(raw.trim().replace(/\s+/g, ''));
  if (!m) {
    throw new BankAdapterParseError(`invalid amount "${raw}"`);
  }
  const [, sign, wholePart, fracPart] = m!;
  const fracCents = fracPart!.length === 1 ? Number(fracPart) * 10 : Number(fracPart);
  const magnitude = Number(wholePart) * 100 + fracCents;
  return sign === '-' ? -magnitude : magnitude;
}

function parseRow(fields: string[], columnIndex: Record<string, number>): ParsedTransaction {
  const col = (name: (typeof HEADER_COLUMNS)[number]) => fields[columnIndex[name]!] ?? '';

  const amountCents = parseAmountCents(col('Summa'));
  const payer = emptyDash(col('Maksaja'));
  const payee = emptyDash(col('Saajan nimi'));
  // Zero-amount rows are not expected; per spec, treat as outgoing if one appears.
  const outgoing = amountCents <= 0;
  const counterparty = (outgoing ? payee : payer) ?? '';

  return {
    paymentDate: parseDate(col('Maksupäivä')),
    bookingDate: parseDate(col('Kirjauspäivä')),
    amountCents,
    type: col('Tapahtumalaji').trim(),
    payer,
    payee,
    counterparty,
    counterpartyIban: stripWhitespace(emptyDash(col('Saajan tilinumero'))),
    counterpartyBic: stripWhitespace(emptyDash(col('Saajan BIC-tunnus'))),
    reference: emptyDash(col('Viitenumero')),
    message: unwrapMessage(col('Viesti')),
    archiveId: emptyDash(col('Arkistointitunnus')),
  };
}

export const sPankkiAdapter: BankAdapter = {
  id: 's-pankki',

  detectEncoding(bytes: Uint8Array): DetectedEncoding {
    return decodeBytes(bytes).encoding;
  },

  parse(bytes: Uint8Array): { encoding: DetectedEncoding; rows: ParsedTransaction[] } {
    const { encoding, text } = decodeBytes(bytes);
    const lines = splitLines(text);
    if (lines.length === 0) {
      throw new BankAdapterParseError('empty file');
    }

    const headerFields = lines[0]!.split(';').map((f) => f.trim());
    for (const token of REQUIRED_HEADER_TOKENS) {
      if (!headerFields.includes(token)) {
        throw new BankAdapterParseError(
          `missing expected column "${token}" — not an S-Pankki export`,
        );
      }
    }

    const columnIndex: Record<string, number> = {};
    for (const name of HEADER_COLUMNS) {
      const idx = headerFields.indexOf(name);
      if (idx === -1) {
        throw new BankAdapterParseError(`missing expected column "${name}"`);
      }
      columnIndex[name] = idx;
    }

    const rows = lines.slice(1).map((line) => parseRow(line.split(';'), columnIndex));
    return { encoding, rows };
  },
};
