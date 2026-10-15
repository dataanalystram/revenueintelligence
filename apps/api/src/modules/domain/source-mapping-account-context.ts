import {
  ACCOUNT_CONTEXT_MIN_VERSION,
  type AccountContextStatus,
} from './canonical/account-context';
import { isAuthoritative, type AuthorityDocument } from './source-authority';
import {
  findSourceField,
  findSourceObject,
  type SourceRecord,
  type SourceSchema,
} from './source-connector';
import type { MappingDocument, ObjectMapping } from './source-mapping-document';

/**
 * M10E (plan §5, ADR 0031): source mapping of account contexts. An object
 * mapped as entity `account_context` carries an `accountContext` block (the
 * plan's `account_context.*` targets); a subscription line may name its
 * context with the relationship `subscription.contextRef` (a source id of a
 * context object of the same connection). Both need adopted canonical ≥ 0.5,
 * module `account_context` enabled (publish: `account_context_mappings_not_enabled`)
 * and the connection holding the `account_context` authority fact. Pure: no I/O.
 */

export const ACCOUNT_CONTEXT_ENTITY = 'account_context' as const;
export const CONTEXT_REF_TARGET = 'subscription.contextRef' as const;
export const ACCOUNT_CONTEXT_MAPPING_MIN_VERSION = ACCOUNT_CONTEXT_MIN_VERSION;

export function isAccountContextEntity(entity: string | undefined): boolean {
  return entity === ACCOUNT_CONTEXT_ENTITY;
}

/** True when the document uses any M10E mapping statement (its `canonical_version_min` is 0.5). */
export function usesAccountContextMapping(doc: {
  readonly objects: readonly {
    readonly entity?: string;
    readonly accountContext?: unknown;
    readonly relationships: readonly { readonly target: string }[];
  }[];
}): boolean {
  return doc.objects.some(
    (o) =>
      isAccountContextEntity(o.entity) ||
      o.accountContext !== undefined ||
      o.relationships.some((r) => r.target === CONTEXT_REF_TARGET),
  );
}

/** One published context type, as mapping publish needs it. */
export interface AccountContextMappingType {
  readonly status: string;
  readonly dimensions: readonly { readonly key: string; readonly required: boolean }[];
  readonly memberRoles: readonly string[];
}

export interface AccountContextMappingContext {
  /** The 0.5 + module gate at publish. */
  readonly gate: 'ok' | 'canonical_version_too_low' | 'module_disabled';
  /** Published context types by key. */
  readonly types: ReadonlyMap<string, AccountContextMappingType>;
}

export type AccountContextMappingCode =
  | 'account_context_mappings_not_enabled'
  | 'context_type_unknown'
  | 'context_dimension_unknown'
  | 'context_dimension_required'
  | 'context_role_unknown'
  | 'invalid_target'
  | 'duplicate_entity'
  | 'unknown_source_field'
  | 'identity_missing'
  | 'identity_unsuitable'
  | 'missing_relationship_target'
  | 'authority_conflict';

export interface AccountContextMappingIssue {
  readonly code: AccountContextMappingCode;
  readonly path: string;
  readonly message: string;
}

const NAME_LIKE = /(^|_)(name|title|label|description)(_c)?$/i;

/**
 * Publish-blocking rules of the M10E statements (plan §5.1, §5.2). The
 * generic relationship rules (`subscription.contextRef` points at an object
 * mapped as `account_context`, the `account_context` authority) run in
 * `validateMapping`; this adds the gate for it and every rule of the
 * `account_context` objects.
 */
