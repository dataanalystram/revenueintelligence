import { Inject, Injectable, Optional } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../../platform/config';
import {
  DEFAULT_EXTENSION_GUARDRAILS,
  displayExtensionValue,
  extensionFieldToken,
  extensionValueHash,
  fieldSpecFromDefinition,
  parsedFromStored,
  parseExtensionValue,
  type ExtensionGuardrails,
  type ExtensionTargetKind,
  type ParsedExtensionValue,
} from '../../domain';
import { GovernanceError, ModuleGate } from '../../governance';
import {
  assertAuthorized,
  AuditFailures,
  AuditTrail,
  recordExtensionValueHistory,
  SecurityEventsService,
  TenantDatabase,
  WriteAuthorizer,
  type AuthorizedContext,
  type TenantTransaction,
} from '../../tenancy';
import {
  definitionTarget,
  ExtensionStore,
  fieldRef,
  type ExtensionEntry,
  type ExtensionTarget,
  type StoredValueRow,
} from '../infrastructure/extension.store';
import {
  operatorProvenance,
  parseTarget,
  requireExtension,
  requireReason,
  targetRef,
  type ExtensionProvenance,
} from './extension-shared';

/** One stated value: the field key and the raw value (after the closed transforms). */
export interface ObservedExtensionValue {
  readonly field: string;
  /** `null` / empty string = explicit empty; `undefined` never reaches the writer (no statement). */
  readonly raw: unknown;
}

export interface ExtensionObservation {
  readonly target: ExtensionTarget;
  readonly values: readonly ObservedExtensionValue[];
  readonly observedAt: Date;
  readonly provenance: ExtensionProvenance;
}

/** Per-call counters (identifiers and codes only; the run report adds them up). */
export interface ExtensionObserveOutcome {
  /** `ok`, or why nothing was written (gate, unknown / merged target). */
  readonly status:
    | 'ok'
    | 'canonical_version_too_low'
    | 'module_disabled'
    | 'registry_not_published'
    | 'target_unknown'
    | 'target_merged';
  readonly written: number;
  readonly unchanged: number;
  /** Restricted fields: never stored (Q10). */
  readonly withheld: number;
  /** Sticky human values a differing source value did not override (Q16). */
  readonly humanOverride: number;
  /** Rejections by reason code (`field_unknown`, `field_retired`, `target_mismatch`, parse reasons…). */
  readonly rejected: Readonly<Record<string, number>>;
  readonly changeId?: string;
}

export interface OperatorValueInput {
  /** `<kind>:<id>` (products `product:<key>`). */
  readonly target: string;
  readonly field: string;
  readonly value?: string;
  readonly reason: string;
}

export interface OperatorValueResult {
  readonly target: string;
  readonly field: string;
  readonly valueId: string;
  readonly state: 'present' | 'empty' | 'released';
  readonly changed: boolean;
}

type FieldCheck =
  | { readonly ok: true; readonly entry: ExtensionEntry }
  | { readonly ok: false; readonly reason: 'field_unknown' | 'field_retired' | 'target_mismatch' };

interface PlannedWrite {
  readonly entry: ExtensionEntry;
  readonly stored?: StoredValueRow;
  readonly value: ParsedExtensionValue;
  readonly hash: string;
  readonly origin: 'source_provided' | 'human' | 'migration';
  readonly releasedAt: Date | null;
}

const issueIdentity = (tenantId: string, target: ExtensionTarget, fieldId: string) =>
  `${tenantId}|extension-value|${target.kind}:${target.id}|${fieldId}`;

/**
 * The single writer of `tenant_extension_values` and their items (M10D plan
 * §4.1, ADR 0030). Layer-1 checks in order: adopted ≥ 0.4 → module enabled →
 * field exists, active, target matches → target exists and is not merged
 * (Q32) → effective sensitivity `restricted` → not stored (Q10) → type parse,
 * constraints and guardrails (refusal, never truncation) → secret-like
 * refusal → reference target checks → field hash → write. Idempotent: an
 * unchanged hash writes nothing. Absence never clears a value; only an
 * explicit empty statement sets `value_state = 'empty'`. Human values are
 * sticky until `release` (Q16). One change record per call per target with
 * `ext:<key>` tokens (Q24); value history only for `history: value_history`
 * fields (Q23).
 */
