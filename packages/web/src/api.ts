import type {
  Account,
  Category,
  CommitRequest,
  CommitResult,
  ExtendHistoryResult,
  GroupPatch,
  ImportDetail,
  LabelingRule,
  LabelingRulePatch,
  RowPatch,
  Transaction,
  TransactionPatch,
  TransactionPatchResult,
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
};
