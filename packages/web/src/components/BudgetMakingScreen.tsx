import { useState } from 'react';
import type { BudgetMonth, Category } from '@finance/shared';
import { api } from '../api';
import { formatCents, parseEurosToCents } from '../format';

/**
 * The budget-making screen (spec 003): one row per envelope-relevant category
 * with a goal input.
 *
 * Two decisions drive the whole design:
 *
 *  - **Prefill is rendering-only (003-K).** A suggestion is the previous month's
 *    envelope, rendered *visually distinct* from a confirmed amount, and an
 *    untouched suggestion creates nothing. Auto-creating envelopes would make
 *    every month look budgeted and destroy the "did I budget this month?"
 *    signal, so nothing here writes until Save.
 *  - **Empty is normal.** A category left blank is a deliberate choice; its
 *    spend flows to "unbudgeted". No badges, no warning styling, no count of
 *    "unbudgeted categories".
 *
 * Confirming a suggestion must not require retyping it: with ~15 mostly-stable
 * categories, "accept last month's number" is the common case, so a suggestion
 * is one click (or Enter/Space — it is a real button) to confirm. Confirming
 * changes the input's state, not the database.
 */

type Draft = {
  /**
   * Exactly what the user has typed, kept as text rather than re-derived from
   * the parsed cents. Reformatting on every keystroke makes the field
   * untypeable: with `value={(cents/100).toFixed(2)}`, typing "4" renders
   * "4.00" and the next character lands after the decimals, so no one can
   * reach 40,00 € by typing. Empty text is "no envelope".
   */
  text: string;
  /** True while the shown number is still only a suggestion. */
  isSuggestion: boolean;
};

/** A draft's committed cents, or `'invalid'` if the text is not a money value. */
function draftCents(draft: Draft): number | null | 'invalid' {
  return parseEurosToCents(draft.text);
}

