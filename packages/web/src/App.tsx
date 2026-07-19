import { useCallback, useEffect, useState } from 'react';
import { BudgetsPage } from './components/BudgetsPage';
import { DashboardPage } from './components/DashboardPage';
import { ImportPage } from './components/ImportPage';
import { RulesPage } from './components/RulesPage';
import { TransactionsPage } from './components/TransactionsPage';
import { TriagePage } from './components/TriagePage';
import { api } from './api';

type View = 'dashboard' | 'import' | 'transactions' | 'triage' | 'budgets' | 'rules';

const VIEWS: Array<{ id: View; label: string }> = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'import', label: 'Import' },
  { id: 'transactions', label: 'Transactions' },
  { id: 'budgets', label: 'Budgets' },
  { id: 'rules', label: 'Rules' },
];

export function App() {
  // Import stays the landing view: spec 004 adds a dashboard route, it does not
  // say the dashboard becomes the default, and changing it would be a drive-by
  // behavior change to specs 001-003. Noted as a follow-up on the spec.
  const [view, setView] = useState<View>('import');
  const [triageCount, setTriageCount] = useState(0);
  // Held here so it survives leaving Triage and coming back — see TriagePage.
  const [triageUndo, setTriageUndo] = useState<{ undoToken: string; label: string } | null>(null);

  const refreshTriageCount = useCallback(() => {
    api
      .getTriageCount()
      .then((r) => setTriageCount(r.count))
      .catch(() => undefined);
  }, []);

  useEffect(refreshTriageCount, [refreshTriageCount, view]);

  // Triage is present only while it has work — an empty queue is not a
  // destination. It stays reachable while it is the open view, so draining the
  // last group does not pull the current tab out from under the user.
  const navViews =
    triageCount > 0 || view === 'triage'
      ? [
          ...VIEWS.slice(0, 3),
          { id: 'triage' as const, label: `Triage${triageCount > 0 ? ` (${triageCount})` : ''}` },
          ...VIEWS.slice(3),
        ]
      : VIEWS;

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', maxWidth: 1100, margin: '0 auto', padding: '1rem' }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: '1.5rem', marginBottom: '1.5rem' }}>
        <h1 style={{ fontSize: '1.25rem', margin: 0 }}>HelloFinance</h1>
        <nav style={{ display: 'flex', gap: '0.5rem' }}>
          {navViews.map((v) => (
            <button
              key={v.id}
              onClick={() => setView(v.id)}
              aria-current={view === v.id}
              data-testid={`nav-${v.id}`}
              style={{
                border: 'none',
                background: view === v.id ? 'var(--accent)' : 'transparent',
                color: view === v.id ? 'var(--accent-contrast)' : 'inherit',
                borderRadius: 6,
                padding: '0.35rem 0.75rem',
              }}
            >
              {v.label}
            </button>
          ))}
        </nav>
      </header>
      <main>
        {view === 'dashboard' && (
          <DashboardPage
            onOpenBudgets={() => setView('budgets')}
            onOpenTriage={() => setView('triage')}
          />
        )}
        {view === 'import' && <ImportPage />}
        {view === 'transactions' && <TransactionsPage />}
        {view === 'triage' && (
          <TriagePage
            onOpenRules={() => setView('rules')}
            onChanged={refreshTriageCount}
            lastApply={triageUndo}
            setLastApply={setTriageUndo}
          />
        )}
        {view === 'budgets' && <BudgetsPage />}
        {view === 'rules' && <RulesPage />}
      </main>
    </div>
  );
}
