/** Splits on a separator at parenthesis depth 0 and drops empty parts. */
export function splitTopLevel(text: string, isSep: (ch: string) => boolean): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of text) {
    if (ch === "(") {
      depth++;
    } else if (ch === ")") {
      depth = Math.max(0, depth - 1);
    }
    if (depth === 0 && isSep(ch)) {
      if (current.trim()) {
        parts.push(current.trim());
      }
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) {
    parts.push(current.trim());
  }
  return parts;
}

const MAX_VALUE_LENGTH = 2000;

export interface DeclarationValue {
  /** Offset of the property name. */
  index: number;
  value: string;
}

/**
 * Finds `property: value` pairs in CSS or JS style objects. `propertyPattern` must be
 * global and end after the colon. A quoted value ends at its closing quote. An unquoted
 * value ends at the first terminator found outside parentheses (or a newline when
 * `terminators` includes "\n"), so multi-line CSS values are read whole.
 */
export function extractDeclarationValues(
  content: string,
  propertyPattern: RegExp,
  terminators: string[],
): DeclarationValue[] {
  const out: DeclarationValue[] = [];
  for (const m of content.matchAll(propertyPattern)) {
    const start = m.index + m[0].length;
    const first = content[start];
    if (first === '"' || first === "'" || first === "`") {
      const end = content.indexOf(first, start + 1);
      if (end !== -1 && end - start <= MAX_VALUE_LENGTH) {
        out.push({ index: m.index, value: content.slice(start + 1, end) });
      }
      continue;
    }
    let depth = 0;
    let end = start;
    while (end < content.length && end - start < MAX_VALUE_LENGTH) {
      const ch = content[end] as string;
      if (ch === "(") {
        depth++;
      } else if (ch === ")") {
        depth = Math.max(0, depth - 1);
      } else if (depth === 0 && terminators.includes(ch)) {
        break;
      }
      end++;
    }
    out.push({ index: m.index, value: content.slice(start, end) });
  }
  return out;
}
