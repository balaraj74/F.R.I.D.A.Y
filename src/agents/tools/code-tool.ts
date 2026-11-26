import { Type } from "@sinclair/typebox";

import {
  getTask,
  listTasks,
  mergeTask,
  removeTask,
  reviewTask,
  runTests,
  startTask,
} from "../code/worktree.js";
import { stringEnum } from "../schema/typebox.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

const ACTIONS = ["start", "list", "test", "review", "merge", "discard"] as const;

const CodeSchema = Type.Object({
  action: stringEnum(ACTIONS, {
    description:
      "start = new branch + separate working copy for a task; list = open tasks; test = run the project's tests " +
      "there; review = commit the changes and show the diff; merge = merge into Sir's branch (ONLY when Sir says " +
      "merge); discard = throw the task away",
  }),
  repo: Type.Optional(Type.String({ description: "start: path to Sir's git repository" })),
  task: Type.Optional(Type.String({ description: "start: what to change, in a sentence" })),
  id: Type.Optional(
    Type.String({ description: "test/review/merge/discard: task id from start/list" }),
  ),
  command: Type.Optional(
    Type.String({
      description: "test: test command, only if the project's own one can't be detected",
    }),
  ),
  message: Type.Optional(Type.String({ description: "review: commit message for the changes" })),
});

export function createCodeTool(options: { workspaceDir?: string } = {}): AnyAgentTool {
  const ws = () => {
    if (!options.workspaceDir) throw new Error("Coding tasks need FRIDAY's workspace folder.");
    return options.workspaceDir;
  };
  return {
    label: "Code",
    name: "code",
    description:
      "Work on Sir's code safely: `start` gives you your own branch and a separate copy of his repo (his checkout " +
      "and uncommitted work are untouched). Edit files in the returned `dir` with your file tools, `test`, then " +
      "`review` and show Sir the summary and diff. Never merge unless Sir explicitly says to; never push.",
    parameters: CodeSchema,
    execute: async (_toolCallId, params) => {
      const action = readStringParam(params, "action", { required: true });
      if (action === "list") return jsonResult({ tasks: listTasks(ws()) });
      if (action === "start") {
        const t = await startTask({
          workspaceDir: ws(),
          repo: readStringParam(params, "repo", { required: true }),
          task: readStringParam(params, "task", { required: true }),
        });
        return jsonResult({ ...t, note: `Edit files under ${t.dir}, not in ${t.repo}.` });
      }
      const task = getTask(ws(), readStringParam(params, "id", { required: true }));
      switch (action) {
        case "test":
          return jsonResult(await runTests(task, readStringParam(params, "command")));
        case "review":
          return jsonResult({
            branch: task.branch,
            ...(await reviewTask(task, readStringParam(params, "message"))),
          });
        case "merge":
          return jsonResult({
            merged: task.branch,
            into: task.base,
            output: await mergeTask(ws(), task),
          });
        case "discard":
          await removeTask(ws(), task);
          return jsonResult({ discarded: task.id });
        default:
          throw new Error(`Unknown action: ${action}`);
      }
    },
  };
}
