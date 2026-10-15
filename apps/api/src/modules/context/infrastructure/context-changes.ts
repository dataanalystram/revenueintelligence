/**
 * The change-record writer lives in the tenancy module since M10D (shared with
 * the extension writers); re-exported here for the context stores.
 */
export { insertContextChange, sourceConnectionId, type ChangeWrite } from '../../tenancy';
