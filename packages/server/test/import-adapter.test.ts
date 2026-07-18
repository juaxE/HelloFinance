import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BankAdapterParseError } from '../src/import/adapter';
import { sPankkiAdapter } from '../src/import/spankki';
import expected from '../../../fixtures/expected.json';

const FIXTURES_DIR = resolve(__dirname, '../../../fixtures/synthetic');

function loadFixture(relPath: string): Buffer {
  return readFileSync(resolve(FIXTURES_DIR, '..', relPath));
}

const HEADER =
  'Kirjauspäivä;Maksupäivä;Summa;Tapahtumalaji;Maksaja;Saajan nimi;Saajan tilinumero;Saajan BIC-tunnus;Viitenumero;Viesti;Arkistointitunnus';

function csv(rows: string[]): Buffer {
  return Buffer.from(`${HEADER}\n${rows.join('\n')}\n`, 'utf-8');
}

describe('S-Pankki adapter parsing rules (spec 002)', () => {
  it('parses dates, signed amounts, and maps columns by header name', () => {
    const bytes = csv([
      "28.06.2026;27.06.2026;-83,22;KORTTIOSTO;MATTI MEIKÄLÄINEN;K-Market;-;-;-;'-';ARK-1",
      "28.06.2026;28.06.2026;+2826,41;PALKKA;ACME OY;Meikäläinen Matti;-;-;-;'-';ARK-2",
    ]);
    const { rows } = sPankkiAdapter.parse(bytes);
    expect(rows[0]).toMatchObject({
      bookingDate: '2026-06-28',
      paymentDate: '2026-06-27',
      amountCents: -8322,
      counterparty: 'K-Market', // outgoing -> payee
    });
    expect(rows[1]).toMatchObject({
      paymentDate: '2026-06-28',
      amountCents: 282641,
      counterparty: 'ACME OY', // incoming -> payer
    });
  });

  it("treats a bare '-' as empty for iban/reference/payer/payee", () => {
    const bytes = csv(["01.01.2026;01.01.2026;-10,00;KORTTIOSTO;OWNER;Shop;-;-;-;'-';ARK-3"]);
    const { rows } = sPankkiAdapter.parse(bytes);
    expect(rows[0]).toMatchObject({
      counterpartyIban: null,
      reference: null,
      message: null,
    });
    // BIC is parsed past for header mapping but never extracted (decision 002-F).
    expect('counterpartyBic' in rows[0]!).toBe(false);
  });

  it('unwraps a Viesti apostrophe-quoted message, and the wrapped dash means empty', () => {
    const bytes = csv([
      "01.01.2026;01.01.2026;-10,00;KORTTIOSTO;OWNER;Shop;-;-;-;'Palkka kaudelta 1/2026';ARK-4",
    ]);
    const { rows } = sPankkiAdapter.parse(bytes);
    expect(rows[0]!.message).toBe('Palkka kaudelta 1/2026');
  });

  it('strips stray internal/trailing whitespace from IBAN', () => {
    const bytes = csv([
      "05.01.2026;05.01.2026;-720,00;E-LASKU;OWNER;Landlord;FI21 1234 5600 0007 85 ;NDEA FIHH;-;'-';ARK-5",
    ]);
    const { rows } = sPankkiAdapter.parse(bytes);
    expect(rows[0]!.counterpartyIban).toBe('FI2112345600000785');
  });

  it('keeps a semicolon inside an apostrophe-wrapped message from shifting later columns', () => {
    // Without quote-aware splitting the extra ';' would push the archive_id
    // (the dedup key) out of its column and break idempotency (non-negotiable #4).
    const bytes = csv([
      "01.01.2026;01.01.2026;-10,00;KORTTIOSTO;OWNER;Shop;-;-;-;'Ref 12;34;56';ARK-SEMI",
    ]);
    const { rows } = sPankkiAdapter.parse(bytes);
    expect(rows[0]).toMatchObject({ message: 'Ref 12;34;56', archiveId: 'ARK-SEMI' });
  });

  it('throws when a data row has the wrong number of columns', () => {
    const bytes = csv(['01.01.2026;01.01.2026;-10,00;KORTTIOSTO;OWNER;Shop']);
    expect(() => sPankkiAdapter.parse(bytes)).toThrow(BankAdapterParseError);
  });

  it('throws BankAdapterParseError for a file missing the expected header tokens', () => {
    const bytes = Buffer.from('Foo;Bar;Baz\n1;2;3\n', 'utf-8');
    expect(() => sPankkiAdapter.parse(bytes)).toThrow(BankAdapterParseError);
  });

  it('parses the main synthetic fixture with the expected row count (AC 002-1)', () => {
    const bytes = loadFixture(expected.files.main.path);
    const { encoding, rows } = sPankkiAdapter.parse(bytes);
    expect(encoding).toBe('utf-8');
    expect(rows).toHaveLength(expected.files.main.rowCount);
    // Every transaction type the pipeline branches on must actually be present.
    const presentTypes = new Set(rows.map((r) => r.type));
    for (const type of ['KORTTIOSTO', 'TILISIIRTO', 'PALKKA', 'E-LASKU', 'OMA TILISIIRTO']) {
      expect(presentTypes).toContain(type);
    }
  });

  it('detects and decodes the ISO-8859-1 fixture correctly (AC 002-4)', () => {
    const bytes = loadFixture(expected.files.encodingLatin1.path);
    const { encoding, rows } = sPankkiAdapter.parse(bytes);
    expect(encoding).toBe('iso-8859-1');
    expect(rows).toHaveLength(expected.files.encodingLatin1.rowCount);
    expect(rows.some((r) => r.payer === expected.files.encodingLatin1.sampleDecodedPayer)).toBe(
      true,
    );
  });
});
