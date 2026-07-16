// Deterministic synthetic S-Pankki fixture generator.
//
// Produces ~12 months of realistic-but-fake S-Pankki CSV exports plus an
// expectations file (expected.json) that downstream import/computation tests
// assert against. Everything here is SYNTHETIC (CLAUDE.md non-negotiable #5):
// the account owner is the Finnish placeholder name "Matti Meikäläinen", never a
// real person. Run via `npm run fixtures:generate`.
//
// Output (fixtures/synthetic/, tracked in git):
//   main-2025-07_2026-06.csv        UTF-8, ~12 months, main account
//   buffer-2025-07_2026-06.csv      UTF-8, buffer/emergency-fund account
//   overlap-2026-06_2026-07.csv     UTF-8, re-export overlapping main's June + new July (dedup)
//   encoding-2025-06-latin1.csv     ISO-8859-1, standalone month (encoding detection)
// and fixtures/expected.json.

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, 'synthetic');
mkdirSync(OUT_DIR, { recursive: true });

// --- Determinism -----------------------------------------------------------
const SEED = 0x5f3759df;
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(SEED);
const randInt = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const chance = (p) => rand() < p;
/** base +/- spread, in cents */
const jitter = (base, spread) => base + Math.round((rand() * 2 - 1) * spread);

// --- Identities ------------------------------------------------------------
const OWNER_OUT = 'MATTI MEIKÄLÄINEN'; // Maksaja on outgoing rows
const OWNER_IN = 'Meikäläinen Matti'; // Saajan nimi on incoming rows
const IBAN_MAIN = 'FI65 3939 0039 1111 43';
const IBAN_BUFFER = 'FI65 3939 0039 9278 43';
const EMPTY = '-'; // bare-dash empty sentinel for iban/bic/reference

// --- Merchant catalogues (raw strings deliberately messy) -------------------
const GROCERIES = [
  'Lidl Helsinki Vallila',
  'K-Market Kamppi 4021',
  'Alepa Porvoonkatu',
  'Alepa Kamppi',
  'S-market Ympyratalo',
  'Prisma Kannelmaki',
];
const RESTAURANTS = [
  'PAYPAL *WOLT',
  'Subway 65975 REDI',
  'Fooni bar and cafe',
  'VFI*FINN BEERHOUSE OY',
  'Studio Pausa',
  'MOB.PAY*ROBERTS COFFEE 14',
];
const TRANSPORT_RIDES = ['MOB.PAY*RYDE FINLAND OY', 'MOB.PAY*VOI TECHNOLOGY'];
const SHOPPING = ['PAYPAL *STEAM GAMES', 'Verkkokauppa.com', 'PAYPAL *CDON'];
const ENTERTAINMENT = ['VFI*BIO REX CINEMAS OY'];
const FRIENDS = ['MobilePay Aino V', 'MobilePay Ville K', 'MobilePay Sanna P'];

// --- Row helpers -----------------------------------------------------------
let seq = 1;
function makeArchiveId(payDate) {
  const s = `${payDate.getUTCFullYear()}${String(payDate.getUTCMonth() + 1).padStart(
    2,
    '0',
  )}${String(payDate.getUTCDate()).padStart(2, '0')}`;
  return `${s}39${String(seq++).padStart(10, '0')}`;
}
const dateUTC = (y, m, d) => {
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return new Date(Date.UTC(y, m - 1, Math.min(d, last)));
};
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);
const fmtDate = (d) =>
  `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(
    2,
    '0',
  )}.${d.getUTCFullYear()}`;
function fmtAmount(cents) {
  const sign = cents < 0 ? '-' : '+';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)},${String(abs % 100).padStart(2, '0')}`;
}
const cardMessage = (payDate) =>
  `'431871******3110 ${String(payDate.getUTCFullYear()).slice(2)}${String(
    payDate.getUTCMonth() + 1,
  ).padStart(2, '0')}${String(payDate.getUTCDate()).padStart(2, '0')}${String(
    randInt(100000, 999999),
  )}'`;

const HEADER =
  'Kirjauspäivä;Maksupäivä;Summa;Tapahtumalaji;Maksaja;Saajan nimi;Saajan tilinumero;Saajan BIC-tunnus;Viitenumero;Viesti;Arkistointitunnus';

