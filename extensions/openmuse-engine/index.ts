import path from "node:path";
import os from "node:os";
import type { FRIDAYPluginApi } from "../../src/plugins/types.js";
import { OpenMuseSubstrateService } from "./src/service.js";
import { createBrowserTool } from "./src/tools/browser-tool.js";
import { createTaskTool } from "./src/tools/task-tool.js";
import { OpenMuseDatabase } from "./src/db/schema.js";
import { TaskRunner } from "./src/task-engine/task-runner.js";
import { BrowserDaemon } from "./src/browser-worker/browser-daemon.js";

export default function register(api: FRIDAYPluginApi) {
  const pluginConfig = (api.pluginConfig ?? {}) as {
    enabled?: boolean;
    taskDbPath?: string;
    browserProfileDir?: string;
    workerConcurrency?: number;
  };

  if (pluginConfig.enabled === false) {
    api.logger.info("[OpenMuse] Engine disabled in configuration.");
    return;
  }

  const taskDbPath =
    pluginConfig.taskDbPath ||
    path.join(os.homedir(), ".friday", "openmuse", "tasks.db");
  const browserProfileDir =
    pluginConfig.browserProfileDir ||
    path.join(os.homedir(), ".friday", "openmuse", "browser_profiles");
  const concurrency =
    typeof pluginConfig.workerConcurrency === "number"
      ? pluginConfig.workerConcurrency
      : 2;

  // Standalone shared instances for tools and runtime
  const db = new OpenMuseDatabase(taskDbPath);
  const browserDaemon = new BrowserDaemon(browserProfileDir);
  const taskRunner = new TaskRunner(db, concurrency);

  // Register built-in worker task handlers
  taskRunner.registerHandler("browser-navigate", async (input: any) => {
    const url = typeof input === "string" ? input : input?.url;
    const profile = input?.profileId || "default";
    return await browserDaemon.navigate(url, profile);
  });

  taskRunner.registerHandler("browser-snapshot", async (input: any) => {
    const profile = input?.profileId || "default";
    return await browserDaemon.snapshot(profile);
  });

  taskRunner.registerHandler("browser-screenshot", async (input: any) => {
    const profile = input?.profileId || "default";
    return await browserDaemon.screenshot(profile);
  });

  taskRunner.start();

  // Register background supervisor service
  const service = new OpenMuseSubstrateService();
  service.db = db;
  service.browserDaemon = browserDaemon;
  service.taskRunner = taskRunner;
  api.registerService(service);

  // Register agent tools
  api.registerTool(createBrowserTool(api, browserDaemon), { optional: true });
  api.registerTool(createTaskTool(api, taskRunner), { optional: true });

  // Register internal Gateway RPC method for headless health checks
  api.registerGatewayMethod("openmuse.status", async (_conn, params) => {
    const runningTasks = taskRunner.listTasks("running", 10);
    const pendingTasks = taskRunner.listTasks("pending", 10);
    return {
      status: "active",
      concurrency,
      workerId: (taskRunner as any).workerId,
      tasks: {
        running: runningTasks.length,
        pending: pendingTasks.length,
      },
      browser: {
        profilesDir: browserProfileDir,
      },
    };
  });

  api.logger.info("[OpenMuse] Headless substrate engine registered (tools: muse_browser, muse_task).");
}
