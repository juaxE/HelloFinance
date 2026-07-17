import { useEffect, useState } from 'react';
import type { Category, LabelingRule } from '@finance/shared';
import { api } from '../api';

/** Spec 002 "Rules management" (Settings): normalized counterparty -> category, editable/deletable. */
export function RulesPage() {
  const [rules, setRules] = useState<LabelingRule[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    refresh().catch((e) => setError(e instanceof Error ? e.message : 'failed to load'));
  }, []);

  async function refresh() {
    const [r, c] = await Promise.all([api.listLabelingRules(), api.listCategories()]);
    setRules(r);
    setCategories(c);
  }

  async function retarget(id: number, categoryId: number) {
    setError(null);
    try {
      await api.patchLabelingRule(id, { categoryId });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to update rule');
    }
  }

  async function remove(id: number) {
    setError(null);
    try {
      await api.deleteLabelingRule(id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'failed to delete rule');
    }
  }

  return (
    <section>
      <h2>Labeling rules</h2>
      {error && (
        <p role="alert" style={{ color: 'var(--danger)' }}>
          {error}
        </p>
      )}
      <table>
        <thead>
          <tr>
            <th>Normalized counterparty</th>
            <th>Example</th>
            <th>Category</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rules.map((r) => (
            <tr key={r.id}>
              <td>{r.normalizedCounterparty}</td>
              <td>{r.exampleRaw}</td>
              <td>
                <select
                  aria-label={`Category for rule ${r.normalizedCounterparty}`}
                  value={r.categoryId}
                  onChange={(e) => retarget(r.id, Number(e.target.value))}
                >
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </td>
              <td>
                <button onClick={() => remove(r.id)}>Delete</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
