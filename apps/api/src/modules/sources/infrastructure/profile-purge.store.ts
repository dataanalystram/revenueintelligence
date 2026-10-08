import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Client } from 'pg';

/**
 * The privileged profile retention purge (M9A plan §2.4, approved D3). The
 * only deletion path for profiles and findings: it runs with the schema
 * owner's credentials (never the app role), sets the transaction-local
 * `lip.profile_purge = 'on'` that the refuse-change triggers require, keeps
 * the N newest profiles per sampling family, never deletes a profile that a
 * kept profile or a published mapping version references, and writes one
 * audit row in the same transaction. Forced RLS still applies: the tenant is
 * bound for the transaction.
 */

export interface PurgeRequest {
  readonly ownerDatabaseUrl: string;
  readonly tenantId: string;
  readonly connectionId: string;
  readonly object: string;
  readonly keep: number;
  readonly actor: string;
  readonly correlationId?: string;
  readonly execute: boolean;
}

export interface PurgeResult {
  readonly dryRun: boolean;
  readonly kept: number;
  readonly deletedProfiles: number;
  readonly deletedFindings: number;
  /** Candidates skipped because something still references them (`profile_referenced`). */
  readonly referenced: number;
  /** Kept profiles whose baseline link to a purged profile was cleared. */
  readonly unlinked: number;
  readonly auditId?: string;
}

export class PurgeRefusedError extends Error {
  constructor(
    readonly code: 'purge_requires_owner_credentials' | 'purge_invalid_request',
    message: string,
  ) {
    super(message);
    this.name = 'PurgeRefusedError';
  }
}

const ACTOR = /^[A-Za-z0-9_.:@-]{1,128}$/;
const OBJECT = /^[A-Za-z][A-Za-z0-9_]{0,99}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class ProfilePurgeStore {
  async purge(req: PurgeRequest): Promise<PurgeResult> {
    if (
      !UUID.test(req.tenantId) ||
      !UUID.test(req.connectionId) ||
      !OBJECT.test(req.object) ||
      !ACTOR.test(req.actor) ||
      !Number.isInteger(req.keep) ||
      req.keep < 1 ||
      req.keep > 1000
    ) {
      throw new PurgeRefusedError('purge_invalid_request', 'Invalid purge request');
    }
    const client = new Client({ connectionString: req.ownerDatabaseUrl });
    await client.connect();
    try {
      // Refused before anything else: the app role (or any member of it) never purges.
      // Real membership (the same function the refuse-change trigger uses).
      const role = await client.query<{ member: boolean }>(
        `SELECT app_session_in_app_role() AS member`,
      );
      if (role.rows[0]?.member) {
        throw new PurgeRefusedError(
          'purge_requires_owner_credentials',
          'The purge runs only with the schema owner credentials (MIGRATION_DATABASE_URL)',
        );
      }
      await client.query('BEGIN');
      try {
        await client.query(`SELECT set_config('app.current_tenant', $1, true)`, [req.tenantId]);
        await client.query(`SELECT set_config('lip.profile_purge', 'on', true)`);
        // Kept: the N newest per family, their direct baselines (drift of kept profiles
        // stays intact) and every profile a published mapping version cites as covering.
        const { rows: candidates } = await client.query<{ id: string; referenced: boolean }>(
          `WITH ranked AS (
             SELECT id, created_at, previous_profile_id,
                    row_number() OVER (PARTITION BY sampling_family ORDER BY created_at DESC, id) AS rn
               FROM tenant_source_profiles
              WHERE tenant_id = $1 AND connection_id = $2 AND object = $3
           )
           SELECT d.id,
                  (EXISTS (SELECT 1 FROM ranked k WHERE k.rn <= $4 AND k.previous_profile_id = d.id)
                   OR EXISTS (SELECT 1 FROM tenant_source_mapping_versions m
                               WHERE m.tenant_id = $1
                                 AND (m.validation -> 'coveringProfileIds') ? d.id::text)) AS referenced
             FROM ranked d
            WHERE d.rn > $4
            ORDER BY d.created_at DESC, d.id`,
          [req.tenantId, req.connectionId, req.object, req.keep],
        );
        const deletable = candidates.filter((c) => !c.referenced).map((c) => c.id);
        const total = await client.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM tenant_source_profiles
            WHERE tenant_id = $1 AND connection_id = $2 AND object = $3`,
          [req.tenantId, req.connectionId, req.object],
        );
        let deletedFindings = 0;
        let deletedProfiles = 0;
        let unlinked = 0;
        if (req.execute && deletable.length > 0) {
          // A kept profile whose baseline is purged loses that link (the only update
          // the refuse-change trigger allows, and only in purge mode).
          const u = await client.query(
            `UPDATE tenant_source_profiles SET previous_profile_id = NULL
              WHERE tenant_id = $1 AND previous_profile_id = ANY($2::uuid[]) AND NOT (id = ANY($2::uuid[]))`,
            [req.tenantId, deletable],
          );
          unlinked = u.rowCount ?? 0;
          // Newest first: a purged profile goes before the older purged baseline it references.
          for (const id of deletable) {
            const f = await client.query(
              `DELETE FROM tenant_source_profile_findings WHERE tenant_id = $1 AND profile_id = $2`,
              [req.tenantId, id],
            );
            deletedFindings += f.rowCount ?? 0;
            const p = await client.query(
              `DELETE FROM tenant_source_profiles WHERE tenant_id = $1 AND id = $2`,
              [req.tenantId, id],
            );
            deletedProfiles += p.rowCount ?? 0;
          }
        } else if (!req.execute) {
          const f = await client.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM tenant_source_profile_findings
              WHERE tenant_id = $1 AND profile_id = ANY($2::uuid[])`,
            [req.tenantId, deletable],
          );
          deletedFindings = f.rows[0]?.n ?? 0;
          deletedProfiles = deletable.length;
        }
        const kept = (total.rows[0]?.n ?? 0) - deletedProfiles;
        let auditId: string | undefined;
        if (req.execute) {
          auditId = randomUUID();
          await client.query(
            `INSERT INTO tenant_source_profile_purges
               (tenant_id, id, connection_id, object, kept, deleted_profiles, deleted_findings, actor, correlation_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [
              req.tenantId,
              auditId,
              req.connectionId,
              req.object,
              kept,
              deletedProfiles,
              deletedFindings,
              req.actor,
              req.correlationId ?? randomUUID(),
            ],
          );
          await client.query('COMMIT');
        } else {
          await client.query('ROLLBACK');
        }
        return {
          dryRun: !req.execute,
          kept,
          deletedProfiles,
          deletedFindings,
          referenced: candidates.length - deletable.length,
          unlinked,
          ...(auditId ? { auditId } : {}),
        };
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      }
    } finally {
      await client.end();
    }
  }
}