@Injectable()
export class ExtensionValueWriter {
  constructor(
    private readonly db: TenantDatabase,
    private readonly store: ExtensionStore,
    readonly audit: AuditTrail,
    private readonly authorizer: WriteAuthorizer,
    private readonly moduleGate: ModuleGate,
    private readonly events: SecurityEventsService,
    @Optional() @Inject(APP_CONFIG) private readonly config?: AppConfig,
  ) {}

  get guardrails(): ExtensionGuardrails {
    return (
      (this.config as Partial<AppConfig> | undefined)?.canonical?.extension ??
      DEFAULT_EXTENSION_GUARDRAILS
    );
  }

  /** Source values of one target in their own transaction (sync orchestration). */
  observeSource(
    actx: AuthorizedContext<'canonical.source_sync'>,
    input: ExtensionObservation,
  ): Promise<ExtensionObserveOutcome> {
    assertAuthorized(actx, 'canonical.source_sync');
    return this.db.transaction(actx.tenant, (tx) => this.observe(actx, tx, input));
  }

  /**
   * Source values of one target inside the caller's transaction (after the
   * caller's own authority decision, Q13 / Q14). A refused gate or target
   * writes nothing and reports why; rejections are counted per reason.
   */
  async observe(
    actx: AuthorizedContext<'canonical.source_sync'>,
    tx: TenantTransaction,
    input: ExtensionObservation,
  ): Promise<ExtensionObserveOutcome> {
    assertAuthorized(actx, 'canonical.source_sync');
    if (actx.tenant.tenantId !== tx.tenantId) {
      throw new Error('extension value tenant does not match the transaction tenant');
    }
    const empty = (status: ExtensionObserveOutcome['status']): ExtensionObserveOutcome => ({
      status,
      written: 0,
      unchanged: 0,
      withheld: 0,
      humanOverride: 0,
      rejected: {},
    });
    if (input.values.length === 0) return empty('ok');
    const gate = await this.store.gate(tx);
    if (gate !== 'ok') return empty(gate);
    const registry = await this.store.registry(tx);
    if (registry.version === undefined) return empty('registry_not_published');
    const entity = await this.store.entity(tx, input.target);
    if (!entity.exists) return empty('target_unknown');
    if (entity.state === 'merged') return empty('target_merged');
    await this.store.lockTarget(tx, input.target);

    const rejected: Record<string, number> = {};
    const reject = (reason: string) => (rejected[reason] = (rejected[reason] ?? 0) + 1);
    let withheld = 0;
    let humanOverride = 0;
    let unchanged = 0;
    const planned: PlannedWrite[] = [];

    // Last statement per field wins (one value per field and target).
    const byField = new Map<string, unknown>();
    for (const v of input.values) byField.set(v.field, v.raw);
    const objectKey = entity.objectId ? registry.byId.get(entity.objectId)?.key : undefined;
    const entries: ExtensionEntry[] = [];
    for (const field of byField.keys()) {
      const check = this.checkField(registry.byKey.get(field), input.target, objectKey);
      if (!check.ok) reject(check.reason);
      else entries.push(check.entry);
    }
    const stored = new Map(
      (
        await this.store.values(
          tx,
          input.target,
          entries.map((e) => e.id),
        )
      ).map((r) => [r.fieldId, r]),
    );
    for (const entry of entries) {
      if (entry.sensitivity === 'restricted') {
        withheld += 1; // Q10: restricted values are never stored, not even rejected-with-value.
        continue;
      }
      const parsed = parseExtensionValue(
        fieldSpecFromDefinition(entry.key, entry.definition),
        byField.get(entry.key),
        this.guardrails,
      );
      if (!parsed.ok) {
        reject(parsed.reason);
        if (parsed.reason === 'secret_like') {
          // Coordinates and codes only: the value is never part of the event.
          this.events.emit({
            event: 'secret_like_refused',
            outcome: 'refused',
            tenant: actx.tenant.tenantSlug,
            actorKind: actx.actor.kind,
            reasonCode: 'secret_like_value',
            correlationId: input.provenance.correlationId,
            coordinates: {
              system: input.provenance.source.system,
              objectType: input.provenance.source.objectType,
              recordId: input.provenance.source.id,
              field: fieldRef(entry.key),
              pattern: parsed.pattern ?? 'unknown',
            },
          });
        }
        continue;
      }
      if (!(await this.referenceOk(tx, input.target, entry, parsed.value))) {
        reject('reference_unresolved');
        continue;
      }
      const hash = extensionValueHash(parsed.value);
      const row = stored.get(entry.id);
      const identity = issueIdentity(tx.tenantId, input.target, entry.id);
      if (row && row.origin === 'human' && row.releasedAt === null) {
        // Q16: the operator's value is sticky; a differing source value is an open issue.
        if (row.fieldHash !== hash) {
          humanOverride += 1;
          await this.store.recordIssue(tx, {
            kind: 'extension_human_override_disagrees',
            entityKind: input.target.kind,
            identity,
            canonicalIds: canonicalIds(input.target, entry.id),
            externalRefs: [fieldRef(entry.key)],
          });
        } else {
          unchanged += 1;
          await this.store.resolveIssue(tx, 'extension_human_override_disagrees', identity);
        }
        continue;
      }
      const released = row?.origin === 'human' && row.releasedAt !== null;
      if (row && row.fieldHash === hash && !released) {
        unchanged += 1;
        continue;
      }
      planned.push({
        entry,
        ...(row ? { stored: row } : {}),
        value: parsed.value,
        hash,
        origin: input.provenance.origin === 'migration' ? 'migration' : 'source_provided',
        releasedAt: null,
      });
      if (released)
        await this.store.resolveIssue(tx, 'extension_human_override_disagrees', identity);
    }
    const changeId = await this.apply(tx, input.target, planned, input, registry.version);
    return {
      status: 'ok',
      written: planned.length,
      unchanged,
      withheld,
      humanOverride,
      rejected,
      ...(changeId ? { changeId } : {}),
    };
  }