/**
 * Emit one row into `list`. `amountCents` sign drives outgoing/incoming.
 * Card purchases get a 0–2 day booking lag; everything else books same day.
 */
function emit(list, payDate, amountCents, type, opts = {}) {
  const outgoing = amountCents < 0;
  const booking = type === 'KORTTIOSTO' ? addDays(payDate, randInt(0, 2)) : payDate;
  const row = {
    bookingDate: booking,
    paymentDate: payDate,
    amountCents,
    type,
    payer: opts.payer ?? (outgoing ? OWNER_OUT : (opts.counterparty ?? OWNER_IN)),
    payee: opts.payee ?? (outgoing ? (opts.counterparty ?? OWNER_IN) : OWNER_IN),
    iban: opts.iban ?? EMPTY,
    bic: opts.bic ?? EMPTY,
    reference: opts.reference ?? EMPTY,
    message: opts.message ?? (type === 'KORTTIOSTO' ? cardMessage(payDate) : `'-'`),
    archiveId: opts.archiveId ?? makeArchiveId(payDate),
    // for expectations only (not written to CSV):
    _counterparty: outgoing ? (opts.payee ?? opts.counterparty) : (opts.payer ?? opts.counterparty),
    _month: `${payDate.getUTCFullYear()}-${String(payDate.getUTCMonth() + 1).padStart(2, '0')}`,
  };
  list.push(row);
  return row;
}

function rowToCsv(r) {
  return [
    fmtDate(r.bookingDate),
    fmtDate(r.paymentDate),
    fmtAmount(r.amountCents),
    r.type,
    r.payer,
    r.payee,
    r.iban,
    r.bic,
    r.reference,
    r.message,
    r.archiveId,
  ].join(';');
}

function toCsv(rows) {
  const sorted = [...rows].sort(
    (a, b) => b.bookingDate - a.bookingDate || b.archiveId.localeCompare(a.archiveId),
  );
  return `${HEADER}\n${sorted.map(rowToCsv).join('\n')}\n`;
}