export function BudgetMakingScreen({
  month,
  categories,
  onSaved,
  onCancel,
}: {
  month: BudgetMonth;
  categories: Category[];
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [drafts, setDrafts] = useState<Map<number, Draft>>(() => initialDrafts(month));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const categoryName = (id: number) => categories.find((c) => c.id === id)?.name ?? `#${id}`;

  function update(categoryId: number, next: Draft) {
    setDrafts((prev) => new Map(prev).set(categoryId, next));
  }

  function confirmSuggestion(categoryId: number, suggested: number) {
    // Promotes suggestion -> confirmed in the input's state only. Still nothing
    // in the database until Save.
    update(categoryId, { text: centsToInput(suggested), isSuggestion: false });
  }

  function typeAmount(categoryId: number, raw: string) {
    // The text is stored verbatim — an empty input is "no envelope", a typed 0
    // is a deliberate goal of zero, and the two must stay distinguishable
    // (spec: "envelope 0 != no envelope"). Parsing happens at save.
    update(categoryId, { text: raw, isSuggestion: false });
  }

  async function save() {
    setError(null);

    const touched = [...drafts.entries()].filter(([, draft]) => !draft.isSuggestion);

    const invalid = touched.filter(([, draft]) => draftCents(draft) === 'invalid');
    if (invalid.length > 0) {
      setError(
        `Not a valid amount for ${invalid.map(([id]) => categoryName(id)).join(', ')} — ` +
          `use digits, e.g. 400 or 400,50.`,
      );
      return;
    }

    setSaving(true);
    try {
      // Only categories the user actually touched are sent. An untouched
      // suggestion is NOT a value, so it is omitted rather than saved — and the
      // endpoint leaves omitted categories alone.
      const envelopes = touched
        .map(([categoryId, draft]) => ({
          categoryId,
          amountCents: draftCents(draft) as number | null,
        }))
        .filter(({ categoryId, amountCents }) => amountCents !== originalValue(month, categoryId));
      await api.saveEnvelopes(month.month, envelopes);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to save goals');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section>
      <h2>Set goals for {month.month}</h2>
      <p style={{ color: 'var(--muted)' }}>
        Leave a category empty if you do not want a goal for it — its spending
        will simply show as unbudgeted.
      </p>
      {error && (
        <p role="alert" style={{ color: 'var(--danger)' }}>
          {error}
        </p>
      )}

      <table data-testid="goal-inputs">
        <thead>
          <tr>
            <th>Category</th>
            <th>Already committed</th>
            <th>Goal</th>
            <th style={{ textAlign: 'right' }}>Planned total</th>
          </tr>
        </thead>
        <tbody>
          {month.envelopeCandidates.map((candidate) => {
            const draft = drafts.get(candidate.categoryId)!;
            const named = month.lines.filter(
              (l) => l.categoryId === candidate.categoryId && l.matchNormalizedCounterparty,
            );
            const parsed = draftCents(draft);
            const shownText =
              draft.isSuggestion && candidate.suggestedAmountCents !== null
                ? centsToInput(candidate.suggestedAmountCents)
                : draft.text;
            const committed = typeof parsed === 'number' ? parsed : 0;
            const plannedSubtotal = committed + named.reduce((s, l) => s + l.amountCents, 0);

            return (
              <tr key={candidate.categoryId} data-testid="goal-row">
                <td>{categoryName(candidate.categoryId)}</td>
                <td style={{ color: 'var(--muted)' }}>
                  {named.length === 0
                    ? ''
                    : named.map((l) => `${l.name} ${formatCents(l.amountCents)}`).join(', ')}
                </td>
                <td>
                  <input
                    aria-label={`Goal for ${categoryName(candidate.categoryId)}`}
                    data-testid="goal-input"
                    data-suggestion={draft.isSuggestion ? 'true' : 'false'}
                    value={shownText}
                    inputMode="decimal"
                    aria-invalid={parsed === 'invalid'}
                    onChange={(e) => typeAmount(candidate.categoryId, e.target.value)}
                    style={{
                      width: 100,
                      textAlign: 'right',
                      // The visual distinction the spec requires: a suggestion
                      // reads as a placeholder, a confirmed amount as real text.
                      color: draft.isSuggestion ? 'var(--muted)' : 'inherit',
                      fontStyle: draft.isSuggestion ? 'italic' : 'normal',
                      opacity: draft.isSuggestion ? 0.65 : 1,
                    }}
                  />
                  {draft.isSuggestion && candidate.suggestedAmountCents !== null && (
                    <button
                      data-testid="confirm-suggestion"
                      aria-label={`Confirm suggested goal for ${categoryName(candidate.categoryId)}`}
                      onClick={() =>
                        confirmSuggestion(candidate.categoryId, candidate.suggestedAmountCents!)
                      }
                      style={{ marginLeft: '0.5rem' }}
                    >
                      Use last month
                    </button>
                  )}
                </td>
                <td style={{ textAlign: 'right' }} data-testid="planned-subtotal">
                  {formatCents(plannedSubtotal)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div style={{ marginTop: '1rem', display: 'flex', gap: '0.5rem' }}>
        <button onClick={save} disabled={saving} data-testid="save-goals">
          {saving ? 'Saving…' : 'Save goals'}
        </button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    </section>
  );
}

/**
 * A category starts as its existing envelope (confirmed), or as the previous
 * month's amount (a suggestion), or blank.
 */
function initialDrafts(month: BudgetMonth): Map<number, Draft> {
  return new Map(
    month.envelopeCandidates.map((c) => [
      c.categoryId,
      c.envelopeAmountCents !== null
        ? { text: centsToInput(c.envelopeAmountCents), isSuggestion: false }
        : { text: '', isSuggestion: c.suggestedAmountCents !== null },
    ]),
  );
}

/**
 * Cents as editable input text — plain `123.45`, no thousands separators or
 * currency symbol, so the value stays easy to edit. `formatCents` is for
 * display; this is for a text field the user is about to type into.
 */
function centsToInput(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

function originalValue(month: BudgetMonth, categoryId: number): number | null {
  return (
    month.envelopeCandidates.find((c) => c.categoryId === categoryId)?.envelopeAmountCents ?? null
  );
}
