/**
 * Counterparty normalization (spec 002 "Normalization"). Deterministic and
 * pure: used both to propose labels (labeling_rules lookup) and to group the
 * review screen. Reference examples are asserted against
 * `fixtures/expected.json.normalizationExamples`.
 *
 * Normalization is a heuristic; imperfect grouping only ever means an extra
 * review group, never wrong data, because every label is user-confirmed. The
 * brand list (step 5) is the one deliberately-lossy step and is a maintained
 * constant, intended to become user-editable later (not in this spec).
 */

// Noise prefixes stripped from the front (repeat until stable). Optional
// spaces around the `*` are tolerated.
const NOISE_PREFIXES: RegExp[] = [/^PAYPAL\s*\*\s*/, /^VFI\s*\*\s*/, /^MOB\.PAY\s*\*\s*/];

// Seeded with common Finnish grocery/retail chains (CLAUDE.md "Normalization").
// A result collapses to a brand key when it equals the key or starts with
// `KEY ` (word boundary, so "K-MARKET" never matches "K-MARKETPLACE").
const BRAND_KEYS = [
  'LIDL',
  'K-MARKET',
  'K-CITYMARKET',
  'S-MARKET',
  'ALEPA',
  'PRISMA',
  'SALE',
  'SUBWAY',
  'HESBURGER',
  'ROBERTS COFFEE',
  'R-KIOSKI',
];

function stripNoisePrefixes(value: string): string {
  let result = value;
  let changed = true;
  while (changed) {
    changed = false;
    for (const prefix of NOISE_PREFIXES) {
      const stripped = result.replace(prefix, '');
      if (stripped !== result) {
        result = stripped;
        changed = true;
      }
    }
  }
  return result;
}

// A `*`-delimited trailing segment that is an opaque processor code (all
// letters/digits, no spaces, contains at least one digit) is dropped, e.g.
// `SPOTIFY*P41B7F3E9` -> `SPOTIFY`.
function stripTrailingProcessorToken(value: string): string {
  const lastStar = value.lastIndexOf('*');
  if (lastStar === -1) {
    return value;
  }
  const tail = value.slice(lastStar + 1);
  if (/^[A-Z0-9]+$/.test(tail) && /\d/.test(tail)) {
    return value.slice(0, lastStar);
  }
  return value;
}

// Standalone digit-group tokens (store numbers, card-tail artifacts) are
// dropped, e.g. `SUBWAY 65975 REDI` -> `SUBWAY REDI`.
function stripStandaloneDigitGroups(value: string): string {
  return value
    .split(' ')
    .filter((token) => !/^\d+$/.test(token))
    .join(' ');
}

function collapseBrand(value: string): string {
  for (const brand of BRAND_KEYS) {
    if (value === brand || value.startsWith(`${brand} `)) {
      return brand;
    }
  }
  return value;
}

function collapseWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

export function normalizeCounterparty(raw: string): string {
  let value = collapseWhitespace(raw).toUpperCase();
  value = stripNoisePrefixes(value);
  value = stripTrailingProcessorToken(value);
  value = collapseWhitespace(stripStandaloneDigitGroups(value));
  value = collapseBrand(value);
  return value;
}
