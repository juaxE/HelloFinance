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

export function formatDate(isoDate: string): string {
  const [y, m, d] = isoDate.split('-');
  return `${d}.${m}.${y}`;
}
