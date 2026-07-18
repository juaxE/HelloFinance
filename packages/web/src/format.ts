/**
 * Money is integer cents everywhere except the UI edge (CLAUDE.md
 * non-negotiable #3). This is the only place a euro amount is formatted.
 */
export function formatCents(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const euros = Math.floor(abs / 100).toLocaleString('fi-FI');
  const remainder = String(abs % 100).padStart(2, '0');
  return `${sign}${euros},${remainder} €`;
}

/**
 * The inverse of `formatCents`: a typed euro amount to integer cents.
 *
 * Parsed by string surgery rather than `Number(x) * 100`, because that is float
 * arithmetic on a euro value (CLAUDE.md non-negotiable #3). Accepts what the
 * formatter emits and what a human types: comma or dot decimal, thousands
 * separators (including the non-breaking spaces `toLocaleString('fi-FI')`
 * produces), a trailing `€`, and a leading sign.
 *
 * `null` means "no amount" (empty input); `'invalid'` means the text is not a
 * money value and the caller must not save it.
 */
export function parseEurosToCents(input: string): number | null | 'invalid' {
  const cleaned = input
    .replace(/[\s\u00a0\u202f]/g, '')
    .replace(/€/g, '')
    .replace(',', '.');
  if (cleaned === '') return null;

  const match = /^(-?)(\d*)(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!match) return 'invalid';

  const [, sign, whole, fraction = ''] = match;
  if (whole === '' && fraction === '') return 'invalid';

  const cents = Number(whole || '0') * 100 + Number(fraction.padEnd(2, '0') || '0');
  return sign === '-' ? -cents : cents;
}

export function formatDate(isoDate: string): string {
  const [y, m, d] = isoDate.split('-');
  return `${d}.${m}.${y}`;
}
