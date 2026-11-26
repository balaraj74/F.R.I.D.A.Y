// Minimal selection types used by the Design_Spec generator.
// These mirror the names and shapes defined in `../refs/selection.ts` (task 1.5) so the
// two stay structurally compatible. Once selection.ts lands, this file can re-export from it.
import type { RefIndex, Screen, StyleDirection } from "../refs/plan.js";

export type Verdict = "keep" | "reject" | "mix";

export type SelectionEntry = {
  screen: Screen;
  direction: StyleDirection;
  index: RefIndex;
  verdict: Verdict;
  /** 0 to 500 characters. */
  note: string;
};

export type SelectionFile = {
  version: 1;
  entries: SelectionEntry[];
};
