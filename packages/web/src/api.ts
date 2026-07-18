import type {
  Account,
  BudgetLine,
  BudgetLineCreate,
  BudgetLinePatch,
  BudgetMonth,
  Category,
  CommitRequest,
  CommitResult,
  ExtendHistoryResult,
  GroupPatch,
  ImportDetail,
  LabelingRule,
  LabelingRulePatch,
  RecurringTemplate,
  RecurringTemplateCreate,
  RecurringTemplatePatch,
  RecurringTemplateResponse,
  RowPatch,
  Transaction,
  TransactionPatch,
  TransactionPatchResult,
  UncreatedBudgetMonth,
} from '@finance/shared';

/** Thin fetch wrapper over the local API (loopback-only, no auth). */
class ApiError extends Error {}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}) as { error?: string });
    throw new ApiError(body.error ?? `${res.status} ${res.statusText}`);
  }
  if (res.status === 204) {
    return undefined as T;
  }
  return (await res.json()) as T;
}

export const api = {
  listAccounts: () => request<Account[]>('/accounts'),
  listCategories: () => request<Category[]>('/categories'),

  async uploadImport(accountId: number, file: File): Promise<ImportDetail> {
    const form = new FormData();
    form.append('accountId', String(accountId));
    form.append('file', file);
    const res = await fetch('/api/imports', { method: 'POST', body: form });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}) as { error?: string });
      throw new ApiError(body.error ?? `${res.status} ${res.statusText}`);
    }
    return (await res.json()) as ImportDetail;
  },

  getImport: (importId: number) => request<ImportDetail>(`/imports/${importId}`),

  patchGroup: (importId: number, normalizedCounterparty: string, patch: GroupPatch) =>
    request<ImportDetail>(
      `/imports/${importId}/groups/${encodeURIComponent(normalizedCounterparty)}`,
      { method: 'PATCH', body: JSON.stringify(patch) },
    ),

  patchRow: (importId: number, rowId: number, patch: RowPatch) =>
    request<ImportDetail>(`/imports/${importId}/rows/${rowId}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  commitImport: (importId: number, body: CommitRequest) =>
    request<CommitResult>(`/imports/${importId}/commit`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  discardImport: (importId: number) =>
    request<{ status: string }>(`/imports/${importId}/discard`, { method: 'POST' }),

  extendHistory: (importId: number) =>
    request<ExtendHistoryResult>(`/imports/${importId}/extend-history`, { method: 'POST' }),

  listTransactions: (params?: { accountId?: number }) =>
    request<Transaction[]>(
      `/transactions${params?.accountId !== undefined ? `?accountId=${params.accountId}` : ''}`,
    ),

  patchTransaction: (id: number, patch: TransactionPatch) =>
    request<TransactionPatchResult>(`/transactions/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  listLabelingRules: () => request<LabelingRule[]>('/labeling-rules'),

  patchLabelingRule: (id: number, patch: LabelingRulePatch) =>
    request<LabelingRule>(`/labeling-rules/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  deleteLabelingRule: (id: number) =>
    request<void>(`/labeling-rules/${id}`, { method: 'DELETE' }),

  // --- Budgets (spec 003) --------------------------------------------------

  /**
   * `open` marks a month the user deliberately navigated to, which the API may
   * materialize; without it only the current month is auto-created, so merely
   * glancing at a month never brings it into being (decision 003-C).
   */
  getBudgetMonth: (month: string, opts?: { open?: boolean }) =>
    request<BudgetMonth | UncreatedBudgetMonth>(
      `/budgets/${month}${opts?.open ? '?open=1' : ''}`,
    ),

  materializeMonth: (month: string) =>
    request<{ month: string; budgetId: number }>('/budgets', {
      method: 'POST',
      body: JSON.stringify({ month }),
    }),

  patchBudgetMonth: (month: string, note: string | null) =>
    request<{ month: string; note: string | null }>(`/budgets/${month}`, {
      method: 'PATCH',
      body: JSON.stringify({ note }),
    }),

  /** The budget-making screen's single save (upsert; omitted categories untouched). */
  saveEnvelopes: (month: string, envelopes: { categoryId: number; amountCents: number | null }[]) =>
    request<{ month: string; lines: BudgetLine[] }>(`/budgets/${month}/envelopes`, {
      method: 'PUT',
      body: JSON.stringify({ envelopes }),
    }),

  createBudgetLine: (month: string, body: BudgetLineCreate) =>
    request<BudgetLine>(`/budgets/${month}/lines`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  patchBudgetLine: (month: string, id: number, patch: BudgetLinePatch) =>
    request<BudgetLine>(`/budgets/${month}/lines/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  deleteBudgetLine: (month: string, id: number) =>
    request<void>(`/budgets/${month}/lines/${id}`, { method: 'DELETE' }),

  /** Act on an `addableToMonths` hint — an ordinary line insert that can 409. */
  addTemplateLineToMonth: (month: string, templateId: number) =>
    request<BudgetLine>(`/budgets/${month}/lines/from-template/${templateId}`, {
      method: 'POST',
    }),

  listRecurringTemplates: () => request<RecurringTemplate[]>('/recurring-templates'),

  createRecurringTemplate: (body: RecurringTemplateCreate) =>
    request<RecurringTemplateResponse>('/recurring-templates', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  patchRecurringTemplate: (id: number, patch: RecurringTemplatePatch) =>
    request<RecurringTemplateResponse>(`/recurring-templates/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  deleteRecurringTemplate: (id: number) =>
    request<void>(`/recurring-templates/${id}`, { method: 'DELETE' }),
};
