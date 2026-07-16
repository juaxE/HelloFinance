import { SHARED_PACKAGE_NAME } from '@finance/shared';

/**
 * Placeholder application shell. Real views (dashboard, import/review, budgets)
 * are added per the approved specs under `specs/`. The import from
 * `@finance/shared` exists to prove the monorepo wiring end-to-end.
 */
export function App() {
  return (
    <main
      style={{
        fontFamily: 'system-ui, sans-serif',
        maxWidth: 640,
        margin: '4rem auto',
        padding: '0 1rem',
      }}
    >
      <h1>HelloFinance</h1>
      <p>Local-first personal finance tracker. Scaffolding is in place.</p>
      <p style={{ color: '#666', fontSize: '0.9rem' }}>
        Shared package wired: <code>{SHARED_PACKAGE_NAME}</code>
      </p>
    </main>
  );
}
