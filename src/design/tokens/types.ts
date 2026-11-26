import { Type, type TSchema } from "@sinclair/typebox";

/** Token categories in the fixed order used for validation and generated output. */
export const TOKEN_CATEGORIES = [
  "color",
  "type",
  "spacing",
  "radius",
  "elevation",
  "motion",
] as const;

export type TokenCategory = (typeof TOKEN_CATEGORIES)[number];

/** Minimum WCAG 2.1 contrast ratio (AA, normal text) for a text/background pair. */
export const MIN_CONTRAST_RATIO = 4.5;

const nonEmptyRecord = <T extends TSchema>(value: T) =>
  Type.Record(Type.String(), value, { minProperties: 1 });

/**
 * Structural schema only. Value-level rules (hex colours, CSS-safe strings,
 * key names, contrast pair references) live in `validate.ts` so each failure
 * can carry a precise reason.
 */
export const TokenFileSchema = Type.Object(
  {
    version: Type.Literal(1),
    color: nonEmptyRecord(Type.String()),
    // Type tokens may be a scalar or one level of nesting, checked in validate.ts.
    type: nonEmptyRecord(Type.Unknown()),
    spacing: nonEmptyRecord(Type.String()),
    radius: nonEmptyRecord(Type.String()),
    elevation: nonEmptyRecord(Type.String()),
    motion: nonEmptyRecord(Type.String()),
    // Text/background pairs (names of `color` tokens) that must meet 4.5:1.
    contrastPairs: Type.Optional(
      Type.Array(
        Type.Object(
          { text: Type.String(), background: Type.String() },
          { additionalProperties: false },
        ),
      ),
    ),
  },
  { additionalProperties: false },
);

export type TypeTokenValue = string | number | Record<string, string | number>;

export interface ContrastPair {
  text: string;
  background: string;
}

export interface TokenFile {
  version: 1;
  color: Record<string, string>;
  type: Record<string, TypeTokenValue>;
  spacing: Record<string, string>;
  radius: Record<string, string>;
  elevation: Record<string, string>;
  motion: Record<string, string>;
  contrastPairs?: ContrastPair[];
}

export interface TokenError {
  /** JSON-pointer style path of the invalid token, e.g. `/color/ink`. Empty string for the whole file. */
  path: string;
  reason: string;
}

export interface ContrastFailure {
  /** Text colour token name. */
  fg: string;
  /** Background colour token name. */
  bg: string;
  /** WCAG 2.1 contrast ratio rounded to two decimal places. */
  ratio: number;
}

export type ValidationResult =
  | { ok: true; tokens: TokenFile }
  | { ok: false; errors: TokenError[] };
