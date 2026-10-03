import { describe, expect, it, vi } from 'vitest';
import type { SourceAdapterFactory } from '../domain';
import { SourceSyncProcessor } from './application/source-sync.processor';
import { AdapterNotRegisteredError } from './errors';
import { SourceAdapterRegistry } from './source-adapters';

const factory = (kind: 'sugar' | 'hubspot'): SourceAdapterFactory => ({
  kind,
  adapterVersion: 'test',
  validateConfig: () => ({ ok: true }),
  create: () => {
    throw new Error('not used');
  },
});

describe('source adapter registration (ADR 0019 §4)', () => {
  it('registers adapters by kind and refuses an unregistered kind', () => {
    const registry = new SourceAdapterRegistry([factory('sugar')]);
    expect(registry.has('sugar')).toBe(true);
    expect(registry.kinds()).toEqual(['sugar']);
    expect(() => registry.get('gainsight_cs')).toThrow(AdapterNotRegisteredError);
    expect(new SourceAdapterRegistry().has('sugar')).toBe(false);
  });

  it('refuses two adapters for one kind', () => {
    expect(() => new SourceAdapterRegistry([factory('sugar'), factory('sugar')])).toThrow(
      /two source adapters/,
    );
  });
});

describe('source sync processor final failure', () => {
  it('marks the run failed and records a dead letter', async () => {
    const abandon = vi.fn().mockResolvedValue(undefined);
    const deadLetter = vi.fn().mockResolvedValue(undefined);
    const processor = new SourceSyncProcessor(
      {} as never,
      { abandon } as never,
      { forTenantId: vi.fn().mockResolvedValue({ tenantId: 't' }) } as never,
      { onFinalFailure: deadLetter } as never,
      { context: { processingEnabled: false } } as never,
    );
    const job = {
      queue: 'lip-sources',
      name: 'source.sync',
      id: 'src-x',
      data: {
        v: 1,
        tenantId: '11111111-1111-4111-8111-111111111111',
        checkpointId: '22222222-2222-4222-8222-222222222222',
        correlationId: '33333333-3333-4333-8333-333333333333',
      },
      attemptsMade: 7,
      maxAttempts: 8,
      enqueuedAt: 0,
    };
    await (
      processor as unknown as { onFinalFailure: (j: unknown, e: Error) => Promise<void> }
    ).onFinalFailure(job, new Error('boom'));
    expect(abandon).toHaveBeenCalledWith(
      { tenantId: 't' },
      '22222222-2222-4222-8222-222222222222',
      'retries_exhausted',
    );
    expect(deadLetter).toHaveBeenCalledWith(job, expect.any(Error));
  });
});
