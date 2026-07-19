import { useCallback, useEffect, useState } from 'react';
import { ASSET_KINDS, formatEur, type Asset, type AssetKind, type AssetSnapshotEntry } from '@finance/shared';
import { api } from '../api';
import { parseEurosToCents } from '../format';

/**
 * Assets — the holdings that are not bank accounts: investments, loans, and any
 * other non-bank value. The emergency fund is deliberately absent; it is a bank
 * account of kind `buffer` and already reaches net worth that way (001-D).
 *
 * This is its own screen rather than a dashboard card because it is the only
 * WRITE surface among a page of read-only aggregates, and because managing an
 * asset means more than typing this month's number: creating one, retiring one,
 * and bringing a retired one back.
 */

const smallButton: React.CSSProperties = {
  border: '1px solid var(--border)',
  background: 'transparent',
  color: 'inherit',
  borderRadius: 6,
  padding: '0.15rem 0.5rem',
  fontSize: '0.75rem',
};

const KIND_LABEL: Record<AssetKind, string> = {
  investment: 'Investment',
  loan: 'Loan',
  other: 'Other',
};

export function AssetsPage() {
  const [month, setMonth] = useState<string | null>(null);
  const [entries, setEntries] = useState<AssetSnapshotEntry[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingArchive, setPendingArchive] = useState<AssetSnapshotEntry | null>(null);

  /**
   * The month comes from the SERVER, never the browser clock: `FINANCE_NOW`
   * pins "today" in tests, and a snapshot written against the browser's idea of
   * the month would land outside the span the rest of the app is reading. The
   * commitments endpoint reports the month it used, which is the app's existing
   * answer to "what month does the server think it is".
   */
  const loadMonth = useCallback(async () => {
    const commitments = await api.getRecurringCommitments();
    setMonth(commitments.month);
    return commitments.month;
  }, []);

  const load = useCallback(async (target: string) => {
    const [rows, all] = await Promise.all([api.getAssetSnapshots(target), api.listAssets()]);
    setEntries(rows);
    setAssets(all);
    setDrafts(
      Object.fromEntries(
        rows.map((r) => [r.assetId, r.valueCents === null ? '' : formatEur(r.valueCents)]),
      ),
    );
  }, []);

  useEffect(() => {
    loadMonth()
      .then(load)
      .catch((e) => setError(e instanceof Error ? e.message : 'failed to load assets'));
  }, [loadMonth, load]);

  /** Reports whether the work succeeded — callers that clear a form need to know. */
  async function run(work: () => Promise<void>): Promise<boolean> {
    setError(null);
    try {
      await work();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'something went wrong');
      return false;
    }
  }

  async function save() {
    if (month === null) return;
    const values: { assetId: number; valueCents: number }[] = [];
    for (const entry of entries) {
      const parsed = parseEurosToCents(drafts[entry.assetId] ?? '');
      if (parsed === 'invalid') {
        setStatus(`"${entry.name}" is not a valid amount`);
        return;
      }
      // Omitted rather than zeroed: a blank field means "no value entered", and
      // the API leaves an omitted asset untouched.
      if (parsed === null) continue;
      values.push({ assetId: entry.assetId, valueCents: parsed });
    }
    await api.saveAssetSnapshots(month, values);
    setStatus(`Saved ${values.length} value(s) for ${month}`);
    await load(month);
  }

  /** `zeroFirst` writes the closing 0 for `month` before archiving. */
  async function archive(entry: AssetSnapshotEntry, zeroFirst: boolean) {
    if (month === null) return;
    setPendingArchive(null);
    if (zeroFirst) {
      await api.saveAssetSnapshots(month, [{ assetId: entry.assetId, valueCents: 0 }]);
    }
    await api.patchAsset(entry.assetId, { archived: true });
    setStatus(
      zeroFirst ? `Archived "${entry.name}" after closing it at 0,00 €` : `Archived "${entry.name}"`,
    );
    await load(month);
  }

  async function restore(asset: Asset) {
    if (month === null) return;
    await api.patchAsset(asset.id, { archived: false });
    setStatus(`Restored "${asset.name}"`);
    await load(month);
  }

  async function create(name: string, kind: AssetKind) {
    if (month === null) return;
    await api.createAsset({ name, kind });
    setStatus(`Added "${name}"`);
    await load(month);
  }

  const archived = assets.filter((a) => a.archivedAt !== null);

  if (month === null) {
    return <p data-testid="assets-loading">{error ?? 'Loading…'}</p>;
  }

  return (
    <div data-testid="assets">
      {error && (
        <p role="alert" style={{ color: 'var(--danger)' }}>
          {error}
        </p>
      )}

      <section className="card">
        <h2 style={{ fontSize: '1rem', marginTop: 0 }}>Values for {month}</h2>
        <p style={{ fontSize: '0.8rem', color: 'var(--muted)', marginTop: 0 }}>
          Loans are entered as positive balances and subtracted in net worth. A month you skip
          reuses the last value entered, so net worth never drops to zero on a gap.
        </p>

        {entries.length === 0 ? (
          <p data-testid="assets-empty">
            No assets yet. Add an investment or a loan below and its value will start counting
            towards net worth.
          </p>
        ) : (
          <>
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }} data-testid="asset-entry">
              {entries.map((entry) => (
                <li
                  key={entry.assetId}
                  data-testid={`asset-${entry.assetId}`}
                  data-cents={entry.valueCents ?? ''}
                  style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.4rem' }}
                >
                  <label style={{ flex: 1, fontSize: '0.85rem' }}>
                    {entry.name}
                    <span style={{ color: 'var(--muted)' }}> · {entry.kind}</span>
                    {entry.carriedForward && (
                      <span style={{ color: 'var(--muted)', fontSize: '0.75rem' }}>
                        {' '}
                        (carried from {entry.sourceMonth})
                      </span>
                    )}
                  </label>
                  <input
                    aria-label={`${entry.name} value`}
                    value={drafts[entry.assetId] ?? ''}
                    onChange={(e) => setDrafts((d) => ({ ...d, [entry.assetId]: e.target.value }))}
                    style={{ width: '9rem', textAlign: 'right' }}
                  />
                  <button
                    onClick={() => setPendingArchive(entry)}
                    style={{ fontSize: '0.75rem' }}
                    data-testid={`archive-${entry.assetId}`}
                  >
                    Archive
                  </button>
                </li>
              ))}
            </ul>
            {pendingArchive && (
              <ArchiveConfirm
                entry={pendingArchive}
                month={month}
                onChoose={(zeroFirst) => void run(() => archive(pendingArchive, zeroFirst))}
                onCancel={() => setPendingArchive(null)}
              />
            )}
            <button onClick={() => void run(save)} style={{ marginTop: '0.5rem' }}>
              Save {month}
            </button>
          </>
        )}
        {status && (
          <p role="status" style={{ fontSize: '0.8rem', color: 'var(--muted)' }}>
            {status}
          </p>
        )}
      </section>

      <AddAssetForm onCreate={(name, kind) => run(() => create(name, kind))} />

      {archived.length > 0 && (
        <section className="card" data-testid="archived-assets">
          <h2 style={{ fontSize: '1rem', marginTop: 0 }}>Archived</h2>
          <p style={{ fontSize: '0.8rem', color: 'var(--muted)', marginTop: 0 }}>
            Archiving only hides an asset from the form above. Its snapshots keep counting in net
            worth for every month from the last value entered, which is why retiring one means
            entering a closing 0 first.
          </p>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {archived.map((asset) => (
              <li
                key={asset.id}
                data-testid={`archived-asset-${asset.id}`}
                style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.3rem' }}
              >
                <span style={{ flex: 1, fontSize: '0.85rem' }}>
                  {asset.name}
                  <span style={{ color: 'var(--muted)' }}> · {asset.kind}</span>
                </span>
                <button
                  onClick={() => void run(() => restore(asset))}
                  style={smallButton}
                  data-testid={`restore-${asset.id}`}
                >
                  Restore
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function AddAssetForm({ onCreate }: { onCreate: (name: string, kind: AssetKind) => Promise<boolean> }) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<AssetKind>('investment');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (name.trim() === '') return;
    setBusy(true);
    try {
      // Only clear on success — wiping a rejected name makes the user retype it.
      if (await onCreate(name.trim(), kind)) {
        setName('');
        setKind('investment');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card" onSubmit={submit} data-testid="add-asset">
      <h2 style={{ fontSize: '1rem', marginTop: 0 }}>Add an asset</h2>
      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <label style={{ display: 'flex', flexDirection: 'column', fontSize: '0.8rem', gap: '0.2rem' }}>
          Name
          <input
            aria-label="Asset name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Index fund"
            disabled={busy}
          />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', fontSize: '0.8rem', gap: '0.2rem' }}>
          Kind
          <select
            aria-label="Asset kind"
            value={kind}
            onChange={(e) => setKind(e.target.value as AssetKind)}
            disabled={busy}
          >
            {ASSET_KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" disabled={busy || name.trim() === ''}>
          Add asset
        </button>
      </div>
      <p style={{ fontSize: '0.75rem', color: 'var(--muted)', marginBottom: 0 }}>
        A loan is entered as a positive balance and subtracted in net worth. Adding an asset does
        not give it a value — enter one above.
      </p>
    </form>
  );
}

/**
 * The archive confirmation. A still-carrying asset gets all three outcomes as
 * explicit buttons; a zero/absent one only needs archive-or-back-out.
 *
 * An inline panel rather than `window.confirm` because the carrying case is a
 * genuine THREE-way choice — zero-then-archive, archive anyway, or back out —
 * and a two-way native confirm has no way to express it. Archiving while a
 * non-zero value carries forward strands that value in net worth for every
 * future month, so backing out has to be reachable and must never be the
 * fall-through.
 */
function ArchiveConfirm({
  entry,
  month,
  onChoose,
  onCancel,
}: {
  entry: AssetSnapshotEntry;
  month: string;
  onChoose: (zeroFirst: boolean) => void;
  onCancel: () => void;
}) {
  const carrying = entry.valueCents !== null && entry.valueCents !== 0;
  return (
    <div
      role="alertdialog"
      aria-label={`Archive ${entry.name}`}
      data-testid="archive-confirm"
      style={{
        border: '1px solid var(--border)',
        borderRadius: 4,
        padding: '0.6rem',
        marginTop: '0.5rem',
        fontSize: '0.8rem',
      }}
    >
      <p style={{ margin: '0 0 0.5rem' }}>
        {carrying ? (
          <>
            <strong>{entry.name}</strong> last reported {formatEur(entry.valueCents!)}. Archiving
            only hides it from this form — that value keeps counting in net worth every month from
            now on.
          </>
        ) : (
          <>
            Archive <strong>{entry.name}</strong>? It disappears from this form; its history is
            kept.
          </>
        )}
      </p>
      <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
        {carrying && (
          <button data-testid="archive-zero-first" onClick={() => onChoose(true)}>
            Close at 0 for {month}, then archive
          </button>
        )}
        <button data-testid="archive-anyway" onClick={() => onChoose(false)}>
          {carrying ? 'Archive anyway' : 'Archive'}
        </button>
        <button data-testid="archive-cancel" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
