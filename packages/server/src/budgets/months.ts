/**
 * Month arithmetic for budgets (spec 003). Months are `YYYY-MM` strings and are
 * compared lexicographically, which is ordering-correct for zero-padded ISO
 * months — so no Date objects are involved and there is no timezone to get
 * wrong. The only place a real clock appears is `currentMonth`, which the app
 * injects so tests can pin "now" (the seeded fixtures end 2026-06, before the
 * real current month).
 */

/** Split `YYYY-MM` into its numeric parts. Assumes Zod-validated input. */
function parseMonth(month: string): { year: number; month: number } {
  return { year: Number(month.slice(0, 4)), month: Number(month.slice(5, 7)) };
}

function formatMonth(year: number, month: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`;
}

/**
 * `(b.year·12 + b.month) − (a.year·12 + a.month)` — the spec's due-month
 * formula. Negative when `b` precedes `a`.
 */
export function monthsBetween(a: string, b: string): number {
  const from = parseMonth(a);
  const to = parseMonth(b);
  return to.year * 12 + to.month - (from.year * 12 + from.month);
}

/** The month `offset` months after `month` (negative offsets go backwards). */
export function addMonths(month: string, offset: number): string {
  const { year, month: m } = parseMonth(month);
  const zeroBased = year * 12 + (m - 1) + offset;
  return formatMonth(Math.floor(zeroBased / 12), (zeroBased % 12) + 1);
}

/** The calendar month immediately before `month` — the only lookback prefill uses. */
export function previousMonth(month: string): string {
  return addMonths(month, -1);
}

/** Number of days in `YYYY-MM`, leap years included. */
export function daysInMonth(month: string): number {
  const { year, month: m } = parseMonth(month);
  // Day 0 of the next month is the last day of this one.
  return new Date(Date.UTC(year, m, 0)).getUTCDate();
}

/**
 * Clamp a template's expected day to the target month's length (decision
 * 003-A): day 31 shows on the 30th in June and the 28th/29th in February,
 * rather than the line vanishing from months that lack the day.
 */
export function clampDayToMonth(day: number, month: string): number {
  return Math.min(day, daysInMonth(month));
}

/** First and last calendar dates of `month`, as `YYYY-MM-DD`. */
export function monthDateRange(month: string): { start: string; end: string } {
  return { start: `${month}-01`, end: `${month}-${String(daysInMonth(month)).padStart(2, '0')}` };
}

/** The `YYYY-MM` a Date falls in, read in local time (matches the user's calendar). */
export function monthOf(date: Date): string {
  return formatMonth(date.getFullYear(), date.getMonth() + 1);
}

/**
 * Is a template with this cadence due in month `target`? Spec 003:
 * within `[startMonth, endMonth]` **and** on the cadence phase anchored at
 * `startMonth`. A non-due month simply gets no line — the full per-occurrence
 * charge lands once, in the month it is actually billed (decision 001-H).
 */
export function isTemplateDue(
  template: { startMonth: string; endMonth: string | null; intervalMonths: number },
  target: string,
): boolean {
  const offset = monthsBetween(template.startMonth, target);
  if (offset < 0) return false;
  if (template.endMonth !== null && target > template.endMonth) return false;
  return offset % template.intervalMonths === 0;
}

/**
 * A template is "ended" once its `end_month` is strictly before the current
 * month — the set decision 003-N's key uniqueness is enforced over.
 */
export function isTemplateEnded(template: { endMonth: string | null }, currentMonth: string): boolean {
  return template.endMonth !== null && template.endMonth < currentMonth;
}