  /**
   * The field exists as a field definition, is active and applies to the
   * target (a custom-object field only to records of exactly that object).
   */
  private checkField(
    entry: ExtensionEntry | undefined,
    target: ExtensionTarget,
    recordObjectKey: string | undefined,
  ): FieldCheck {
    if (!entry || entry.definition.kind !== 'field') return { ok: false, reason: 'field_unknown' };
    if (entry.status !== 'active') return { ok: false, reason: 'field_retired' };
    const t = definitionTarget(entry.definition);
    if (t.kind !== target.kind) return { ok: false, reason: 'target_mismatch' };
    if (t.objectKey !== undefined && t.objectKey !== recordObjectKey) {
      return { ok: false, reason: 'target_mismatch' };
    }
    return { ok: true, entry };
  }

  /** Reference values: the target exists in the tenant, is of an allowed kind (and object) and is not merged. */
  private async referenceOk(
    tx: TenantTransaction,
    target: ExtensionTarget,
    entry: ExtensionEntry,
    value: ParsedExtensionValue,
  ): Promise<boolean> {
    if (value.state !== 'present' || !value.ref) return true;
    const ref = { kind: value.ref.kind, id: value.ref.id ?? value.ref.key! };
    const e = await this.store.entity(tx, ref);
    const identity = `${issueIdentity(tx.tenantId, target, entry.id)}|ref`;
    let ok = e.exists && e.state !== 'merged';
    if (ok && ref.kind === 'custom_record' && e.exists) {
      const registry = await this.store.registry(tx);
      const objectKey = registry.byId.get(e.objectId ?? '')?.key;
      const allowed =
        (entry.definition.constraints as { reference_to?: string[] } | undefined)?.reference_to ??
        [];
      ok = objectKey !== undefined && allowed.includes(`custom_object:${objectKey}`);
    }
    if (!ok) {
      await this.store.recordIssue(tx, {
        kind: 'extension_reference_unresolved',
        entityKind: target.kind,
        identity,
        canonicalIds: canonicalIds(target, entry.id),
        externalRefs: [fieldRef(entry.key)],
      });
      return false;
    }
    await this.store.resolveIssue(tx, 'extension_reference_unresolved', identity);
    return true;
  }

