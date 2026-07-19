import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { FinanceMode } from '@finance/shared';
import { AssetsPage } from './components/AssetsPage';
import { BudgetsPage } from './components/BudgetsPage';
import { DashboardPage } from './components/DashboardPage';
import { ImportPage } from './components/ImportPage';
import { RulesPage } from './components/RulesPage';
import { TransactionsPage } from './components/TransactionsPage';
import { TriagePage } from './components/TriagePage';
import { api } from './api';

type View = 'dashboard' | 'import' | 'transactions' | 'triage' | 'budgets' | 'assets' | 'rules';

const VIEWS: Array<{ id: View; label: string }> = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'import', label: 'Import' },
  { id: 'transactions', label: 'Transactions' },
  { id: 'budgets', label: 'Budgets' },
  { id: 'assets', label: 'Assets' },
  { id: 'rules', label: 'Rules' },
];

/**
 * The shell-level database-mode notice (proposal 005): permanent, above every
 * view, and never dismissible.
 */
function ModeBanner({ testId, children }: { testId: string; children: ReactNode }) {
  return (
    <div
      // `note`, not `status`: this is a permanent notice, not a live region
      // announcing a change — and `status` would collide with the transient
      // save-confirmation regions the pages already use.
      role="note"
      data-testid={testId}
      style={{
        border: '1px solid var(--warn)',
        borderLeft: '4px solid var(--warn)',
        borderRadius: 6,
        padding: '0.6rem 0.9rem',
        marginBottom: '1rem',
        // Copy in `--text` over the tint, not in `--warn`: `--warn` on the card
        // measures 4.46:1 in the light theme, under the 4.5:1 AA floor, and this
        // banner is the only mitigation for a real CSV landing in the dev DB.
        // `--warn` stays on the border, which is held to the 3:1 non-text floor.
        background: 'var(--warn-surface)',
        color: 'var(--text)',
        fontWeight: 600,
      }}
    >
      {children}
    </div>
  );
}

export function App() {
  // Import stays the landing view: spec 004 adds a dashboard route, it does not
  // say the dashboard becomes the default, and changing it would be a drive-by
  // behavior change to specs 001-003. Noted as a follow-up on the spec.
  const [view, setView] = useState<View>('import');
  // Which database the server is attached to (proposal 005). Nothing can tell a
  // real CSV from a synthetic one at import time, so this banner is the only
  // thing standing between the owner and importing real statements into the
  // seed — it lives in the shell, above every view, and is never dismissible.
  //
  // `unknown` is a state of its own, and it warns too: a guard that vanishes
  // when its own check fails has the wrong polarity. Only a server that
  // affirmatively answers `real` earns a bannerless UI. `loading` stays silent
  // so real mode does not flash a false warning on every page load.
  const [mode, setMode] = useState<FinanceMode | 'loading' | 'unknown'>('loading');
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

  useEffect(() => {
    api
      .getHealth()
      .then((h) => setMode(h.mode))
      .catch(() => setMode('unknown'));
  }, []);

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
      {mode === 'dev' && (
        <ModeBanner testId="dev-mode-banner">
          Synthetic dev data — not your finances. This server is attached to{' '}
          <code>data/dev.db</code>; do not import real statements here. Run <code>npm start</code>{' '}
          for your real database.
        </ModeBanner>
      )}
      {mode === 'unknown' && (
        <ModeBanner testId="mode-unknown-banner">
          Cannot reach the server to confirm which database this is. Do not import anything until
          this resolves — it may be the synthetic seed (<code>data/dev.db</code>) or your real
          database.
        </ModeBanner>
      )}
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
        {view === 'assets' && <AssetsPage />}
        {view === 'rules' && <RulesPage />}
      </main>
    </div>
  );
}
