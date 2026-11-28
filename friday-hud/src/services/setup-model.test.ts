import { describe, expect, it } from 'vitest';
import {
  BRAIN_OPTIONS,
  applyEvent,
  canAdvance,
  failedStep,
  formatDownload,
  initialInstallView,
  nextStep,
  prevStep,
  resumeScreen,
  type SetupChoices,
} from './setup-model';

const choices = (over: Partial<SetupChoices> = {}): SetupChoices => ({
  name: 'Ana',
  address: 'Boss',
  brain: 'antigravity',
  voice: { tts: 'edge' },
  background: true,
  quickbar: true,
  computerControl: { consented: false },
  ...over,
});
const plan = [
  { id: 'config', label: 'Config', required: true },
  { id: 'voice-stt', label: 'Voice', required: false },
];

describe('setup wizard model', () => {
  it('enables only Antigravity; every other brain is Coming soon', () => {
    expect(BRAIN_OPTIONS.filter((b) => b.enabled).map((b) => b.id)).toEqual(['antigravity']);
    expect(BRAIN_OPTIONS.length).toBeGreaterThan(3);
  });
  it('needs a name on Welcome but never blocks Brain', () => {
    expect(canAdvance('welcome', choices({ name: '  ' }))).toBe(false);
    expect(canAdvance('welcome', choices())).toBe(true);
    expect(canAdvance('brain', choices())).toBe(true);
  });
  it('moves through the steps and stops at the ends', () => {
    expect(nextStep('welcome')).toBe('brain');
    expect(nextStep('done')).toBe('done');
    expect(prevStep('welcome')).toBe('welcome');
  });
  it('resumes on the install screen when a step is incomplete', () => {
    expect(resumeScreen('voice-stt')).toBe('install');
    expect(resumeScreen(null)).toBe('welcome');
  });
  it('tracks progress, failure, retry and completion', () => {
    let v = initialInstallView(plan, { config: 'done' });
    expect(v.statuses).toEqual({ config: 'done', 'voice-stt': 'pending' });
    v = applyEvent(v, { type: 'step', id: 'voice-stt', status: 'running' });
    v = applyEvent(v, { type: 'progress', id: 'voice-stt', percent: 40, message: 'Downloading' });
    expect(v.percent['voice-stt']).toBe(40);
    v = applyEvent(v, { type: 'step', id: 'voice-stt', status: 'failed', error: 'offline' });
    expect(failedStep(v, plan)?.id).toBe('voice-stt');
    expect(v.errors['voice-stt']).toBe('offline');
    v = applyEvent(v, { type: 'step', id: 'voice-stt', status: 'running' });
    expect(v.errors['voice-stt']).toBeUndefined();
    v = applyEvent(v, { type: 'step', id: 'voice-stt', status: 'done' });
    v = applyEvent(v, { type: 'complete' });
    expect(v.complete).toBe(true);
  });
  it('formats download sizes', () => {
    expect(formatDownload(150)).toBe('150 MB');
    expect(formatDownload(2500)).toBe('2.5 GB');
  });
});
