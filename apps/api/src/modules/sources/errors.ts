/**
 * Source-connector failures (ADR 0019/0020). Every error carries a stable
 * code; messages carry identifiers and codes only, never record values or
 * credentials.
 */
export class SourcesError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly issues: readonly { code: string; path: string; message: string }[] = [],
  ) {
    super(message);
    this.name = 'SourcesError';
  }
}

export class ConnectionNotFoundError extends SourcesError {
  constructor(ref: string) {
    super('connection_not_found', `Source connection ${ref} does not exist`);
    this.name = 'ConnectionNotFoundError';
  }
}

export class AdapterNotRegisteredError extends SourcesError {
  constructor(kind: string) {
    super('adapter_not_registered', `No source adapter is registered for kind ${kind}`);
    this.name = 'AdapterNotRegisteredError';
  }
}

/** A publication must name the version it was based on (0 for the first). */
export class PublishBaseVersionRequiredError extends SourcesError {
  constructor(what: string) {
    super('base_version_required', `Publishing ${what} requires expectedBaseVersion`);
    this.name = 'PublishBaseVersionRequiredError';
  }
}

export class ConcurrentSourcePublishError extends SourcesError {
  constructor(
    what: string,
    readonly expected: number,
    readonly latest: number,
  ) {
    super(
      'concurrent_publish',
      `${what} was based on version ${expected}, but version ${latest} is the latest`,
    );
    this.name = 'ConcurrentSourcePublishError';
  }
}

export class MappingInvalidError extends SourcesError {
  constructor(issues: readonly { code: string; path: string; message: string }[]) {
    super('mapping_invalid', `The mapping document is invalid (${issues.length} issues)`, issues);
    this.name = 'MappingInvalidError';
  }
}

export class AuthorityInvalidError extends SourcesError {
  constructor(issues: readonly { code: string; path: string; message: string }[]) {
    super(
      'authority_invalid',
      `The authority declaration is invalid (${issues.length} issues)`,
      issues,
    );
    this.name = 'AuthorityInvalidError';
  }
}

/** A sync run refused before or failed during its run, with a stable code. */
export class SyncRefusedError extends SourcesError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = 'SyncRefusedError';
  }
}
