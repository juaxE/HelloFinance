import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import type { Db } from '../src/db/client';
import { categories, labelingRules } from '../src/db/schema';
import { createTestDb } from './helpers';

let db: Db;
let app: FastifyInstance;
let groceriesId: number;
let otherId: number;

beforeEach(async () => {
  db = createTestDb();
  app = buildApp(db);
  await app.ready();
  groceriesId = db.select().from(categories).where(eq(categories.name, 'Groceries')).get()!.id;
  otherId = db.select().from(categories).where(eq(categories.name, 'Other')).get()!.id;
  db.insert(labelingRules)
    .values({
      normalizedCounterparty: 'K-MARKET',
      categoryId: groceriesId,
      exampleRaw: 'K-Market Kamppi',
    })
    .run();
});

afterEach(async () => {
  await app.close();
});

describe('labeling rules management (spec 002 Settings)', () => {
  it('lists rules', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/labeling-rules' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ normalizedCounterparty: 'K-MARKET', categoryId: groceriesId });
  });

  it('retargets a rule to a different category', async () => {
    const rule = db.select().from(labelingRules).get()!;
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/labeling-rules/${rule.id}`,
      payload: { categoryId: otherId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().categoryId).toBe(otherId);
  });

  it('404s retargeting a missing rule', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/labeling-rules/9999',
      payload: { categoryId: otherId },
    });
    expect(res.statusCode).toBe(404);
  });

  it('deletes a rule', async () => {
    const rule = db.select().from(labelingRules).get()!;
    const res = await app.inject({ method: 'DELETE', url: `/api/labeling-rules/${rule.id}` });
    expect(res.statusCode).toBe(204);
    expect(db.select().from(labelingRules).all()).toHaveLength(0);
  });

  it('404s deleting a missing rule', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/labeling-rules/9999' });
    expect(res.statusCode).toBe(404);
  });
});
