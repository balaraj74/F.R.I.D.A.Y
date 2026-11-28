// Pure logic behind the setup wizard (no React, no Electron) so it can be unit-tested.

export type WizardStepId = 'welcome' | 'brain' | 'voice' | 'control' | 'install' | 'done';
export const WIZARD_STEPS: { id: WizardStepId; label: string }[] = [
  { id: 'welcome', label: 'Welcome' },
  { id: 'brain', label: 'Brain' },
  { id: 'voice', label: 'Voice' },
  { id: 'control', label: 'Control' },
  { id: 'install', label: 'Install' },
  { id: 'done', label: 'Done' },
];

export type TtsChoice = 'edge' | 'supertonic-gpu' | 'none';

export interface SetupChoices {
  name: string;
  address: string;
  brain: 'antigravity';
  voice: { tts: TtsChoice; stt?: string };
  background: boolean;
  quickbar: boolean;
  computerControl: { consented: boolean };
}

export interface PlanStep {
  id: string;
  label: string;
  required: boolean;
  downloadMB?: number;
}

export type StepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export interface SetupEvent {
  type: 'step' | 'progress' | 'complete' | 'error';
  id?: string;
  status?: StepStatus;
  error?: string;
  percent?: number;
  message?: string;
  completedAt?: string;
}

export interface BrainOption {
  id: string;
  label: string;
  hint: string;
  enabled: boolean;
}

/**
 * Every provider is listed so the choice is visible, but only Antigravity works today. Turning one
 * on later means flipping `enabled` here; the install steps do not change. No API-key fields exist.
 */
export const BRAIN_OPTIONS: BrainOption[] = [
  { id: 'antigravity', label: 'Antigravity', hint: 'Default. Sign in with your Google account.', enabled: true },
  { id: 'openai', label: 'OpenAI', hint: 'Hosted models', enabled: false },
  { id: 'anthropic', label: 'Anthropic', hint: 'Hosted models', enabled: false },
  { id: 'gemini', label: 'Google Gemini', hint: 'Hosted models', enabled: false },
  { id: 'openrouter', label: 'OpenRouter', hint: 'Many models, one account', enabled: false },
  { id: 'ollama', label: 'Ollama', hint: 'Local model on this PC', enabled: false },
  { id: 'lmstudio', label: 'LM Studio', hint: 'Local model on this PC', enabled: false },
];

export interface VoiceOption {
  id: TtsChoice;
  label: string;
  hint: string;
}

export function voiceHint(id: TtsChoice, gpuName?: string): string {
  if (id === 'supertonic-gpu') return `Expressive voice on your GPU${gpuName ? ` (${gpuName})` : ''}. Works offline.`;
  if (id === 'edge') return 'Microsoft Edge neural voice. Needs an internet connection.';
  return 'FRIDAY stays silent. Typing still works.';
}

export function nextStep(id: WizardStepId): WizardStepId {
  const i = WIZARD_STEPS.findIndex((s) => s.id === id);
  return WIZARD_STEPS[Math.min(WIZARD_STEPS.length - 1, i + 1)].id;
}

export function prevStep(id: WizardStepId): WizardStepId {
  const i = WIZARD_STEPS.findIndex((s) => s.id === id);
  return WIZARD_STEPS[Math.max(0, i - 1)].id;
}

/** Whether Continue is enabled. The Brain step never blocks: sign-in can be done later. */
export function canAdvance(step: WizardStepId, choices: SetupChoices): boolean {
  if (step === 'welcome') return choices.name.trim().length > 0;
  return step !== 'install' && step !== 'done';
}

/** The wizard screen to reopen on: install steps are resumed on the Install screen. */
export function resumeScreen(firstIncomplete: string | null): WizardStepId {
  return firstIncomplete ? 'install' : 'welcome';
}

export interface InstallView {
  statuses: Record<string, StepStatus>;
  percent: Record<string, number>;
  message: Record<string, string>;
  errors: Record<string, string>;
  complete: boolean;
}

export function initialInstallView(plan: PlanStep[], done: Record<string, StepStatus> = {}): InstallView {
  const statuses: Record<string, StepStatus> = {};
  for (const s of plan) statuses[s.id] = done[s.id] === 'done' || done[s.id] === 'skipped' ? done[s.id] : 'pending';
  return { statuses, percent: {}, message: {}, errors: {}, complete: false };
}

export function applyEvent(view: InstallView, e: SetupEvent): InstallView {
  const next: InstallView = {
    statuses: { ...view.statuses },
    percent: { ...view.percent },
    message: { ...view.message },
    errors: { ...view.errors },
    complete: view.complete,
  };
  if (e.type === 'step' && e.id && e.status) {
    next.statuses[e.id] = e.status;
    if (e.status === 'failed') next.errors[e.id] = e.error || 'Step failed';
    if (e.status === 'running') delete next.errors[e.id];
    if (e.status === 'done') next.percent[e.id] = 100;
  } else if (e.type === 'progress' && e.id) {
    if (typeof e.percent === 'number') next.percent[e.id] = e.percent;
    if (e.message) next.message[e.id] = e.message;
  } else if (e.type === 'complete') {
    next.complete = true;
  }
  return next;
}

/** First failed step, if the run is stopped on one. */
export function failedStep(view: InstallView, plan: PlanStep[]): PlanStep | null {
  for (const s of plan) if (view.statuses[s.id] === 'failed') return s;
  return null;
}

export function formatDownload(mb: number): string {
  return mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}