  /** One change record for the call, the rows, items and value history. */
  private async apply(
    tx: TenantTransaction,
    target: ExtensionTarget,
    planned: readonly PlannedWrite[],
    input: { readonly observedAt: Date; readonly provenance: ExtensionProvenance },
    registryVersion: number,
  ): Promise<string | undefined> {
    if (planned.length === 0) return undefined;
    const { connectionId, ...change } = input.provenance;
    const changeId = await this.store.insertChange(tx, {
      ...change,
      entityKind: target.kind,
      entityId: target.id,
      changeType: 'updated',
      changedFields: [...new Set(planned.map((p) => extensionFieldToken(p.entry.key)))].sort(),
    });
    const sourceTriple =
      connectionId && input.provenance.origin !== 'human'
        ? {
            connectionId,
            objectType: input.provenance.source.objectType,
            recordId: input.provenance.source.id,
          }
        : undefined;
    for (const p of planned) {
      await this.store.writeValue(tx, {
        ...(p.stored ? { existingId: p.stored.id } : {}),
        target,
        fieldId: p.entry.id,
        value: p.value,
        origin: p.origin,
        releasedAt: p.releasedAt,
        ...(sourceTriple ? { source: sourceTriple } : {}),
        observedAt: input.observedAt,
        sourceUpdatedAt: input.provenance.sourceUpdatedAt ?? null,
        fieldHash: p.hash,
        registryVersion,
        lastChangeId: changeId,
      });
      if (p.entry.definition.history === 'value_history') {
        const before = p.stored
          ? displayExtensionValue(
              parsedFromStored(
                p.stored,
                (await this.store.items(tx, [p.stored.id])).get(p.stored.id),
              ),
            )
          : null;
        await recordExtensionValueHistory(tx, {
          entityKind: target.kind,
          entity: target.id,
          fieldKey: p.entry.key,
          classification: classificationOf(p.entry),
          changeId,
          effectiveAt: input.provenance.sourceUpdatedAt ?? input.observedAt,
          ...(input.provenance.actor ? { actor: input.provenance.actor } : {}),
          oldValue: before,
          newValue: displayExtensionValue(p.value),
        });
      }
    }
    return changeId;
  }

  // --- Operator entry (plan §4.1, §4.3; canonical.human_entry) ---------------------

  @AuditFailures('extension.value.set', 'extension_value')
  async set(
    actx: AuthorizedContext<'canonical.human_entry'>,
    input: OperatorValueInput,
  ): Promise<OperatorValueResult> {
    assertAuthorized(actx, 'canonical.human_entry');
    if (input.value === undefined) {
      throw new GovernanceError('validation_failed', '--value is required (use clear for empty)');
    }
    // Secret-like values are refused before anything else (audited denial, M10A1).
    await this.authorizer.refuseSecretLike(
      actx,
      { action: 'extension.value.set', targetKind: 'extension_value' },
      { value: input.value },
    );
    return this.operatorWrite(actx, input, 'extension.value.set', input.value);
  }

  @AuditFailures('extension.value.clear', 'extension_value')
  async clear(
    actx: AuthorizedContext<'canonical.human_entry'>,
    input: OperatorValueInput,
  ): Promise<OperatorValueResult> {
    assertAuthorized(actx, 'canonical.human_entry');
    return this.operatorWrite(actx, input, 'extension.value.clear', null);
  }

  /** Hands a human value back to the source (Q16): the next authoritative source value applies. */
  @AuditFailures('extension.value.release', 'extension_value')
  async release(
    actx: AuthorizedContext<'canonical.human_entry'>,
    input: OperatorValueInput,
  ): Promise<OperatorValueResult> {
    assertAuthorized(actx, 'canonical.human_entry');
    const target = parseTarget(input.target);
    const reason = requireReason(input.reason);
    return this.db.transaction(actx.tenant, async (tx) => {
      await requireExtension(tx, actx, this.store, this.moduleGate);
      const entity = await this.store.entity(tx, target);
      const registry = await this.store.registry(tx);
      const check = this.checkField(
        registry.byKey.get(input.field),
        target,
        entity.exists && entity.objectId ? registry.byId.get(entity.objectId)?.key : undefined,
      );
      if (!check.ok) throw fieldError(check.reason);
      await this.store.lockTarget(tx, target);
      const row = (await this.store.values(tx, target, [check.entry.id]))[0];
      if (!row || row.origin !== 'human' || row.releasedAt !== null) {
        throw new GovernanceError(
          'validation_failed',
          'No unreleased operator value for this field',
        );
      }
      await this.store.releaseValue(tx, row.id, new Date());
      await this.audit.record(tx, actx, {
        action: 'extension.value.release',
        targetKind: 'extension_value',
        targetRef: row.id,
        details: { reason, field: check.entry.key, targetKind: target.kind },
      });
      return {
        target: targetRef(target),
        field: check.entry.key,
        valueId: row.id,
        state: 'released',
        changed: true,
      };
    });
  }

