import path from "node:path";

import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";

/**
 * pi 1.x replaced `discoverAuthStorage(agentDir)` + `discoverModels(auth, agentDir)` with an async
 * `ModelRuntime` (credentials + models.json) and a `ModelRegistry` view over it.
 *
 * Each call builds a fresh runtime on purpose: runs set per-run API keys (auth-profile rotation)
 * with `setRuntimeApiKey`, and a shared runtime would leak one run's key into a concurrent run.
 * Network catalog refresh stays off so building a runtime only reads the two local files.
 */
export type PiModelRuntime = {
  modelRuntime: ModelRuntime;
  modelRegistry: ModelRegistry;
};

export async function createPiModelRuntime(agentDir: string): Promise<PiModelRuntime> {
  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"),
    modelsPath: path.join(agentDir, "models.json"),
    allowModelNetwork: false,
  });
  return { modelRuntime, modelRegistry: new ModelRegistry(modelRuntime) };
}

export type { ModelRegistry, ModelRuntime };
