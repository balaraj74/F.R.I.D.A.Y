import { Type } from "@sinclair/typebox";
import type { FRIDAYPluginApi } from "../../../../src/plugins/types.js";
import type { TaskRunner } from "../task-engine/task-runner.js";

export function createTaskTool(_api: FRIDAYPluginApi, runner: TaskRunner) {
  return {
    name: "muse_task",
    description:
      "OpenMuse durable task engine. Allows creating, monitoring, and controlling crash-resilient background tasks backed by atomic SQLite leases.",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("create"),
        Type.Literal("status"),
        Type.Literal("cancel"),
        Type.Literal("pause"),
        Type.Literal("resume"),
        Type.Literal("list"),
      ], { description: "Task operation to perform." }),
      category: Type.Optional(Type.String({ description: "Category/type of task (for 'create')." })),
      input: Type.Optional(Type.Unknown({ description: "Input payload (for 'create')." })),
      taskId: Type.Optional(Type.String({ description: "Task ID (for 'status', 'cancel', 'pause', 'resume')." })),
      statusFilter: Type.Optional(Type.String({ description: "Filter for 'list' (e.g. 'pending', 'running', 'completed', 'failed')." })),
      limit: Type.Optional(Type.Number({ description: "Max tasks to list (default: 20)." })),
      maxRetries: Type.Optional(Type.Number({ description: "Max retries on crash/lease failure (default: 3)." })),
    }),

    async execute(_id: string, params: Record<string, unknown>) {
      const action = String(params.action || "");

      switch (action) {
        case "create": {
          const category = params.category as string;
          if (!category) throw new Error("category is required for 'create' action");
          const input = params.input;
          const maxRetries = typeof params.maxRetries === "number" ? params.maxRetries : 3;
          const task = runner.createTask(category, input, maxRetries);
          return {
            content: [{ type: "text", text: JSON.stringify(task, null, 2) }],
            details: task,
          };
        }
        case "status": {
          const taskId = params.taskId as string;
          if (!taskId) throw new Error("taskId is required for 'status' action");
          const task = runner.getTask(taskId);
          if (!task) throw new Error(`Task not found: ${taskId}`);
          return {
            content: [{ type: "text", text: JSON.stringify(task, null, 2) }],
            details: task,
          };
        }
        case "cancel": {
          const taskId = params.taskId as string;
          if (!taskId) throw new Error("taskId is required for 'cancel' action");
          const success = runner.cancelTask(taskId);
          return {
            content: [{ type: "text", text: JSON.stringify({ success, taskId }, null, 2) }],
            details: { success, taskId },
          };
        }
        case "pause": {
          const taskId = params.taskId as string;
          if (!taskId) throw new Error("taskId is required for 'pause' action");
          const success = runner.pauseTask(taskId);
          return {
            content: [{ type: "text", text: JSON.stringify({ success, taskId }, null, 2) }],
            details: { success, taskId },
          };
        }
        case "resume": {
          const taskId = params.taskId as string;
          if (!taskId) throw new Error("taskId is required for 'resume' action");
          const success = runner.resumeTask(taskId);
          return {
            content: [{ type: "text", text: JSON.stringify({ success, taskId }, null, 2) }],
            details: { success, taskId },
          };
        }
        case "list": {
          const status = params.statusFilter as string | undefined;
          const limit = typeof params.limit === "number" ? params.limit : 20;
          const tasks = runner.listTasks(status, limit);
          return {
            content: [{ type: "text", text: JSON.stringify({ tasks, count: tasks.length }, null, 2) }],
            details: { count: tasks.length },
          };
        }
        default:
          throw new Error(`Unknown task action: ${action}`);
      }
    },
  };
}
