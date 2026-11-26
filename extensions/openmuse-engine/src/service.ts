import path from "node:path";
import os from "node:os";
import type { FRIDAYPluginService, FRIDAYPluginServiceContext } from "../../../src/plugins/types.js";
import { OpenMuseDatabase } from "./db/schema.js";
import { TaskRunner } from "./task-engine/task-runner.js";
import { BrowserDaemon } from "./browser-worker/browser-daemon.js";

export class OpenMuseSubstrateService implements FRIDAYPluginService {
  public id = "openmuse-engine";
  public db: OpenMuseDatabase | null = null;
  public taskRunner: TaskRunner | null = null;
  public browserDaemon: BrowserDaemon | null = null;

  public async start(ctx: FRIDAYPluginServiceContext): Promise<void> {
    ctx.logger.info("[OpenMuse] Initializing headless substrate engine...");

    const pluginConfig = (ctx.config?.plugins as any)?.["openmuse-engine"] || {};
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

    this.db = new OpenMuseDatabase(taskDbPath);
    this.browserDaemon = new BrowserDaemon(browserProfileDir);
    this.taskRunner = new TaskRunner(this.db, concurrency);

    // Register built-in worker handlers
    this.taskRunner.registerHandler("browser-navigate", async (input: any) => {
      if (!this.browserDaemon) throw new Error("Browser daemon unavailable");
      const url = typeof input === "string" ? input : input?.url;
      const profile = input?.profileId || "default";
      return await this.browserDaemon.navigate(url, profile);
    });

    this.taskRunner.registerHandler("browser-snapshot", async (input: any) => {
      if (!this.browserDaemon) throw new Error("Browser daemon unavailable");
      const profile = input?.profileId || "default";
      return await this.browserDaemon.snapshot(profile);
    });

    this.taskRunner.registerHandler("browser-screenshot", async (input: any) => {
      if (!this.browserDaemon) throw new Error("Browser daemon unavailable");
      const profile = input?.profileId || "default";
      return await this.browserDaemon.screenshot(profile);
    });

    this.taskRunner.start();
    ctx.logger.info("[OpenMuse] Headless substrate engine active (persistent browser & durable tasks).");
  }

  public async stop(ctx: FRIDAYPluginServiceContext): Promise<void> {
    ctx.logger.info("[OpenMuse] Shutting down headless substrate engine...");
    if (this.taskRunner) {
      this.taskRunner.stop();
      this.taskRunner = null;
    }
    if (this.browserDaemon) {
      await this.browserDaemon.closeAll();
      this.browserDaemon = null;
    }
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    ctx.logger.info("[OpenMuse] Headless substrate engine stopped cleanly.");
  }
}