// --- One month of the MAIN account -----------------------------------------
function generateMonth(mainRows, bufferRows, y, m, { partialUpToDay } = {}) {
  const upTo = partialUpToDay ?? 31;
  const within = (day) => day <= upTo;

  // Salary (PALKKA -> Income type hint), end of month.
  if (within(28)) {
    emit(mainRows, dateUTC(y, m, 28), jitter(282000, 6000), 'PALKKA', {
      payer: 'ACME SOFTWARE OY',
      payee: OWNER_IN,
      iban: IBAN_MAIN + ' ',
      bic: 'SBANFIHH',
      message: `'Palkka kaudelta ${m}/${y}'`,
    });
  }
  // Rent-like E-LASKU (named recurring line -> Housing), ~5th.
  if (within(5)) {
    emit(mainRows, dateUTC(y, m, 5), -72000, 'E-LASKU', {
      counterparty: 'Asunto Oy Helsingin Esimerkki',
      iban: 'FI21 1234 5600 0007 85 ',
      bic: 'NDEAFIHH',
      reference: '00000000001234567894',
    });
  }
  // Electricity E-LASKU (Utilities), ~7th.
  if (within(7)) {
    emit(mainRows, dateUTC(y, m, 7), -jitter(2500, 1200), 'E-LASKU', {
      counterparty: 'Helen Oy',
      iban: 'FI18 8000 1200 3133 60 ',
      bic: 'DABAFIHH',
      reference: '00222190542323842243',
    });
  }
  // Transport season ticket (Transport), ~1st.
  if (within(1)) {
    emit(mainRows, dateUTC(y, m, 1), -6270, 'KORTTIOSTO', { counterparty: 'HSL Mobiili' });
  }
  // Gym (Subscriptions), ~2nd.
  if (within(2)) {
    emit(mainRows, dateUTC(y, m, 2), -4990, 'KORTTIOSTO', { counterparty: 'ELIXIA HELSINKI' });
  }
  // Subscriptions with messy processor prefixes/codes.
  if (within(15)) {
    emit(mainRows, dateUTC(y, m, 15), -1299, 'KORTTIOSTO', {
      counterparty: `PAYPAL *SPOTIFY*P${randInt(10000000, 99999999).toString(36).toUpperCase()}`,
    });
  }
  if (within(18)) {
    emit(mainRows, dateUTC(y, m, 18), -1599, 'KORTTIOSTO', { counterparty: 'NETFLIX.COM' });
  }

  // Groceries: 8–12 per month.
  const groceryCount = randInt(8, 12);
  for (let i = 0; i < groceryCount; i++) {
    const day = randInt(1, 28);
    if (!within(day)) continue;
    emit(mainRows, dateUTC(y, m, day), -jitter(2200, 1800), 'KORTTIOSTO', {
      counterparty: pick(GROCERIES),
    });
  }
  // Restaurants/cafes: 3–6.
  const restCount = randInt(3, 6);
  for (let i = 0; i < restCount; i++) {
    const day = randInt(1, 28);
    if (!within(day)) continue;
    emit(mainRows, dateUTC(y, m, day), -jitter(1600, 1200), 'KORTTIOSTO', {
      counterparty: pick(RESTAURANTS),
    });
  }
  // Micromobility rides: 2–5.
  const rideCount = randInt(2, 5);
  for (let i = 0; i < rideCount; i++) {
    const day = randInt(1, 28);
    if (!within(day)) continue;
    emit(mainRows, dateUTC(y, m, day), -jitter(450, 300), 'KORTTIOSTO', {
      counterparty: pick(TRANSPORT_RIDES),
    });
  }
  // Occasional shopping / entertainment.
  if (chance(0.5)) {
    const day = randInt(1, 28);
    if (within(day)) {
      emit(mainRows, dateUTC(y, m, day), -jitter(3500, 3000), 'KORTTIOSTO', {
        counterparty: pick(SHOPPING),
      });
    }
  }
  if (chance(0.4)) {
    const day = randInt(1, 28);
    if (within(day)) {
      emit(mainRows, dateUTC(y, m, day), -jitter(1400, 500), 'KORTTIOSTO', {
        counterparty: pick(ENTERTAINMENT),
      });
    }
  }

  // Incoming MobilePay from a friend (regular TILISIIRTO, positive).
  if (chance(0.6)) {
    const day = randInt(1, 28);
    if (within(day)) {
      emit(mainRows, dateUTC(y, m, day), jitter(1500, 1200), 'TILISIIRTO', {
        payer: 'VIPPS MOBILEPAY AS,',
        payee: OWNER_IN,
        iban: IBAN_MAIN,
        bic: 'SBANFIHH',
        message: `'${pick(FRIENDS)}'`,
      });
    }
  }
  // Rare Kela benefit (positive TILISIIRTO).
  if (chance(0.15)) {
    const day = randInt(10, 24);
    if (within(day)) {
      emit(mainRows, dateUTC(y, m, day), jitter(4000, 500), 'TILISIIRTO', {
        payer: 'Kansaneläkelaitos',
        payee: OWNER_IN,
        iban: 'FI16 1111 1111 3753 36 ',
        bic: 'DABAFIHH',
        reference: '00000000031146360262',
      });
    }
  }

  // Own-account transfers (OMA TILISIIRTO -> Transfer type hint), mirrored in buffer.
  const transferCount = randInt(1, 2);
  for (let i = 0; i < transferCount; i++) {
    const day = randInt(1, 27);
    if (!within(day)) continue;
    const pd = dateUTC(y, m, day);
    const magnitude = jitter(8000, 6000);
    const toBuffer = chance(0.5); // main -> buffer (out of main) or buffer -> main (in)
    const mainAmount = toBuffer ? -magnitude : magnitude;
    emit(mainRows, pd, mainAmount, 'OMA TILISIIRTO', {
      payer: mainAmount < 0 ? OWNER_OUT : 'MEIKÄLÄINEN MATTI',
      payee: OWNER_IN,
      iban: IBAN_BUFFER,
      bic: 'SBAN FI HH',
    });
    // Mirror leg in the buffer account (opposite sign, own archive id).
    emit(bufferRows, pd, -mainAmount, 'OMA TILISIIRTO', {
      payer: -mainAmount < 0 ? OWNER_OUT : 'MEIKÄLÄINEN MATTI',
      payee: OWNER_IN,
      iban: IBAN_MAIN,
      bic: 'SBAN FI HH',
    });
  }
}

