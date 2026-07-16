import { describe, expect, it } from 'vitest';
import { SHARED_PACKAGE_NAME } from './index';

describe('@finance/shared', () => {
  it('exposes its package name (scaffold smoke test)', () => {
    expect(SHARED_PACKAGE_NAME).toBe('@finance/shared');
  });
});
