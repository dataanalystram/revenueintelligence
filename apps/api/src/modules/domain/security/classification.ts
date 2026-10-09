import { z } from 'zod';
import { RETENTION_CLASSES } from './retention';

/**
 * Field classification (M10 plan §16.1, owner decision F3; M10A1 plan §9).
 * Sensitivity and data category are independent; `personal` is a category,
 * never a sensitivity level.
 */
export const SENSITIVITIES = ['public', 'internal', 'confidential', 'restricted'] as const;
export type Sensitivity = (typeof SENSITIVITIES)[number];

export const DATA_CATEGORIES = [
  'personal',
  'financial',
  'communication',
  'operational',
  'commercial',
  'security',
] as const;
export type DataCategory = (typeof DATA_CATEGORIES)[number];

/** What a column holds; drives where secret detection applies (plan §11). */
export const COLUMN_KINDS = [
  'identifier',
  'reference',
  'code',
  'free_text',
  'number',
  'boolean',
  'timestamp',
  'json',
  'ciphertext',
  'hash',
] as const;
export type ColumnKind = (typeof COLUMN_KINDS)[number];

export const HISTORY_POLICIES = ['full', 'value_free', 'none'] as const;
export type HistoryPolicy = (typeof HISTORY_POLICIES)[number];

/** How a row links to a data subject, for future export/erasure (control 17). */
export const SUBJECT_ACTIONS = ['export', 'erase', 'pseudonymise', 'retain'] as const;
export type SubjectAction = (typeof SUBJECT_ACTIONS)[number];

const RANK: Readonly<Record<Sensitivity, number>> = {
  public: 0,
  internal: 1,
  confidential: 2,
  restricted: 3,
};

/** Default floors: a field may be classified stricter, never weaker. */
export const CATEGORY_FLOORS: Readonly<Partial<Record<DataCategory, Sensitivity>>> = {
  personal: 'confidential',
  financial: 'confidential',
  security: 'confidential',
  communication: 'confidential',
};

export function atLeast(actual: Sensitivity, floor: Sensitivity): boolean {
  return RANK[actual] >= RANK[floor];
}

export const ColumnClassificationSchema = z
  .object({
    sensitivity: z.enum(SENSITIVITIES),
    categories: z.array(z.enum(DATA_CATEGORIES)).min(1),
    kind: z.enum(COLUMN_KINDS),
    retention: z.enum(RETENTION_CLASSES),
    history: z.enum(HISTORY_POLICIES),
    /** Present when the column links the row to a Person or Account. */
    subject: z
      .object({ entity: z.enum(['person', 'company']), action: z.enum(SUBJECT_ACTIONS) })
      .strict()
      .optional(),
    /** Q6: a classification the owner still has to confirm. Treated as `restricted`. */
    tbc: z
      .object({ reason: z.string().min(10), owner: z.string().min(2) })
      .strict()
      .optional(),
  })
  .strict();
export type ColumnClassification = z.infer<typeof ColumnClassificationSchema>;

/** Q6: a `tbc` entry is treated operationally as restricted. */
export function effectiveSensitivity(c: ColumnClassification): Sensitivity {
  return c.tbc ? 'restricted' : c.sensitivity;
}

/** Problems with one classification: floors, and credential material as free text. */
export function classificationProblems(column: string, c: ColumnClassification): string[] {
  const problems: string[] = [];
  for (const category of c.categories) {
    const floor = CATEGORY_FLOORS[category];
    if (floor && !atLeast(c.sensitivity, floor)) {
      problems.push(
        `${column}: category ${category} needs at least ${floor}, not ${c.sensitivity}`,
      );
    }
  }
  if (c.categories.includes('personal') && !c.subject) {
    problems.push(`${column}: a personal column needs a subject link`);
  }
  if (c.tbc && c.sensitivity !== 'restricted') {
    problems.push(`${column}: a tbc column is recorded as restricted`);
  }
  return problems;
}