// --- Generate MAIN + BUFFER over 2025-07 .. 2026-06 -------------------------
const mainRows = [];
const bufferRows = [];
const months = [];
for (let y = 2025, m = 7, k = 0; k < 12; k++) {
  months.push(`${y}-${String(m).padStart(2, '0')}`);
  generateMonth(mainRows, bufferRows, y, m);
  m++;
  if (m > 12) {
    m = 1;
    y++;
  }
}

// --- Overlap file: re-export of main's June 2026 + new July 2026 rows -------
const juneRows = mainRows.filter((r) => r._month === '2026-06');
const julyNewRows = [];
generateMonth(julyNewRows, bufferRows, 2026, 7, { partialUpToDay: 14 });
// (buffer legs for July land in bufferRows; the overlap file itself is main-account.)
const julyMainNew = julyNewRows;
const overlapRows = [...juneRows, ...julyMainNew];

// --- Standalone ISO-8859-1 file: a month BEFORE main's range (2025-06) ------
const latinRows = [];
const latinBuffer = [];
generateMonth(latinRows, latinBuffer, 2025, 6);

// --- Normalization contract (mirrors spec 002; used to assert examples) -----
// Brand-canonicalization list: known merchants whose different locations should
// collapse to one rule key (owner decision 002-B: "merge same brand"). A
// merchant whose normalized string starts with one of these collapses to it.
// Seeded here; becomes a user-editable table in the real implementation.
const BRAND_PREFIXES = [
  'K-CITYMARKET',
  'K-MARKET',
  'K-SUPERMARKET',
  'S-MARKET',
  'ALEPA',
  'PRISMA',
  'LIDL',
  'SALE',
  'SUBWAY',
  'HESBURGER',
  'ROBERTS COFFEE',
  'R-KIOSKI',
];
function normalize(raw) {
  let s = raw.toUpperCase().trim().replace(/\s+/g, ' ');
  const prefixes = [/^PAYPAL\s*\*\s*/, /^VFI\s*\*\s*/, /^MOB\.PAY\s*\*\s*/];
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of prefixes) {
      if (p.test(s)) {
        s = s.replace(p, '');
        changed = true;
      }
    }
  }
  s = s.replace(/\*[A-Z0-9]{4,}$/, ''); // trailing opaque processor code
  s = s.replace(/\*/g, ' ');
  s = s.replace(/\b\d{2,}\b/g, ' '); // store numbers / card tails
  s = s.replace(/\s+/g, ' ').trim();
  // Collapse known brands to their canonical key (merge locations).
  for (const brand of BRAND_PREFIXES) {
    if (s === brand || s.startsWith(brand + ' ')) return brand;
  }
  return s;
}
const NORMALIZATION_SAMPLES = [
  'PAYPAL *SPOTIFY*P41B7F3E9',
  'VFI*BIO REX CINEMAS OY',
  'MOB.PAY*RYDE FINLAND OY',
  'PAYPAL *WOLT',
  'Subway 65975 REDI',
  'Alepa Porvoonkatu', // brand-merged ...
  'Alepa Kamppi', // ... same key as the line above
  'K-Market Kamppi 4021',
  'S-market Ympyratalo',
  'Lidl Helsinki Vallila',
];

// --- Cash-flow expectations for the MAIN account ----------------------------
// Sign-based (spec 004), transfers (OMA TILISIIRTO) excluded.
function cashFlow(rows) {
  const byMonth = {};
  let ti = 0,
    te = 0,
    tx = 0;
  for (const r of rows) {
    byMonth[r._month] ??= {
      incomeCents: 0,
      expensesCents: 0,
      netCents: 0,
      transferExcludedCents: 0,
    };
    const b = byMonth[r._month];
    if (r.type === 'OMA TILISIIRTO') {
      b.transferExcludedCents += r.amountCents;
      tx += r.amountCents;
      continue;
    }
    if (r.amountCents > 0) {
      b.incomeCents += r.amountCents;
      ti += r.amountCents;
    } else {
      b.expensesCents += -r.amountCents;
      te += -r.amountCents;
    }
    b.netCents = b.incomeCents - b.expensesCents;
  }
  return {
    byMonth,
    totalIncomeCents: ti,
    totalExpensesCents: te,
    totalNetCents: ti - te,
    totalTransferExcludedCents: tx,
  };
}

