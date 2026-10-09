export { AuditTrail, type AuditEntry } from './audit-trail';
export {
  assertAuthorized,
  assertAuthorizedFor,
  AuthorizationDeniedError,
  AuthorizedContext,
  assertPlatformAuthorized,
  PlatformAuthorization,
  type PlatformCapability,
  InvalidAuthorizedContextError,
} from './authorized-context';
export { SecurityEventsService } from './security-events.service';
export { WriteAuthorizer } from './write-authorizer.service';
export {
  AuditPurgeDisabledError,
  AuditPurgeRefusedError,
  SecurityOperationsService,
  type AuditPurgeReport,
  type KeyUsage,
} from './security-operations.service';
export {
  CLASSIFICATION_MANIFEST,
  dataSubjectMap,
  type DataSubjectLink,
} from './classification-manifest';
export {
  PRIVILEGE_MANIFEST,
  SECURITY_DEFINER_FUNCTIONS,
  TABLE_PRIVILEGES,
  type TablePrivilege,
} from './privilege-manifest';
