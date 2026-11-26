import { Value } from "@sinclair/typebox/value";
import { checkContrast, isHexColor } from "./contrast.js";
import { flattenTokens } from "./flatten.js";
import {
  TokenFileSchema,
  type TokenError,
  type TokenFile,
  type ValidationResult,
} from "./types.js";

/** Token names become CSS custom-property and Tailwind key segments. */
const TOKEN_NAME = /^[a-z0-9][a-z0-9-]*$/;
/** Characters that could end a CSS declaration or open a new rule/comment. */
const UNSAFE_CSS_VALUE = /[;{}\\\r\n]|\/\*|\*\//;

function checkName(name: string, path: string, errors: TokenError[]): void {
  if (!TOKEN_NAME.test(name)) {
    errors.push({
      path,
      reason:
        "token name must be lowercase letters, digits and hyphens, starting with a letter or digit",
    });
  }
}

function checkScalar(value: unknown, path: string, errors: TokenError[]): void {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      errors.push({ path, reason: "number must be finite" });
    }
    return;
  }
  if (typeof value !== "string") {
    errors.push({ path, reason: "expected a string or number" });
    return;
  }
  if (value.trim() === "") {
    errors.push({ path, reason: "value must not be empty" });
  } else if (UNSAFE_CSS_VALUE.test(value)) {
    errors.push({ path, reason: "value contains characters not allowed in a CSS declaration" });
  }
}

function checkTypeTokens(tokens: Record<string, unknown>, errors: TokenError[]): void {
  for (const [name, value] of Object.entries(tokens)) {
    const path = `/type/${name}`;
    checkName(name, path, errors);
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const nested = Object.entries(value);
      if (nested.length === 0) {
        errors.push({ path, reason: "nested type token must have at least one entry" });
      }
      for (const [sub, subValue] of nested) {
        checkName(sub, `${path}/${sub}`, errors);
        if (typeof subValue === "object" && subValue !== null) {
          errors.push({ path: `${path}/${sub}`, reason: "type tokens may nest only one level" });
        } else {
          checkScalar(subValue, `${path}/${sub}`, errors);
        }
      }
    } else {
      checkScalar(value, path, errors);
    }
  }
}

/** Value-level rules, run only after the structural schema passes. */
function semanticErrors(tf: TokenFile): TokenError[] {
  const errors: TokenError[] = [];

  for (const [name, value] of Object.entries(tf.color)) {
    const path = `/color/${name}`;
    checkName(name, path, errors);
    if (!isHexColor(value)) {
      errors.push({ path, reason: "colour must be a 3 or 6 digit hex value such as #1a2b3c" });
    }
  }
  checkTypeTokens(tf.type, errors);
  for (const category of ["spacing", "radius", "elevation", "motion"] as const) {
    for (const [name, value] of Object.entries(tf[category])) {
      const path = `/${category}/${name}`;
      checkName(name, path, errors);
      checkScalar(value, path, errors);
    }
  }

  (tf.contrastPairs ?? []).forEach((pair, i) => {
    for (const side of ["text", "background"] as const) {
      const name = pair[side];
      if (!Object.prototype.hasOwnProperty.call(tf.color, name)) {
        errors.push({
          path: `/contrastPairs/${i}/${side}`,
          reason: `refers to unknown colour token "${name}"`,
        });
      }
    }
  });

  // `type` nesting flattens with "-", so {a:{b}} and a flat "a-b" would collide.
  const seen = new Set<string>();
  for (const entry of flattenTokens(tf)) {
    if (seen.has(entry.cssName)) {
      errors.push({
        path: `/${entry.category}`,
        reason: `duplicate CSS variable --${entry.cssName}`,
      });
    }
    seen.add(entry.cssName);
  }
  return errors;
}

/**
 * Validates an unknown value as a Token_File: structure (TypeBox), value rules,
 * then WCAG contrast of every declared text/background pair. Reports every
 * problem found rather than stopping at the first.
 */
export function validateTokenFile(input: unknown): ValidationResult {
  if (!Value.Check(TokenFileSchema, input)) {
    const seen = new Set<string>();
    const errors: TokenError[] = [];
    for (const err of Value.Errors(TokenFileSchema, input)) {
      const key = `${err.path}\u0000${err.message}`;
      if (!seen.has(key)) {
        seen.add(key);
        errors.push({ path: err.path, reason: err.message });
      }
    }
    return { ok: false, errors };
  }
  const tf = input as TokenFile;

  const errors = semanticErrors(tf);
  // checkContrast skips pairs with unknown or non-hex colours, which are already reported above.
  (tf.contrastPairs ?? []).forEach((pair, i) => {
    const failure = checkContrast({ ...tf, contrastPairs: [pair] })[0];
    if (failure) {
      errors.push({
        path: `/contrastPairs/${i}`,
        reason: `text "${failure.fg}" on background "${failure.bg}" has contrast ratio ${failure.ratio.toFixed(2)}:1, below the 4.5:1 minimum`,
      });
    }
  });
  return errors.length === 0 ? { ok: true, tokens: tf } : { ok: false, errors };
}