export function validateAccountContextMapping(
  doc: MappingDocument,
  input: {
    readonly connectionId: string;
    readonly schema: SourceSchema;
    readonly authority: AuthorityDocument;
    readonly accountContext?: AccountContextMappingContext;
  },
): AccountContextMappingIssue[] {
  const issues: AccountContextMappingIssue[] = [];
  const err = (code: AccountContextMappingCode, path: string, message: string) =>
    issues.push({ code, path, message });
  const gateOpen = input.accountContext?.gate === 'ok';
  const gateMessage = `account contexts need canonical ${ACCOUNT_CONTEXT_MAPPING_MIN_VERSION} and module account_context (${input.accountContext?.gate ?? 'not_enabled'})`;
  const authoritative = isAuthoritative(input.authority, 'account_context', input.connectionId);
  const seenTypes = new Set<string>();

  doc.objects.forEach((obj, i) => {
    const at = `objects.${i}`;
    obj.relationships.forEach((rel, j) => {
      if (rel.target === CONTEXT_REF_TARGET && !gateOpen) {
        err('account_context_mappings_not_enabled', `${at}.relationships.${j}.target`, gateMessage);
      }
    });
    if (!isAccountContextEntity(obj.entity)) {
      if (obj.accountContext) {
        err('invalid_target', `${at}.accountContext`, 'only account_context objects carry it');
      }
      return;
    }
    if (!gateOpen) err('account_context_mappings_not_enabled', `${at}.entity`, gateMessage);
    if (!authoritative) {
      err(
        'authority_conflict',
        `${at}.entity`,
        'account_context writes the account_context fact, for which this connection is not the authority',
      );
    }
    if (!findSourceObject(input.schema, obj.source)) return; // reported by validateMapping
    const field = (name: string, path: string): boolean => {
      if (findSourceField(input.schema, obj.source, name)) return true;
      err('unknown_source_field', path, `${obj.source}.${name} is not in the snapshot`);
      return false;
    };
    // Identity: one id-like (or unique / confirmed) field, never name-like.
    const idField = findSourceField(input.schema, obj.source, obj.identity.field);
    if (!idField) {
      err(
        'identity_missing',
        `${at}.identity.field`,
        `${obj.source}.${obj.identity.field} is not in the snapshot`,
      );
    } else if (NAME_LIKE.test(idField.name)) {
      err('identity_unsuitable', `${at}.identity.field`, 'a name-like field is not an identity');
    } else if (idField.type !== 'id' && !idField.unique && !obj.identity.confirmation) {
      err(
        'identity_unsuitable',
        `${at}.identity.field`,
        'the identity field is neither an id nor unique, and is not confirmed',
      );
    }
    // Only context statements: no core, extension or holding statements.
    obj.fields.forEach((entry, j) => {
      if (entry.kind !== 'ignored') {
        err(
          'invalid_target',
          `${at}.fields.${j}`,
          'account_context objects carry accountContext statements only',
        );
      }
    });
    obj.relationships.forEach((_rel, j) => {
      err(
        'invalid_target',
        `${at}.relationships.${j}.target`,
        'account_context objects have no relationships',
      );
    });
    if (obj.holdingFilter || obj.allRecordsAreHoldings || obj.customObject) {
      err(
        'invalid_target',
        at,
        'holding and custom-object statements do not apply to account contexts',
      );
    }
    const ac = obj.accountContext;
    if (!ac) {
      err(
        'invalid_target',
        `${at}.accountContext`,
        'an account_context object needs its accountContext statements',
      );
      return;
    }
    if (seenTypes.has(ac.type)) {
      err(
        'duplicate_entity',
        `${at}.accountContext.type`,
        `context type ${ac.type} is mapped by more than one object`,
      );
    }
    seenTypes.add(ac.type);
    const type = input.accountContext?.types.get(ac.type);
    if (!type || type.status !== 'active') {
      err(
        'context_type_unknown',
        `${at}.accountContext.type`,
        `${ac.type} is not an active published context type`,
      );
    }
    // account_context.account: a reference to an object mapped as account.
    if (field(ac.account.field, `${at}.accountContext.account.field`)) {
      const target = doc.objects.find((o) => o.source === ac.account.object);
      if (!target || target.entity !== 'account') {
        err(
          'missing_relationship_target',
          `${at}.accountContext.account.object`,
          `${ac.account.object} is not mapped as account`,
        );
      }
    }
    for (const key of ['name', 'status', 'ownerRef', 'renewalDate'] as const) {
      const stmt = ac[key];
      if (stmt) field(stmt.field, `${at}.accountContext.${key}.field`);
    }
    const dimKeys = new Set<string>();
    (ac.dimensions ?? []).forEach((d, j) => {
      const path = `${at}.accountContext.dimensions.${j}`;
      field(d.field, `${path}.field`);
      if (dimKeys.has(d.key))
        err('invalid_target', `${path}.key`, `dimension ${d.key} mapped twice`);
      dimKeys.add(d.key);
      if (type && !type.dimensions.some((td) => td.key === d.key)) {
        err(
          'context_dimension_unknown',
          `${path}.key`,
          `${d.key} is not a dimension of ${ac.type}`,
        );
      }
    });
    if (type) {
      for (const td of type.dimensions) {
        if (td.required && !dimKeys.has(td.key)) {
          err(
            'context_dimension_required',
            `${at}.accountContext.dimensions`,
            `required dimension ${td.key} is not mapped`,
          );
        }
      }
    }
    (ac.persons ?? []).forEach((p, j) => {
      const path = `${at}.accountContext.persons.${j}`;
      if (field(p.field, `${path}.field`)) {
        const target = doc.objects.find((o) => o.source === p.object);
        if (!target || target.entity !== 'person') {
          err(
            'missing_relationship_target',
            `${path}.object`,
            `${p.object} is not mapped as person`,
          );
        }
      }
      const roles = 'constant' in p.role ? [p.role.constant] : Object.values(p.role.valueMap);
      if (!('constant' in p.role)) field(p.role.field, `${path}.role.field`);
      for (const role of new Set(roles)) {
        if (type && !type.memberRoles.includes(role)) {
          err('context_role_unknown', `${path}.role`, `${role} is not a member role of ${ac.type}`);
        }
      }
    });
  });
  return issues;
}

