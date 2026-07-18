import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import {
  zAssetCreate,
  zAssetPatch,
  zAssetSnapshotsPut,
  zMonthQuery,
  type Asset,
  type AssetSnapshotEntry,
} from '@finance/shared';
import type { Db } from '../db/client';
import { assetSnapshots, assets } from '../db/schema';

/**
 * Assets and manual monthly snapshots (spec 004).
 *
 * Archiving is a form-visibility change only (decision 004-F): it removes the
 * asset from the entry form, and NOTHING else. Snapshots are untouched and keep
 * carrying forward, so no past net-worth figure moves. `PUT` therefore rejects
 * an archived asset — the closing snapshot must come first, and that ordering is
 * enforced here rather than merely documented.
 */
export function registerAssetRoutes(app: FastifyInstance, db: Db): void {
  app.get('/api/assets', async () => db.select().from(assets).all().map(serializeAsset));

  app.post('/api/assets', async (req, reply) => {
    const parsed = zAssetCreate.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation', details: parsed.error.flatten() });
    }
    const row = db.insert(assets).values(parsed.data).returning().get();
    return reply.code(201).send(serializeAsset(row));
  });

  app.patch('/api/assets/:id', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    if (!Number.isInteger(id)) return reply.code(400).send({ error: 'invalid id' });

    const parsed = zAssetPatch.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation', details: parsed.error.flatten() });
    }
    const existing = db.select().from(assets).where(eq(assets.id, id)).get();
    if (!existing) return reply.code(404).send({ error: 'asset not found' });

    const patch = parsed.data;
    const row = db
      .update(assets)
      .set({
        ...(patch.name !== undefined && { name: patch.name }),
        // Archiving never touches snapshots (004-F) — this column is the whole
        // effect, and the net-worth query does not read it.
        ...(patch.archived !== undefined && {
          archivedAt: patch.archived ? new Date() : null,
        }),
      })
      .where(eq(assets.id, id))
      .returning()
      .get();
    return serializeAsset(row);
  });

  /**
   * The snapshot-entry form's source: **non-archived assets only**, each with
   * the month's value pre-filled — carried forward from the latest earlier
   * snapshot when this month has none (decision 004-B).
   *
   * The net-worth endpoint deliberately does NOT share this filter.
   */
  app.get('/api/asset-snapshots', async (req, reply) => {
    const parsed = zMonthQuery.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation', details: parsed.error.flatten() });
    }
    const { month } = parsed.data;

    return db
      .select()
      .from(assets)
      .all()
      .filter((a) => a.archivedAt === null)
      .map((asset): AssetSnapshotEntry => {
        const own = db
          .select()
          .from(assetSnapshots)
          .where(and(eq(assetSnapshots.assetId, asset.id), eq(assetSnapshots.month, month)))
          .get();
        if (own) {
          return {
            assetId: asset.id,
            name: asset.name,
            kind: asset.kind,
            valueCents: own.valueCents,
            carriedForward: false,
            sourceMonth: month,
          };
        }
        const carried = latestSnapshotBefore(db, asset.id, month);
        return {
          assetId: asset.id,
          name: asset.name,
          kind: asset.kind,
          valueCents: carried?.valueCents ?? null,
          carriedForward: carried !== null,
          sourceMonth: carried?.month ?? null,
        };
      });
  });

  /**
   * Upsert the month's snapshot per listed asset. **Partial-save semantics**,
   * same as `PUT …/envelopes` in spec 003: assets omitted from `values` are left
   * untouched, and there is no delete-by-omission.
   */
  app.put('/api/asset-snapshots', async (req, reply) => {
    const parsed = zAssetSnapshotsPut.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation', details: parsed.error.flatten() });
    }
    const { month, values } = parsed.data;

    // Validate the WHOLE payload before writing anything: a partial save is a
    // partial *selection* of assets, not a partially-applied request.
    const byId = new Map(
      db
        .select()
        .from(assets)
        .all()
        .map((a) => [a.id, a]),
    );
    for (const entry of values) {
      const asset = byId.get(entry.assetId);
      if (!asset) {
        return reply.code(400).send({ error: `asset ${entry.assetId} not found` });
      }
      if (asset.archivedAt !== null) {
        return reply.code(400).send({
          error: `"${asset.name}" is archived and cannot take a snapshot`,
          hint: 'enter the final snapshot before archiving; archiving does not stop an asset from carrying forward (decision 004-F)',
        });
      }
    }

    db.transaction((tx) => {
      for (const entry of values) {
        const existing = tx
          .select()
          .from(assetSnapshots)
          .where(and(eq(assetSnapshots.assetId, entry.assetId), eq(assetSnapshots.month, month)))
          .get();
        if (existing) {
          tx.update(assetSnapshots)
            .set({ valueCents: entry.valueCents })
            .where(eq(assetSnapshots.id, existing.id))
            .run();
          continue;
        }
        tx.insert(assetSnapshots)
          .values({ assetId: entry.assetId, month, valueCents: entry.valueCents })
          .run();
      }
    });

    return { month, saved: values.length };
  });
}

function latestSnapshotBefore(
  db: Db,
  assetId: number,
  month: string,
): { month: string; valueCents: number } | null {
  const rows = db
    .select()
    .from(assetSnapshots)
    .where(eq(assetSnapshots.assetId, assetId))
    .all()
    .filter((s) => s.month < month)
    .sort((a, b) => a.month.localeCompare(b.month));
  const last = rows.at(-1);
  return last ? { month: last.month, valueCents: last.valueCents } : null;
}

function serializeAsset(row: typeof assets.$inferSelect): Asset {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    archivedAt: row.archivedAt ? row.archivedAt.getTime() : null,
    createdAt: row.createdAt.getTime(),
  };
}