// Positive inflows split by source, to support the income-source model (004-A).
// From the CSV alone we can separate salary (PALKKA -> Income) from every other
// inflow; distinguishing "other income" (e.g. Kela) from "reimbursements" (peer
// paybacks) needs categorization and is asserted once seed labeling exists.
function incomeSources(rows) {
  const byMonth = {};
  let salary = 0,
    other = 0;
  for (const r of rows) {
    if (r.type === 'OMA TILISIIRTO' || r.amountCents <= 0) continue;
    byMonth[r._month] ??= { salaryCents: 0, otherInflowCents: 0 };
    if (r.type === 'PALKKA') {
      byMonth[r._month].salaryCents += r.amountCents;
      salary += r.amountCents;
    } else {
      byMonth[r._month].otherInflowCents += r.amountCents;
      other += r.amountCents;
    }
  }
  return { byMonth, totalSalaryCents: salary, totalOtherInflowCents: other };
}

const expected = {
  generatedBy: 'fixtures/generate.mjs',
  seed: SEED,
  note: 'Synthetic S-Pankki data. Owner is the placeholder "Matti Meikäläinen". Never real data.',
  owner: { outgoingName: OWNER_OUT, incomingName: OWNER_IN },
  files: {
    main: {
      path: 'synthetic/main-2025-07_2026-06.csv',
      encoding: 'utf-8',
      account: 'main',
      rowCount: mainRows.length,
      months,
    },
    buffer: {
      path: 'synthetic/buffer-2025-07_2026-06.csv',
      encoding: 'utf-8',
      account: 'buffer',
      rowCount: bufferRows.length,
    },
    overlap: {
      path: 'synthetic/overlap-2026-06_2026-07.csv',
      encoding: 'utf-8',
      account: 'main',
      rowCount: overlapRows.length,
      sharedWithMain: juneRows.length,
      newRows: julyMainNew.length,
    },
    encodingLatin1: {
      path: 'synthetic/encoding-2025-06-latin1.csv',
      encoding: 'iso-8859-1',
      account: 'main',
      rowCount: latinRows.length,
      sampleDecodedPayer: OWNER_OUT,
    },
  },
  dedup: {
    mainRowCount: mainRows.length,
    overlapRowCount: overlapRows.length,
    overlapSharedWithMain: juneRows.length,
    overlapNewRows: julyMainNew.length,
    unionUniqueArchiveIds: mainRows.length + julyMainNew.length,
  },
  typeHints: {
    palkkaRowsMain: mainRows.filter((r) => r.type === 'PALKKA').length, // -> Income
    omaTilisiirtoRowsMain: mainRows.filter((r) => r.type === 'OMA TILISIIRTO').length, // -> Transfer
  },
  // Sign-based, transfers (OMA TILISIIRTO) excluded. This is the pre-categorization
  // baseline; the category-driven income/expense split (spec 004, income-source
  // model) is asserted once seed labeling exists.
  cashFlowMain: cashFlow(mainRows),
  incomeSourcesMain: incomeSources(mainRows),
  normalizationExamples: NORMALIZATION_SAMPLES.map((raw) => ({ raw, normalized: normalize(raw) })),
};

// --- Write everything -------------------------------------------------------
writeFileSync(join(OUT_DIR, 'main-2025-07_2026-06.csv'), toCsv(mainRows), 'utf-8');
writeFileSync(join(OUT_DIR, 'buffer-2025-07_2026-06.csv'), toCsv(bufferRows), 'utf-8');
writeFileSync(join(OUT_DIR, 'overlap-2026-06_2026-07.csv'), toCsv(overlapRows), 'utf-8');
// ISO-8859-1: encode the UTF-8 string as latin1 bytes.
writeFileSync(
  join(OUT_DIR, 'encoding-2025-06-latin1.csv'),
  Buffer.from(toCsv(latinRows), 'latin1'),
);
writeFileSync(join(HERE, 'expected.json'), `${JSON.stringify(expected, null, 2)}\n`, 'utf-8');

console.log('Wrote synthetic fixtures:');
console.log(`  main   ${mainRows.length} rows`);
console.log(`  buffer ${bufferRows.length} rows`);
console.log(
  `  overlap ${overlapRows.length} rows (${juneRows.length} shared + ${julyMainNew.length} new)`,
);
console.log(`  latin1 ${latinRows.length} rows`);
console.log('  expected.json updated');