/** The source fields an `accountContext` block reads (for `mappedFields`). */
export function accountContextFields(obj: Pick<ObjectMapping, 'accountContext'>): string[] {
  const ac = obj.accountContext;
  if (!ac) return [];
  const out = [ac.account.field];
  for (const stmt of [ac.name, ac.status, ac.ownerRef, ac.renewalDate])
    if (stmt) out.push(stmt.field);
  for (const d of ac.dimensions ?? []) out.push(d.field);
  for (const p of ac.persons ?? []) {
    out.push(p.field);
    if (!('constant' in p.role)) out.push(p.role.field);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Record mapping (sync)
// ---------------------------------------------------------------------------

export interface SourceTripleRef {
  readonly system: string;
  readonly objectType: string;
  readonly id: string;
}

export type MappedAccountContext =
  | { readonly outcome: 'skipped'; readonly code: string }
  | {
      readonly outcome: 'mapped';
      readonly typeKey: string;
      readonly ref: SourceTripleRef;
      readonly accountRef: SourceTripleRef;
      readonly presence: 'present' | 'absent';
      /** Stated dimension values only (an empty or unmapped value is omitted). */
      readonly dimensions: Readonly<Record<string, string | number | boolean>>;
      /** undefined = not mapped or empty (unchanged; absence never clears). */
      readonly name?: string;
      readonly status?: AccountContextStatus;
      /** null = mapped and explicitly empty. */
      readonly ownerRef?: string | null;
      /** `YYYY-MM-DD`; null = mapped and explicitly empty. */
      readonly renewalDate?: string | null;
      readonly persons: readonly { readonly ref: SourceTripleRef; readonly role: string }[];
      /** Value-free quality codes. */
      readonly quality: readonly string[];
      readonly sourceUpdatedAt?: Date;
    };

const REF_RE = /^[A-Za-z0-9_.:-]{1,255}$/;
type Raw = string | number | boolean | null | undefined;

function text(value: Raw): string | undefined {
  if (value === null || value === undefined) return undefined;
  const s = String(value).trim();
  return s === '' ? undefined : s;
}

/** A source date as `YYYY-MM-DD` (date-only, or the date part of an ISO instant); else undefined. */
export function contextRenewalDate(value: Raw): string | undefined {
  const s = text(value);
  if (!s) return undefined;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:$|[T ])/.exec(s);
  if (!m) return undefined;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) &&
    d.getUTCMonth() === Number(m[2]) - 1 &&
    d.getUTCDate() === Number(m[3])
    ? `${m[1]}-${m[2]}-${m[3]}`
    : undefined;
}

/**
 * One record of an `account_context` object → the writer's observation
 * inputs (references unresolved; the sync resolves them). A record without
 * identity or account reference is skipped (code only); a deleted record is
 * `absent` (recorded on the reference only, never clears the context).
 * Unmapped status / dimension / role values are dropped and counted.
 */
