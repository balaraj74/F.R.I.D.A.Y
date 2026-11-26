import type { Command } from "commander";

import { forgetEntity, listEntities, lookup, search } from "../agents/knowledge/graph.js";
import { defaultRuntime } from "../runtime.js";

export function registerKnowledgeCli(program: Command) {
  const cmd = program
    .command("knowledge")
    .description("FRIDAY's knowledge graph: people, projects and how they connect");

  cmd
    .command("list", { isDefault: true })
    .description("Known entities, most mentioned first")
    .option("--type <type>", "person | organization | project | place | thing | event")
    .action((opts: { type?: string }) => {
      const list = listEntities(opts.type);
      if (!list.length)
        return defaultRuntime.log(
          "Nothing in the knowledge graph yet. It fills in from conversations every 20 minutes.",
        );
      for (const e of list)
        defaultRuntime.log(
          `${e.name.padEnd(28)} ${e.type.padEnd(13)} ${String(e.mentions).padStart(3)}×  ${e.summary}`,
        );
    });

  cmd
    .command("show <name...>")
    .description("Everything known about one entity, including superseded facts")
    .action((words: string[]) => {
      const res = lookup(words.join(" "));
      if (!res) return defaultRuntime.log("Not found.");
      defaultRuntime.log(
        `${res.entity.name} (${res.entity.type})${res.entity.summary ? `: ${res.entity.summary}` : ""}`,
      );
      for (const f of res.facts)
        defaultRuntime.log(`  • ${f.fact}  [#${f.id}, since ${f.validFrom.slice(0, 10)}]`);
      for (const f of res.history)
        defaultRuntime.log(`  ✗ ${f.fact}  [#${f.id}, until ${f.invalidAt?.slice(0, 10)}]`);
    });

  cmd
    .command("search <query...>")
    .description("Find entities and facts")
    .action((words: string[]) => {
      const res = search(words.join(" "));
      for (const e of res.entities) defaultRuntime.log(`${e.name} (${e.type}) ${e.summary}`);
      for (const f of res.facts) defaultRuntime.log(`  • ${f.fact}`);
      if (!res.entities.length && !res.facts.length) defaultRuntime.log("No matches.");
    });

  cmd
    .command("forget <name...>")
    .description("Remove an entity and all its facts")
    .action((words: string[]) => {
      defaultRuntime.log(forgetEntity(words.join(" ")) ? "Forgotten." : "Not found.");
    });
}
