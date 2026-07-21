import { useCallback, useEffect, useState } from 'react';
import type {
  BudgetMonth,
  Category,
  LabelingRule,
  RecurringTemplate,
  UncreatedBudgetMonth,
} from '@finance/shared';
import { api } from '../api';
import { BudgetMakingScreen } from './BudgetMakingScreen';
import { BudgetMonthView } from './BudgetMonthView';
import { TemplatesTable } from './TemplatesTable';

type MonthState = BudgetMonth | UncreatedBudgetMonth | null;

function isUncreated(state: MonthState): state is UncreatedBudgetMonth {
  return state !== null && 'uncreated' in state;
}

/** `YYYY-MM` for today, in local time — the month the API auto-materializes. */
function thisMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function shiftMonth(month: string, delta: number): string {
  const [year, m] = month.split('-').map(Number);
  const zeroBased = year! * 12 + (m! - 1) + delta;
  return `${Math.floor(zeroBased / 12)}-${String((zeroBased % 12) + 1).padStart(2, '0')}`;
}

/**
 * Budgets (spec 003): a month picker over the reconciliation view, the
 * budget-making screen behind "Edit goals", and the recurring-bill templates.
 *
 * Navigating to a month does NOT create it — the month only loads with `open`
 * once the user asks for it explicitly, so browsing history leaves no trail of
 * materialized months (decision 003-C).
 */
export function BudgetsPage() {
  const [month, setMonth] = useState<string>(thisMonth());
  const [state, setState] = useState<MonthState>(null);
  const [categories, setCategories] = useState<Category[]>([]);
  const [templates, setTemplates] = useState<RecurringTemplate[]>([]);
  const [rules, setRules] = useState<LabelingRule[]>([]);
  const [editingGoals, setEditingGoals] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (target: string, opts?: { open?: boolean }) => {
      setError(null);
      try {
        const [budget, cats, tmpl, rls] = await Promise.all([
          api.getBudgetMonth(target, opts),
          api.listCategories(),
          api.listRecurringTemplates(),
          api.listLabelingRules(),
        ]);
        setState(budget);
        setCategories(cats);
        setTemplates(tmpl);
        setRules(rls);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'failed to load the month');
      }
    },
    [],
  );

  useEffect(() => {
    // Goal editing belongs to the month it was opened for: carrying it across a
    // month change would drop the user into the editor for a month they only
    // navigated to — and into a closed month's editor, which has nothing to save.
    setEditingGoals(false);
    load(month).catch(() => undefined);
  }, [month, load]);

  async function createMonth() {
    await api.materializeMonth(month);
    await load(month, { open: true });
  }

  async function deleteLine(id: number) {
    setError(null);
    try {
      await api.deleteBudgetLine(month, id);
      await load(month, { open: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to delete the line');
    }
  }

  async function addOneOff(input: {
    name: string;
    categoryId: number;
    amountCents: number;
    matchNormalizedCounterparty: string;
  }) {
    // Errors propagate to the form, which renders them next to the fields that
    // caused them — a 409 on a duplicate counterparty is actionable there.
    await api.createBudgetLine(month, { kind: 'adhoc', ...input });
    await load(month, { open: true });
  }

  async function saveNote(note: string | null) {
    await api.patchBudgetMonth(month, note);
    await load(month, { open: true });
  }

  return (
    <section>
      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: '1rem' }}>
        <button aria-label="Previous month" onClick={() => setMonth(shiftMonth(month, -1))}>
          ‹
        </button>
        <input
          aria-label="Month"
          value={month}
          onChange={(e) => setMonth(e.target.value)}
          style={{ width: 90, textAlign: 'center' }}
        />
        <button aria-label="Next month" onClick={() => setMonth(shiftMonth(month, 1))}>
          ›
        </button>
      </div>

      {error && (
        <p role="alert" style={{ color: 'var(--danger)' }}>
          {error}
        </p>
      )}

      {isUncreated(state) && (
        <div data-testid="month-uncreated">
          {state.closed ? (
            // A closed month that was never budgeted stays that way: creating it
            // now would snapshot today's templates as if they had been planned
            // then (proposal 007).
            <p data-testid="month-closed-uncreated">
              {month} is a closed month — it was never budgeted, and closed months
              are a historical record.
            </p>
          ) : (
            <>
              <p>{month} has not been created yet.</p>
              <button onClick={createMonth}>Materialize month</button>
            </>
          )}
        </div>
      )}

      {state !== null && !isUncreated(state) && !editingGoals && (
        <BudgetMonthView
          month={state}
          categories={categories}
          onEditGoals={() => setEditingGoals(true)}
          onDeleteLine={deleteLine}
          onAddOneOff={addOneOff}
          onSaveNote={saveNote}
        />
      )}

      {state !== null && !isUncreated(state) && editingGoals && (
        <BudgetMakingScreen
          month={state}
          categories={categories}
          onSaved={async () => {
            setEditingGoals(false);
            await load(month, { open: true });
          }}
          onCancel={() => setEditingGoals(false)}
        />
      )}

      <hr style={{ margin: '2rem 0' }} />

      <TemplatesTable
        templates={templates}
        categories={categories}
        rules={rules}
        currentMonth={thisMonth()}
        // Reloaded WITHOUT `open`: editing a template says nothing about the
        // month being browsed, and materializing it would leave a trail of
        // created months behind mere navigation (decision 003-C). A month the
        // user actually opened is already materialized, so it still refreshes.
        onChanged={() => load(month)}
      />
    </section>
  );
}
