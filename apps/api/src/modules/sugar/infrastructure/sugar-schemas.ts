import { z } from 'zod';
import type { SourceField, SourceFieldType } from '../../domain';

/**
 * Sugar response shapes, validated at the connector boundary. Endpoint shapes
 * follow the historical client and current documentation and are re-checked
 * at the live gate (ADR 0021, LIVE): nothing here is tenant-verified yet.
 */

const Primitive = z.union([z.string(), z.number(), z.boolean(), z.null()]);

/** `GET /{Module}/fields`: field definitions keyed by API name (LIVE shape). */
export const SugarFieldsResponseSchema = z.looseObject({
  fields: z.record(
    z.string(),
    z.looseObject({
      name: z.string().max(100),
      type: z.string().max(50),
      label: z.string().max(200).optional(),
      vname: z.string().max(200).optional(),
      required: z.union([z.boolean(), z.string()]).optional(),
      /** Inline enum options (`{value: label}`) or the name of a dropdown list. */
      options: z.union([z.record(z.string(), z.string()), z.string()]).optional(),
      module: z.string().max(100).optional(),
      unique: z.boolean().optional(),
    }),
  ),
});
export type SugarFieldsResponse = z.infer<typeof SugarFieldsResponseSchema>;

/** `GET /{Module}`: one page of records (`next_offset` = -1 at the end). */
export const SugarListResponseSchema = z.looseObject({
  next_offset: z.number().int(),
  records: z.array(z.looseObject({ id: z.string().min(1).max(255) })).max(1000),
});

/** `GET /{Module}/count`. */
export const SugarCountResponseSchema = z.looseObject({
  record_count: z.number().int().min(0),
});

/** `GET /{Module}/{id}`. */
export const SugarRecordResponseSchema = z.looseObject({ id: z.string().min(1).max(255) });

export const SugarPingResponseSchema = z.literal('pong');

export const SugarPrimitiveSchema = Primitive;

const TYPE_MAP: Record<string, SourceFieldType> = {
  id: 'id',
  varchar: 'string',
  name: 'string',
  fullname: 'string',
  url: 'string',
  phone: 'string',
  email: 'string',
  char: 'string',
  text: 'text',
  longtext: 'text',
  enum: 'enum',
  radioenum: 'enum',
  date: 'date',
  datetime: 'datetime',
  datetimecombo: 'datetime',
  int: 'integer',
  integer: 'integer',
  decimal: 'number',
  float: 'number',
  double: 'number',
  currency: 'number',
  bool: 'boolean',
  relate: 'relate',
};

/** Normalises one Sugar field definition (metadata only: no values, no defaults). */
export function normaliseSugarField(
  module: string,
  def: SugarFieldsResponse['fields'][string],
): SourceField | undefined {
  if (!/^[A-Za-z][A-Za-z0-9_]{0,99}$/.test(def.name)) return undefined;
  let type: SourceFieldType = TYPE_MAP[def.type.toLowerCase()] ?? 'other';
  const relatesTo =
    def.module && /^[A-Za-z][A-Za-z0-9_]{0,99}$/.test(def.module) && def.module !== module
      ? def.module
      : undefined;
  // An id column pointing at another module is a reference.
  if (type === 'id' && relatesTo) type = 'relate';
  const label = (def.label ?? def.vname)?.trim().slice(0, 200);
  return {
    name: def.name,
    ...(label ? { label } : {}),
    type,
    sourceType: def.type.slice(0, 100),
    required: def.required === true || def.required === 'true',
    unique: def.name === 'id' || def.unique === true,
    ...(type === 'enum' && def.options && typeof def.options === 'object'
      ? {
          enumOptions: Object.entries(def.options)
            .filter(([value]) => value.length <= 200)
            .slice(0, 2000)
            .map(([value, optionLabel]) => ({
              value,
              ...(optionLabel ? { label: optionLabel.slice(0, 200) } : {}),
              active: true,
            })),
        }
      : {}),
    ...(type === 'relate' && relatesTo ? { relatesTo } : {}),
  };
}
