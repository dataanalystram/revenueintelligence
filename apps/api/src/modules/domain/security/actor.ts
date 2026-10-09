import { z } from 'zod';

/**
 * Who performed a write (M10A1, plan §2). Every audit event and change record
 * carries one. The id pattern equals the existing `published_by` /
 * `captured_by` / `requested_by` CHECKs.
 */
export const ACTOR_KINDS = ['source_sync', 'system', 'operator', 'human_user', 'ai'] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

/**
 * How far the platform can vouch for the actor's identity. A CLI operator id is
 * `asserted` (typed by a person, not verified) until authenticated operator
 * identity exists (M15); it is never presented as `authenticated`.
 */
export const ASSURANCES = ['system', 'asserted', 'authenticated'] as const;
export type Assurance = (typeof ASSURANCES)[number];

export const ACTOR_ID_PATTERN = /^[A-Za-z0-9_.:@-]{1,128}$/;

export const SecurityActorSchema = z
  .object({
    kind: z.enum(ACTOR_KINDS),
    id: z.string().regex(ACTOR_ID_PATTERN),
    assurance: z.enum(ASSURANCES),
  })
  .strict()
  .superRefine((actor, ctx) => {
    const expected = EXPECTED_ASSURANCE[actor.kind];
    if (actor.assurance !== expected) {
      ctx.addIssue({
        code: 'custom',
        message: `a ${actor.kind} actor has assurance ${expected}`,
        path: ['assurance'],
      });
    }
  });

export type SecurityActor = Readonly<z.infer<typeof SecurityActorSchema>>;

/** The only assurance each kind may carry (plan §2). */
const EXPECTED_ASSURANCE: Readonly<Record<ActorKind, Assurance>> = {
  source_sync: 'system',
  system: 'system',
  operator: 'asserted',
  human_user: 'authenticated',
  ai: 'system',
};

export class InvalidActorError extends Error {
  constructor(readonly reason: string) {
    super(`Invalid actor: ${reason}`);
    this.name = 'InvalidActorError';
  }
}

function make(kind: ActorKind, id: string): SecurityActor {
  const parsed = SecurityActorSchema.safeParse({ kind, id, assurance: EXPECTED_ASSURANCE[kind] });
  if (!parsed.success) throw new InvalidActorError(`${kind} id must match ${ACTOR_ID_PATTERN}`);
  return Object.freeze(parsed.data);
}

/** A person at a CLI: identity asserted, never authenticated. */
export const operatorActor = (id: string): SecurityActor => make('operator', id);
/** A platform process (worker, webhook intake, OAuth callback). */
export const systemActor = (id: string): SecurityActor => make('system', id);
/** A source sync or ingestion run. */
export const sourceSyncActor = (id: string): SecurityActor => make('source_sync', id);

/**
 * Q1: the operator id for an executing CLI command, from `--actor` or
 * `LIP_OPERATOR_ID`. Returns `undefined` when neither is set; the caller refuses
 * `--execute` in that case (`operator_id_required`).
 */
export function operatorIdFrom(
  flag: string | undefined,
  env: string | undefined,
): string | undefined {
  const value = (flag ?? env ?? '').trim();
  return value === '' ? undefined : value;
}
