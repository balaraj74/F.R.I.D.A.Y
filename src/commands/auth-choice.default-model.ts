import type { FRIDAYConfig } from "../config/config.js";
import type { WizardPrompter } from "../wizard/prompts.js";

export async function applyDefaultModelChoice(params: {
  config: FRIDAYConfig;
  setDefaultModel: boolean;
  defaultModel: string;
  applyDefaultConfig: (config: FRIDAYConfig) => FRIDAYConfig;
  applyProviderConfig: (config: FRIDAYConfig) => FRIDAYConfig;
  noteDefault?: string;
  noteAgentModel: (model: string) => Promise<void>;
  prompter: WizardPrompter;
}): Promise<{ config: FRIDAYConfig; agentModelOverride?: string }> {
  if (params.setDefaultModel) {
    const next = params.applyDefaultConfig(params.config);
    if (params.noteDefault) {
      await params.prompter.note(`Default model set to ${params.noteDefault}`, "Model configured");
    }
    return { config: next };
  }

  const next = params.applyProviderConfig(params.config);
  await params.noteAgentModel(params.defaultModel);
  return { config: next, agentModelOverride: params.defaultModel };
}
