/**
 * Money is integer cents everywhere except the UI edge (CLAUDE.md
 * non-negotiable #3). This is the only place a euro amount is formatted, and it
 * lives in the shared package so the API's numbers and the UI's rendering of
 * them can never disagree about the format (spec 004).
 */

/** `1 234,56 €` — Finnish grouping (non-breaking space) and decimal comma. */
export function formatEur(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const euros = Math.floor(abs / 100).toLocaleString('fi-FI');
  const remainder = String(abs % 100).padStart(2, '0');
  return `${sign}${euros},${remainder} €`;
}
