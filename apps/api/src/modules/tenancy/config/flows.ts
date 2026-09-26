import { z } from 'zod';
import type { IntegrationAccess, IntegrationSystem } from './integrations';

/**
 * Business flows the platform can run for a tenant, each switched
 * independently so the platform can coexist with, or replace, an existing
 * integration (for example a Fuelius-built HubSpot → Sugar sync). ADR 0004.
 */
export const FlowSchema = z.enum([
  /** HubSpot Lead → Sugar Lead handover. */
  'hubspot_to_sugar_handover',
  /** Sugar stage / outcome changes → HubSpot. */
  'sugar_to_hubspot_outcomes',
  /** Create Leads from Gainsight PX/CS intelligence signals. */
  'gainsight_lead_creation',
  /** Enrich HubSpot records with product-usage context. */
  'hubspot_enrichment',
]);
export type Flow = z.infer<typeof FlowSchema>;

/**
 * - `off`: nothing runs.
 * - `shadow`: the platform runs the logic and records what it *would* do, but
 *   writes nothing to external systems (safe pilots and comparisons).
 * - `coexist`: another integration owns the writes; the platform only reads
 *   and matches records through cross-references.
 * - `active`: the platform owns the flow and writes.
 */
export const FlowModeSchema = z.enum(['off', 'shadow', 'coexist', 'active']);
export type FlowMode = z.infer<typeof FlowModeSchema>;

/** `coexist` only makes sense where another integration could own the flow. */
export const ALLOWED_FLOW_MODES: Readonly<Record<Flow, readonly FlowMode[]>> = {
  hubspot_to_sugar_handover: ['off', 'shadow', 'coexist', 'active'],
  sugar_to_hubspot_outcomes: ['off', 'shadow', 'coexist', 'active'],
  gainsight_lead_creation: ['off', 'shadow', 'active'],
  hubspot_enrichment: ['off', 'shadow', 'active'],
};

type AccessNeeds = Partial<Record<IntegrationSystem, IntegrationAccess>>;

/** Minimum integration access each flow needs, per mode (writes only when active). */
export const FLOW_REQUIREMENTS: Readonly<
  Record<Flow, Readonly<Record<Exclude<FlowMode, 'off'>, AccessNeeds>>>
> = {
  hubspot_to_sugar_handover: {
    shadow: { hubspot: 'read_only', sugar: 'read_only' },
    coexist: { hubspot: 'read_only', sugar: 'read_only' },
    active: { hubspot: 'read_write', sugar: 'read_write' },
  },
  sugar_to_hubspot_outcomes: {
    shadow: { hubspot: 'read_only', sugar: 'read_only' },
    coexist: { hubspot: 'read_only', sugar: 'read_only' },
    active: { hubspot: 'read_write', sugar: 'read_only' },
  },
  gainsight_lead_creation: {
    shadow: { gainsight_cs: 'read_only', hubspot: 'read_only' },
    coexist: {},
    active: { gainsight_cs: 'read_only', hubspot: 'read_write' },
  },
  hubspot_enrichment: {
    shadow: { gainsight_px: 'read_only', hubspot: 'read_only' },
    coexist: {},
    active: { gainsight_px: 'read_only', hubspot: 'read_write' },
  },
};

const ACCESS_RANK: Readonly<Record<IntegrationAccess, number>> = {
  disabled: 0,
  read_only: 1,
  read_write: 2,
};

export function satisfiesAccess(actual: IntegrationAccess, needed: IntegrationAccess): boolean {
  return ACCESS_RANK[actual] >= ACCESS_RANK[needed];
}

export interface FlowSetting {
  readonly flow: Flow;
  readonly mode: FlowMode;
  readonly version: number;
}

/**
 * Returns the problems with running `flow` in `mode` given the tenant's
 * integration access (empty when valid). Pure, so config changes can be
 * validated before anything is written.
 */
export function flowConfigurationProblems(
  flow: Flow,
  mode: FlowMode,
  access: Readonly<Partial<Record<IntegrationSystem, IntegrationAccess>>>,
): string[] {
  if (!ALLOWED_FLOW_MODES[flow].includes(mode)) {
    return [`${flow} does not support mode "${mode}"`];
  }
  if (mode === 'off') return [];
  const needs = FLOW_REQUIREMENTS[flow][mode];
  return Object.entries(needs).flatMap(([system, needed]) => {
    const actual = access[system as IntegrationSystem] ?? 'disabled';
    return satisfiesAccess(actual, needed)
      ? []
      : [`${flow} in mode "${mode}" needs ${system} access "${needed}" (currently "${actual}")`];
  });
}