export function mapAccountContextRecord(
  obj: ObjectMapping,
  record: SourceRecord,
  system: string,
): MappedAccountContext {
  const ac = obj.accountContext;
  if (!ac) return { outcome: 'skipped', code: 'account_context_mapping_invalid' };
  const id = text(record.values[obj.identity.field]) ?? text(record.id);
  if (!id || !REF_RE.test(id))
    return { outcome: 'skipped', code: 'account_context_identity_invalid' };
  const accountId = text(record.values[ac.account.field]);
  if (!accountId) return { outcome: 'skipped', code: 'account_context_account_missing' };
  if (!REF_RE.test(accountId))
    return { outcome: 'skipped', code: 'account_context_account_invalid' };
  const quality: string[] = [];
  const base = {
    outcome: 'mapped' as const,
    typeKey: ac.type,
    ref: { system, objectType: obj.source, id },
    accountRef: { system, objectType: ac.account.object, id: accountId },
    ...(record.modifiedAt ? { sourceUpdatedAt: record.modifiedAt } : {}),
  };
  if (record.deleted) {
    return { ...base, presence: 'absent', dimensions: {}, persons: [], quality };
  }
  const dimensions: Record<string, string | number | boolean> = {};
  for (const d of ac.dimensions ?? []) {
    const raw = record.values[d.field];
    if (raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === ''))
      continue;
    if (d.valueMap) {
      const mapped = Object.hasOwn(d.valueMap, String(raw).trim())
        ? d.valueMap[String(raw).trim()]
        : undefined;
      if (mapped === undefined) {
        quality.push('account_context_dimension_unmapped');
        continue;
      }
      dimensions[d.key] = mapped;
    } else {
      dimensions[d.key] = typeof raw === 'string' ? raw.trim() : raw;
    }
  }
  let status: AccountContextStatus | undefined;
  if (ac.status) {
    const raw = text(record.values[ac.status.field]);
    if (raw !== undefined) {
      status = Object.hasOwn(ac.status.valueMap, raw) ? ac.status.valueMap[raw] : undefined;
      if (!status) quality.push('account_context_status_unmapped');
    }
  }
  let renewalDate: string | null | undefined;
  if (ac.renewalDate) {
    const raw = record.values[ac.renewalDate.field];
    if (text(raw) === undefined) renewalDate = null;
    else {
      renewalDate = contextRenewalDate(raw);
      if (renewalDate === undefined) quality.push('account_context_renewal_date_invalid');
    }
  }
  const persons: { ref: SourceTripleRef; role: string }[] = [];
  for (const p of ac.persons ?? []) {
    const pid = text(record.values[p.field]);
    if (!pid) continue;
    if (!REF_RE.test(pid)) {
      quality.push('account_context_person_ref_invalid');
      continue;
    }
    let role: string | undefined;
    if ('constant' in p.role) role = p.role.constant;
    else {
      const raw = text(record.values[p.role.field]);
      role =
        raw !== undefined && Object.hasOwn(p.role.valueMap, raw) ? p.role.valueMap[raw] : undefined;
    }
    if (!role) {
      quality.push('account_context_role_unmapped');
      continue;
    }
    persons.push({ ref: { system, objectType: p.object, id: pid }, role });
  }
  const name = ac.name ? text(record.values[ac.name.field]) : undefined;
  return {
    ...base,
    presence: 'present',
    dimensions,
    ...(name !== undefined ? { name } : {}),
    ...(status ? { status } : {}),
    ...(ac.ownerRef ? { ownerRef: text(record.values[ac.ownerRef.field]) ?? null } : {}),
    ...(renewalDate !== undefined ? { renewalDate } : {}),
    persons,
    quality,
  };
}

/**
 * The context a line record names through `subscription.contextRef`
 * (undefined = not mapped, empty or malformed: the line's context is left as
 * it is — absence never clears, plan §5.2).
 */
export function mapLineContextRef(
  obj: ObjectMapping,
  record: SourceRecord,
  system: string,
): SourceTripleRef | undefined {
  const rel = obj.relationships.find((r) => r.target === CONTEXT_REF_TARGET);
  if (!rel?.object) return undefined;
  const id = text(record.values[rel.field]);
  if (!id || !REF_RE.test(id)) return undefined;
  return { system, objectType: rel.object, id };
}
