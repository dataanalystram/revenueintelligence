import type { AuditReasonCode } from '../domain';

/**
 * A governance refusal (M10A2). `code` is a closed audit reason code, so a
 * refusal after authorization is recorded as `failed` with exactly that reason
 * (`@AuditFailures`); messages carry identifiers and codes only.
 */
export class GovernanceError extends Error {
  constructor(
    readonly code: AuditReasonCode,
    message: string,
    readonly detail?: Readonly<Record<string, string | number>>,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ModuleDisabledError extends GovernanceError {
  constructor(readonly moduleKey: string) {
    super('module_disabled', `Module ${moduleKey} is disabled for this tenant`);
  }
}
