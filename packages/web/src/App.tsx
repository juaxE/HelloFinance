import { useState } from 'react';
import { BudgetsPage } from './components/BudgetsPage';
import { ImportPage } from './components/ImportPage';
import { RulesPage } from './components/RulesPage';
import { TransactionsPage } from './components/TransactionsPage';

type View = 'import' | 'transactions' | 'budgets' | 'rules';

const VIEWS: Array<{ id: View; label: string }> = [
  { id: 'import', label: 'Import' },
  { id: 'transactions', label: 'Transactions' },
  { id: 'budgets', label: 'Budgets' },
  { id: 'rules', label: 'Rules' },
];

export function App() {
  const [view, setView] = useState<View>('import');

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', maxWidth: 960, margin: '0 auto', padding: '1rem' }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: '1.5rem', marginBottom: '1.5rem' }}>
        <h1 style={{ fontSize: '1.25rem', margin: 0 }}>HelloFinance</h1>
        <nav style={{ display: 'flex', gap: '0.5rem' }}>
          {VIEWS.map((v) => (
            <button
              key={v.id}
              onClick={() => setView(v.id)}
              aria-current={view === v.id}
              style={{
                border: 'none',
                background: view === v.id ? 'var(--accent)' : 'transparent',
                color: view === v.id ? 'white' : 'inherit',
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
        {view === 'import' && <ImportPage />}
        {view === 'transactions' && <TransactionsPage />}
        {view === 'budgets' && <BudgetsPage />}
        {view === 'rules' && <RulesPage />}
      </main>
    </div>
  );
}
