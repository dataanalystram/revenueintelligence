import { describe, expect, it } from 'vitest';
import { operatorActor, SecretLikeValueError } from '../../domain';
import { issueTenantContext } from '../tenant-context';
import { AuditFailures, failureReason } from './audit-failures';
import { AuthorizationDeniedError, issueAuthorizedContext } from './authorized-context';

/** Plan §6: failures after authorization are recorded as `failed` (reason code only). */
const tenant = issueTenantContext({
  id: '00000000-0000-4000-8000-000000000001',
  slug: 'acme',
  status: 'active',
} as never);

class Fixture {
  readonly failed: unknown[] = [];
  readonly audit = {
    recordFailed: (actx: unknown, entry: unknown) => {
      this.failed.push(entry);
      return Promise.resolve();
    },
  };
  @AuditFailures('policy.save', 'policy')
  async write(_target: unknown, error?: Error): Promise<string> {
    await Promise.resolve();
    if (error) throw error;
    return 'ok';
  }
}

const actx = () =>
  issueAuthorizedContext({ tenant, actor: operatorActor('ops'), capability: 'config.policy' });

describe('AuditFailures', () => {
  it('records a failed event with a reason code and rethrows the original error', async () => {
    const f = new Fixture();
    const error = Object.assign(new Error('expected latest version 2'), {
      name: 'ConcurrentPublishError',
    });
    await expect(f.write(actx(), error)).rejects.toBe(error);
    expect(f.failed).toEqual([
      { action: 'policy.save', targetKind: 'policy', reason: 'stale_base_version' },
    ]);
  });

  it('records nothing on success, for a dry run (no authorized context) or for a refusal', async () => {
    const f = new Fixture();
    await expect(f.write(actx())).resolves.toBe('ok');
    await expect(f.write(tenant, new Error('x'))).rejects.toThrow('x');
    await expect(
      f.write(actx(), new AuthorizationDeniedError('config.policy', 'capability_not_granted')),
    ).rejects.toBeInstanceOf(AuthorizationDeniedError);
    await expect(
      f.write(actx(), new SecretLikeValueError('policy $.x', 'jwt')),
    ).rejects.toBeInstanceOf(SecretLikeValueError);
    expect(f.failed).toEqual([]);
  });

  it('the original error wins when the failure cannot be recorded', async () => {
    const f = new Fixture();
    f.audit.recordFailed = () => Promise.reject(new Error('audit store down'));
    await expect(f.write(actx(), new Error('business'))).rejects.toThrow('business');
  });

  it('maps errors to reason codes from class or code only', () => {
    const named = (name: string, code?: string) => Object.assign(new Error('m'), { name, code });
    expect(failureReason(named('ProductModelInvalidError'))).toBe('validation_failed');
    expect(failureReason(named('BaseVersionRequiredError'))).toBe('validation_failed');
    expect(failureReason(named('SourcesError', 'concurrent_publish'))).toBe('stale_base_version');
    expect(failureReason(named('Error'))).toBe('operation_failed');
    expect(failureReason('not an error')).toBe('operation_failed');
  });
});