  private async operatorWrite(
    actx: AuthorizedContext<'canonical.human_entry'>,
    input: OperatorValueInput,
    action: 'extension.value.set' | 'extension.value.clear',
    raw: string | null,
  ): Promise<OperatorValueResult> {
    const target = parseTarget(input.target);
    const reason = requireReason(input.reason);
    return this.db.transaction(actx.tenant, async (tx) => {
      await requireExtension(tx, actx, this.store, this.moduleGate);
      const out = await this.writeHumanWithin(actx, tx, target, input.field, raw);
      await this.audit.record(tx, actx, {
        action,
        targetKind: 'extension_value',
        targetRef: out.valueId,
        details: { reason, field: out.field, targetKind: target.kind, changed: out.changed },
      });
      return out;
    });
  }

  /**
   * One human value inside the caller's transaction (operator `value set` /
   * `clear`, and the fields of an operator record command). The caller holds
   * the gate and writes the one audit event of its call. Secret-like values
   * are refused (audited denial) before anything is stored.
   */
  async writeHumanWithin(
    actx: AuthorizedContext<'canonical.human_entry'>,
    tx: TenantTransaction,
    target: ExtensionTarget,
    field: string,
    raw: string | null,
  ): Promise<OperatorValueResult> {
    assertAuthorized(actx, 'canonical.human_entry');
    if (raw !== null) {
      await this.authorizer.refuseSecretLike(
        actx,
        { action: 'extension.value.set', targetKind: 'extension_value' },
        { value: raw },
      );
    }
    const registry = await this.store.registry(tx);
    const entity = await this.store.entity(tx, target);
    if (!entity.exists || entity.state === 'merged') {
      throw new GovernanceError('validation_failed', 'The target must exist and not be merged');
    }
    const check = this.checkField(
      registry.byKey.get(field),
      target,
      entity.objectId ? registry.byId.get(entity.objectId)?.key : undefined,
    );
    if (!check.ok) throw fieldError(check.reason);
    const entry = check.entry;
    if (entry.sensitivity === 'restricted') {
      throw new GovernanceError(
        'restricted_value_withheld',
        'Values of restricted extension fields are not stored',
      );
    }
    const parsed = parseExtensionValue(
      fieldSpecFromDefinition(entry.key, entry.definition),
      raw,
      this.guardrails,
    );
    if (!parsed.ok) {
      throw new GovernanceError(
        parsed.reason === 'too_many_items' ||
          parsed.reason === 'json_too_large' ||
          parsed.reason === 'json_too_deep'
          ? 'extension_guardrail_exceeded'
          : 'extension_value_invalid',
        `extension_value_invalid:${parsed.reason}`,
      );
    }
    if (!(await this.referenceOk(tx, target, entry, parsed.value))) {
      throw new GovernanceError(
        'extension_value_invalid',
        'extension_value_invalid:reference_unresolved',
      );
    }
    await this.store.lockTarget(tx, target);
    const row = (await this.store.values(tx, target, [entry.id]))[0];
    const hash = extensionValueHash(parsed.value);
    const changed =
      !row || row.fieldHash !== hash || row.origin !== 'human' || row.releasedAt !== null;
    if (changed) {
      await this.apply(
        tx,
        target,
        [
          {
            entry,
            ...(row ? { stored: row } : {}),
            value: parsed.value,
            hash,
            origin: 'human',
            releasedAt: null,
          },
        ],
        {
          observedAt: new Date(),
          provenance: operatorProvenance(actx.actor, actx.correlationId, target.id),
        },
        registry.version!,
      );
    }
    const valueId = row?.id ?? (await this.store.values(tx, target, [entry.id]))[0]!.id;
    await this.store.resolveIssue(
      tx,
      'extension_human_override_disagrees',
      issueIdentity(tx.tenantId, target, entry.id),
    );
    return {
      target: targetRef(target),
      field: entry.key,
      valueId,
      state: parsed.value.state,
      changed,
    };
  }

  // --- Merge (plan §7, Q22) -------------------------------------------------------

