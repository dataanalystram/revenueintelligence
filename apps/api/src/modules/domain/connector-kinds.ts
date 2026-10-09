import { z } from 'zod';

/**
 * The connector-kind catalogue (ADR 0019): every source system the platform
 * can hold facts from, declared in code and mirrored by the `connector_kinds`
 * reference table (seeded by migration; every source-system column references
 * it by foreign key). A new kind is one entry here, one INSERT migration and
 * its adapter module. Values are stable identifiers (`sugar` stays `sugar`).
 */
export interface ConnectorKindEntry {
  readonly kind: string;
  readonly displayName: string;
  /** Records of this kind become canonical external references (M6). */
  readonly externalReferences: boolean;
  /** How the kind maps into canonical facts: versioned mappings or adapter code. */
  readonly mappingMode: 'versioned' | 'code';
  /** A source adapter module ships for this kind in this release. */
  readonly hasAdapter: boolean;
}

export const CONNECTOR_KIND_CATALOGUE = [
  {
    kind: 'hubspot',
    displayName: 'HubSpot',
    externalReferences: true,
    mappingMode: 'code',
    hasAdapter: true,
  },
  {
    kind: 'sugar',
    displayName: 'SugarCRM',
    externalReferences: true,
    mappingMode: 'versioned',
    hasAdapter: true,
  },
  {
    kind: 'gainsight_cs',
    displayName: 'Gainsight CS',
    externalReferences: true,
    mappingMode: 'versioned',
    hasAdapter: false,
  },
  {
    kind: 'gainsight_px',
    displayName: 'Gainsight PX',
    externalReferences: true,
    mappingMode: 'versioned',
    hasAdapter: false,
  },
  {
    kind: 'chargebee',
    displayName: 'Chargebee',
    externalReferences: true,
    mappingMode: 'versioned',
    hasAdapter: true,
  },
  {
    kind: 'import',
    displayName: 'Operator import (CSV)',
    externalReferences: false,
    mappingMode: 'code',
    hasAdapter: true,
  },
] as const satisfies readonly ConnectorKindEntry[];

type CatalogueKind = (typeof CONNECTOR_KIND_CATALOGUE)[number]['kind'];
type ReferenceKind = Extract<
  (typeof CONNECTOR_KIND_CATALOGUE)[number],
  { externalReferences: true }
>['kind'];

const ALL_KINDS = CONNECTOR_KIND_CATALOGUE.map((k) => k.kind) as [
  CatalogueKind,
  ...CatalogueKind[],
];
const REFERENCE_KINDS = CONNECTOR_KIND_CATALOGUE.filter((k) => k.externalReferences).map(
  (k) => k.kind,
) as [ReferenceKind, ...ReferenceKind[]];

/** Any catalogue kind (source connections, provenance, checkpoints, subscription sources). */
export const ConnectorKindSchema = z.enum(ALL_KINDS);
export type ConnectorKind = z.infer<typeof ConnectorKindSchema>;

/** Kinds whose records are canonical external references (everything except `import`). */
export const ReferenceKindSchema = z.enum(REFERENCE_KINDS);

export function connectorKindEntry(kind: ConnectorKind): ConnectorKindEntry {
  return CONNECTOR_KIND_CATALOGUE.find((k) => k.kind === kind)!;
}
