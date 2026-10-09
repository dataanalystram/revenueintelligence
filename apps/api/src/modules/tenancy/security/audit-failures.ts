import { AsyncLocalStorage } from 'node:async_hooks';
import { Logger } from '@nestjs/common';
import {
  SecretLikeValueError,
  type AuditAction,
  type AuditReasonCode,
  type AuditTargetKind,
} from '../../domain';
import type { AuditTrail } from './audit-trail';
import {
  AuthorizationDeniedError,
  AuthorizedContext,
  InvalidAuthorizedContextError,
} from './authorized-context';

const logger = new Logger('AuditFailures');
/** Set while an audited write runs: a nested audited call leaves the failure to the outermost one. */
const inAuditedWrite = new AsyncLocalStorage<true>();

/** Refusals already recorded as `denied` (or never authorized): no `failed` event. */
function isRefusal(error: unknown): boolean {
  return (
    error instanceof AuthorizationDeniedError ||
    error instanceof InvalidAuthorizedContextError ||
    error instanceof SecretLikeValueError ||
    (typeof error === 'object' &&
      error !== null &&
      // Already recorded as denied, or a broken chain that must not be extended.
      ['audit_purge_disabled', 'audit_chain_broken'].includes(
        String((error as { code?: unknown }).code),
      ))
  );
}

/** A reason code from the error's class or code (never its message, which may echo input). */
export function failureReason(error: unknown): AuditReasonCode {
  const name = error instanceof Error ? error.name : '';
  const code =
    typeof error === 'object' && error !== null ? String((error as { code?: unknown }).code) : '';
  const text = `${name} ${code}`;
  if (/Concurren|Stale|VersionConflict|version_conflict|concurrent_publish|stale/i.test(text)) {
    return 'stale_base_version';
  }
  if (/Invalid|Validation|ConfigError|ZodError|Required|invalid|validation/i.test(text)) {
    return 'validation_failed';
  }
  return 'operation_failed';
}

/**
 * Plan §6: an authorized operation that fails after authorization rolls back
 * (its `allowed` event with it), so the failure is written as a `failed` event
 * in its own transaction, with a reason code only, and the error is rethrown.
 * Applied to privileged service writes whose first argument is the
 * AuthorizedContext; the service exposes its AuditTrail as `audit`. A dry run
 * (a plain TenantContext) records nothing. If the failure cannot be recorded,
 * the original error still wins.
 */
export function AuditFailures(
  action: AuditAction,
  targetKind?: AuditTargetKind,
  /** Records only when this holds for the call's arguments (e.g. a write option). */
  when: (args: readonly unknown[]) => boolean = () => true,
) {
  return (_target: object, _key: string | symbol, descriptor: PropertyDescriptor): void => {
    const original = descriptor.value as (...args: unknown[]) => Promise<unknown>;
    descriptor.value = async function (this: { audit: AuditTrail }, ...args: unknown[]) {
      const nested = inAuditedWrite.getStore() === true;
      try {
        return await inAuditedWrite.run(true, () => original.apply(this, args));
      } catch (error) {
        const first: unknown = args[0];
        if (!nested && first instanceof AuthorizedContext && !isRefusal(error) && when(args)) {
          const actx = first as AuthorizedContext;
          try {
            await this.audit.recordFailed(actx, {
              action,
              ...(targetKind ? { targetKind } : {}),
              reason: failureReason(error),
            });
          } catch (auditError) {
            logger.warn({ action, err: (auditError as Error).name }, 'Failure not recorded');
          }
        }
        throw error;
      }
    };
  };
}