  /**
   * For each loser value: survivor has none → copy (origin kept, change record
   * with the merge's provenance, value history when enabled); same hash →
   * nothing; differs → the survivor keeps its value and an open
   * `extension_value_conflict` names both ids and the field key. Loser rows
   * stay (lineage).
   */
  async onEntityMerged(
    tx: TenantTransaction,
    kind: 'company' | 'person',
    loserId: string,
    survivorId: string,
    provenance: ExtensionProvenance,
  ): Promise<void> {
    const loser: ExtensionTarget = { kind, id: loserId };
    const survivor: ExtensionTarget = { kind, id: survivorId };
    const loserRows = await this.store.values(tx, loser);
    if (loserRows.length === 0) return;
    const registry = await this.store.registry(tx);
    const survivorRows = new Map(
      (await this.store.values(tx, survivor)).map((r) => [r.fieldId, r]),
    );
    const items = await this.store.items(
      tx,
      loserRows.map((r) => r.id),
    );
    const planned: PlannedWrite[] = [];
    for (const row of loserRows) {
      const entry = registry.byId.get(row.fieldId);
      if (!entry) continue;
      const other = survivorRows.get(row.fieldId);
      if (!other || other.fieldHash !== row.fieldHash) {
        planned.push({
          entry,
          value: parsedFromStored(row, items.get(row.id) ?? []),
          hash: row.fieldHash ?? extensionValueHash(parsedFromStored(row, items.get(row.id) ?? [])),
          origin: row.origin as PlannedWrite['origin'],
          releasedAt: row.releasedAt,
        });
      } else if (other.fieldHash !== row.fieldHash) {
        await this.store.recordIssue(tx, {
          kind: 'extension_value_conflict',
          entityKind: kind,
          identity: `${tx.tenantId}|extension-merge|${kind}:${survivorId}|${loserId}|${row.fieldId}`,
          canonicalIds: [loserId, survivorId, row.fieldId],
          externalRefs: [fieldRef(entry.key)],
        });
      }
    }
    if (planned.length === 0 || registry.version === undefined) return;
    await this.store.lockTarget(tx, survivor);
    const changeId = await this.store.insertChange(tx, {
      ...stripConnection(provenance),
      entityKind: kind,
      entityId: survivorId,
      changeType: 'merged',
      changedFields: [...new Set(planned.map((p) => extensionFieldToken(p.entry.key)))].sort(),
    });
    for (const p of planned) {
      const source = loserRows.find((r) => r.fieldId === p.entry.id)!;
      await this.store.writeValue(tx, {
        existingId: survivorRows.get(p.entry.id)?.id,
        target: survivor,
        fieldId: p.entry.id,
        value: p.value,
        origin: p.origin,
        releasedAt: p.releasedAt,
        observedAt: provenance.sourceUpdatedAt ?? new Date(),
        sourceUpdatedAt: provenance.sourceUpdatedAt ?? null,
        fieldHash: p.hash,
        registryVersion: registry.version,
        lastChangeId: changeId,
        ...(await this.sourceOf(tx, source)),
      });
      if (p.entry.definition.history === 'value_history') {
        await recordExtensionValueHistory(tx, {
          entityKind: kind,
          entity: survivorId,
          fieldKey: p.entry.key,
          classification: classificationOf(p.entry),
          changeId,
          effectiveAt: provenance.sourceUpdatedAt ?? new Date(),
          ...(provenance.actor ? { actor: provenance.actor } : {}),
          oldValue: null,
          newValue: displayExtensionValue(p.value),
        });
      }
    }
  }

  /** The loser row's source triple, carried to the survivor copy. */
  private async sourceOf(
    tx: TenantTransaction,
    row: StoredValueRow,
  ): Promise<{ source?: { connectionId: string; objectType: string; recordId: string } }> {
    const full = await this.store.valueSource(tx, row.id);
    return full ? { source: full } : {};
  }
}

function stripConnection(p: ExtensionProvenance) {
  const { connectionId: _ignored, ...rest } = p;
  return rest;
}

export function classificationOf(entry: ExtensionEntry): {
  readonly sensitivity: ExtensionEntry['sensitivity'];
  readonly categories: ExtensionEntry['categories'];
} {
  return { sensitivity: entry.sensitivity, categories: entry.categories };
}

function canonicalIds(target: ExtensionTarget, fieldId: string): string[] {
  return target.kind === 'product' ? [fieldId] : [target.id, fieldId];
}

function fieldError(
  reason: 'field_unknown' | 'field_retired' | 'target_mismatch',
): GovernanceError {
  return reason === 'field_retired'
    ? new GovernanceError('extension_field_retired', 'The extension field is retired')
    : reason === 'field_unknown'
      ? new GovernanceError('extension_field_unknown', 'No such extension field')
      : new GovernanceError(
          'extension_field_unknown',
          'The extension field does not apply to this target',
        );
}

export type { ExtensionTargetKind };
