import { useState } from 'react';
import type { Category, LabelingRule, RecurringTemplate } from '@finance/shared';
import { api } from '../api';
import { formatCents } from '../format';

/**
 * Recurring templates — the bill plan (spec 003).
 *
 * Two things this table is deliberately opinionated about:
 *
 *  - **The primary retirement action is End, not Delete** (003-H). Delete is
 *    offered, but a template that has materialized a line cannot be deleted;
 *    the rejection explains why and points at ending instead.
 *  - **The counterparty picker flags a key already used by another non-ended
 *    template and links to it**, rather than letting the save fail with a bare
 *    409 (003-D + 003-N). The server still enforces it; this only makes the
 *    collision visible before the user commits to the form.
 */
export function TemplatesTable({
  templates,
  categories,
  rules,
  currentMonth,
  onChanged,
}: {
  templates: RecurringTemplate[];
  categories: Category[];
  rules: LabelingRule[];
  currentMonth: string;
  onChanged: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState(emptyDraft);

  const categoryName = (id: number) => categories.find((c) => c.id === id)?.name ?? `#${id}`;

  /** Non-ended templates are the set the 003-N uniqueness rule ranges over. */
  const keyOwner = (key: string) =>
    templates.find(
      (t) =>
        t.matchNormalizedCounterparty === key &&
        (t.endMonth === null || t.endMonth >= currentMonth),
    );
  const collision = draft.matchNormalizedCounterparty
    ? keyOwner(draft.matchNormalizedCounterparty.trim())
    : undefined;

  async function create() {
    setError(null);
    setNotice(null);
    try {
      const created = await api.createRecurringTemplate({
        name: draft.name,
        categoryId: Number(draft.categoryId),
        amountCents: Math.round(Number(draft.amountEuros.replace(',', '.')) * 100),
        intervalMonths: Number(draft.intervalMonths),
        expectedDayOfMonth: Number(draft.expectedDayOfMonth),
        startMonth: draft.startMonth,
        matchNormalizedCounterparty: draft.matchNormalizedCounterparty.trim(),
      });
      setDraft(emptyDraft());
      // Review Q1: a template made due in an already-materialized current or
      // future month would otherwise not appear until the next fresh month.
      if (created.addableToMonths.length > 0) {
        setNotice(
          `"${created.name}" is due in ${created.addableToMonths.join(', ')}, which ${
            created.addableToMonths.length === 1 ? 'is' : 'are'
          } already created. Add the line now?`,
        );
        setPendingAdd({ templateId: created.id, months: created.addableToMonths });
      }
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to create template');
    }
  }

  const [pendingAdd, setPendingAdd] = useState<{ templateId: number; months: string[] } | null>(
    null,
  );

  async function addToMonth(month: string, templateId: number) {
    setError(null);
    try {
      await api.addTemplateLineToMonth(month, templateId);
      setPendingAdd(null);
      setNotice(`Line added to ${month}.`);
      onChanged();
    } catch (e) {
      // Acting on the hint is an ordinary insert and can 409 (003-N).
      setError(e instanceof Error ? e.message : 'failed to add the line');
    }
  }

  async function endTemplate(id: number) {
    setError(null);
    try {
      await api.patchRecurringTemplate(id, { endMonth: currentMonth });
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to end template');
    }
  }

  async function remove(id: number) {
    setError(null);
    try {
      await api.deleteRecurringTemplate(id);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to delete template');
    }
  }

  return (
    <section>
      <h2>Recurring bills</h2>
      <p style={{ color: 'var(--muted)' }}>
        Editing a template applies to future months only — months already created
        keep their lines as a historical record.
      </p>
      {error && (
        <p role="alert" style={{ color: 'var(--danger)' }}>
          {error}
        </p>
      )}
      {notice && <p data-testid="template-notice">{notice}</p>}
      {pendingAdd?.months.map((month) => (
        <button key={month} onClick={() => addToMonth(month, pendingAdd.templateId)}>
          Add line to {month}
        </button>
      ))}

      <table data-testid="templates">
        <thead>
          <tr>
            <th>Name</th>
            <th>Category</th>
            <th style={{ textAlign: 'right' }}>Per occurrence</th>
            <th>Cadence</th>
            <th>Day</th>
            <th>Start</th>
            <th>End</th>
            <th>Matches</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {templates.map((t) => (
            <tr key={t.id} data-testid="template-row">
              <td>{t.name}</td>
              <td>{categoryName(t.categoryId)}</td>
              <td style={{ textAlign: 'right' }}>{formatCents(t.amountCents)}</td>
              <td>{cadenceLabel(t.intervalMonths)}</td>
              <td>{t.expectedDayOfMonth}</td>
              <td>{t.startMonth}</td>
              <td>{t.endMonth ?? ''}</td>
              <td>{t.matchNormalizedCounterparty}</td>
              <td style={{ whiteSpace: 'nowrap' }}>
                <button aria-label={`End ${t.name}`} onClick={() => endTemplate(t.id)}>
                  End
                </button>{' '}
                <button aria-label={`Delete ${t.name}`} onClick={() => remove(t.id)}>
                  Delete
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3>Add a bill</h3>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', alignItems: 'flex-end' }}>
        <label>
          Name
          <input
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
          />
        </label>
        <label>
          Category
          <select
            value={draft.categoryId}
            onChange={(e) => setDraft({ ...draft, categoryId: e.target.value })}
          >
            <option value="">—</option>
            {categories
              .filter((c) => c.systemKey !== 'transfer' && !c.isIncomeSource && !c.archivedAt)
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
          </select>
        </label>
        <label>
          Amount (€)
          <input
            value={draft.amountEuros}
            onChange={(e) => setDraft({ ...draft, amountEuros: e.target.value })}
          />
        </label>
        <label>
          Every N months
          <input
            type="number"
            min={1}
            value={draft.intervalMonths}
            onChange={(e) => setDraft({ ...draft, intervalMonths: e.target.value })}
          />
        </label>
        <label>
          Day
          <input
            type="number"
            min={1}
            max={31}
            value={draft.expectedDayOfMonth}
            onChange={(e) => setDraft({ ...draft, expectedDayOfMonth: e.target.value })}
          />
        </label>
        <label>
          Start month
          <input
            value={draft.startMonth}
            onChange={(e) => setDraft({ ...draft, startMonth: e.target.value })}
          />
        </label>
        <label>
          {/*
            003-D: pick the counterparty rather than guessing it from the free-text
            name. Existing labeling rules are the reliable source of normalized keys.
          */}
          Counterparty
          <input
            list="counterparty-keys"
            aria-label="Counterparty"
            value={draft.matchNormalizedCounterparty}
            onChange={(e) => setDraft({ ...draft, matchNormalizedCounterparty: e.target.value })}
          />
          <datalist id="counterparty-keys">
            {rules.map((r) => (
              <option key={r.id} value={r.normalizedCounterparty} />
            ))}
          </datalist>
        </label>
        <button onClick={create} data-testid="create-template">
          Add bill
        </button>
      </div>
      {collision && (
        <p data-testid="key-collision" role="alert" style={{ color: 'var(--danger)' }}>
          “{collision.matchNormalizedCounterparty}” is already used by “{collision.name}”. Edit
          that bill instead — two different bills from one counterparty are one
          template plus a category envelope.
        </p>
      )}
    </section>
  );
}

function cadenceLabel(intervalMonths: number): string {
  if (intervalMonths === 1) return 'Monthly';
  if (intervalMonths === 3) return 'Quarterly';
  if (intervalMonths === 12) return 'Yearly';
  return `Every ${intervalMonths} months`;
}

function emptyDraft() {
  return {
    name: '',
    categoryId: '',
    amountEuros: '',
    intervalMonths: '1',
    expectedDayOfMonth: '1',
    startMonth: '',
    matchNormalizedCounterparty: '',
  };
}
