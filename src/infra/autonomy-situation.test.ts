import { describe, expect, it } from "vitest";

import { dueAgenda, formatSituation, openMemoryTags, repoItems } from "./autonomy-situation.js";

describe("autonomy situation report", () => {
  const at = (h: number, m: number) => new Date(2026, 9, 22, h, m);

  it("lists agenda items due soon or started but not done", () => {
    const items = dueAgenda(
      [
        { time: "15:30", title: "Cinetra review" },
        { time: "14:00", title: "Gym" },
        { time: "20:00", title: "Later" },
        { time: "15:10", title: "Done thing", completed: true },
      ],
      at(15, 0),
    );
    expect(items.map((i) => i.text)).toEqual([
      "Cinetra review at 15:30 (in 30 min)",
      "Gym started at 14:00, not marked done",
    ]);
  });

  it("finds open reminder tags but skips done items and legend lines", () => {
    const items = openMemoryTags([
      {
        name: "MEMORY.md",
        content: [
          "- `[REMIND]` — Items Sir requests to be alerted about.",
          "- [REMIND] Submit DBMS lab by Friday",
          "- [x] [URGENT] renew domain",
        ].join("\n"),
      },
    ]);
    expect(items.map((i) => i.text)).toEqual(["MEMORY.md: - [REMIND] Submit DBMS lab by Friday"]);
  });

  it("reports unpushed/behind per repo and folds uncommitted work into one line", () => {
    const items = repoItems([
      { name: "Maya", porcelain: "## main...origin/main [ahead 2]\n M a.ts\n" },
      { name: "Darwin", porcelain: "## main...origin/main\n M x.py\n?? y.py\n" },
      { name: "Clean", porcelain: "## main...origin/main\n" },
    ]);
    expect(items.map((i) => i.text)).toEqual([
      "Maya: 2 unpushed commits",
      "Uncommitted work in 2 repo(s): Maya, Darwin (informational)",
    ]);
  });

  it("says plainly when nothing needs attention", () => {
    expect(formatSituation([], at(9, 0))).toMatch(/nothing needs attention/);
  });
});
