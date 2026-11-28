import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, Loader2, AlertTriangle, Circle, MinusCircle } from 'lucide-react';
import {
  BRAIN_OPTIONS,
  WIZARD_STEPS,
  applyEvent,
  canAdvance,
  failedStep,
  formatDownload,
  initialInstallView,
  nextStep,
  prevStep,
  resumeScreen,
  voiceHint,
  type InstallView,
  type PlanStep,
  type SetupChoices,
  type SetupEvent,
  type TtsChoice,
  type WizardStepId,
} from '../services/setup-model';

interface SetupStatus {
  needed: boolean;
  platform: string;
  gpu: { nvidia: boolean; name?: string };
  voiceOptions: { id: TtsChoice; label: string; needsInternet: boolean }[];
  defaults: SetupChoices;
  state: { steps?: Record<string, 'pending' | 'running' | 'done' | 'failed' | 'skipped'> } | null;
  resume: { choices: SetupChoices; plan: PlanStep[]; firstIncomplete: string | null } | null;
}

interface FridaySetupApi {
  status: () => Promise<SetupStatus>;
  plan: (c: SetupChoices) => Promise<{ plan: PlanStep[]; totalMB: number }>;
  start: (c: SetupChoices) => Promise<{ plan: PlanStep[] }>;
  retry: (id: string) => Promise<unknown>;
  skip: (id: string) => Promise<unknown>;
  cancel: () => Promise<unknown>;
  signIn: () => Promise<{ ok: boolean; error?: string }>;
  openLog: () => Promise<unknown>;
  onEvent: (cb: (e: SetupEvent) => void) => () => void;
}

declare global {
  interface Window {
    fridaySetup?: FridaySetupApi;
  }
}

const btn =
  'px-5 py-2 text-sm font-semibold tracking-wide border transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 disabled:opacity-40 disabled:cursor-not-allowed';
const primary = `${btn} bg-cyan-400 text-slate-950 border-cyan-300 hover:bg-cyan-300`;
const ghost = `${btn} bg-transparent text-cyan-100 border-cyan-400/50 hover:bg-cyan-400/10`;

/** Shows the wizard when the main process says setup is needed, otherwise the app. */
export const SetupGate: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const api = window.fridaySetup;
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [closed, setClosed] = useState(false);
  const [checked, setChecked] = useState(!api);
  useEffect(() => {
    if (!api) return;
    api
      .status()
      .then((s) => setStatus(s))
      .catch(() => undefined)
      .finally(() => setChecked(true));
  }, [api]);
  if (!checked) return <div className="fixed inset-0 bg-[#030712]" />;
  if (api && status?.needed && !closed) return <SetupWizard api={api} status={status} onFinished={() => setClosed(true)} />;
  return <>{children}</>;
};

const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <label className="block mb-4">
    <span className="block text-xs uppercase tracking-[0.2em] text-cyan-200 mb-1 font-mono">{label}</span>
    {children}
  </label>
);

const inputCls =
  'w-full bg-slate-950/70 border border-cyan-400/40 px-3 py-2 text-slate-100 text-base focus:outline-none focus:border-cyan-300 focus-visible:ring-2 focus-visible:ring-cyan-300';

const Toggle: React.FC<{ checked: boolean; onChange: (v: boolean) => void; title: string; hint: string }> = ({ checked, onChange, title, hint }) => (
  <label className="flex items-start gap-3 py-2 cursor-pointer">
    <input type="checkbox" className="mt-1 h-4 w-4 accent-cyan-400" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    <span>
      <span className="block text-slate-100 font-semibold">{title}</span>
      <span className="block text-sm text-slate-300">{hint}</span>
    </span>
  </label>
);

const SetupWizard: React.FC<{ api: FridaySetupApi; status: SetupStatus; onFinished: () => void }> = ({ api, status, onFinished }) => {
  const resume = status.resume;
  const [screen, setScreen] = useState<WizardStepId>(resume ? resumeScreen(resume.firstIncomplete) : 'welcome');
  const [choices, setChoices] = useState<SetupChoices>(resume ? resume.choices : status.defaults);
  const [plan, setPlan] = useState<PlanStep[]>(resume ? resume.plan : []);
  const [totalMB, setTotalMB] = useState(0);
  const [view, setView] = useState<InstallView>(() => initialInstallView(resume ? resume.plan : [], status.state?.steps));
  const [signIn, setSignIn] = useState<'idle' | 'waiting' | 'ok' | 'failed'>('idle');
  const [signInError, setSignInError] = useState('');
  const [running, setRunning] = useState(false);

  const update = useCallback((patch: Partial<SetupChoices>) => setChoices((c) => ({ ...c, ...patch })), []);

  useEffect(() => api.onEvent((e) => setView((v) => applyEvent(v, e))), [api]);

  // Recompute the plan (and download size) whenever choices change, so the Voice and Install screens agree.
  useEffect(() => {
    if (screen === 'install' || screen === 'done') return;
    let alive = true;
    api.plan(choices).then((r) => {
      if (!alive) return;
      setPlan(r.plan);
      setTotalMB(r.totalMB);
    });
    return () => {
      alive = false;
    };
  }, [api, choices, screen]);

  const begin = useCallback(async () => {
    setRunning(true);
    const r = await api.start(choices);
    setPlan(r.plan);
    setView(initialInstallView(r.plan, status.state?.steps));
  }, [api, choices, status.state]);

  // A resumed run restarts on its own; a fresh one starts when the Install screen opens.
  useEffect(() => {
    if (screen === 'install' && !running) void begin();
  }, [screen, running, begin]);
  useEffect(() => {
    if (view.complete) setScreen('done');
  }, [view.complete]);

  const startSignIn = async () => {
    setSignIn('waiting');
    setSignInError('');
    const r = await api.signIn();
    setSignIn(r.ok ? 'ok' : 'failed');
    if (!r.ok) setSignInError(r.error || 'Sign-in did not finish.');
  };

  const failed = failedStep(view, plan);
  const voiceMB = useMemo(() => plan.reduce((n, s) => n + (s.downloadMB || 0), 0) || totalMB, [plan, totalMB]);

  return (
    <div className="fixed inset-0 bg-[#030712] text-slate-100 flex" role="dialog" aria-modal="true" aria-label="FRIDAY setup">
      <nav aria-label="Setup steps" className="w-56 shrink-0 border-r border-cyan-400/25 p-6 flex flex-col gap-1">
        <div className="font-hud text-cyan-300 tracking-[0.3em] text-lg mb-8">FRIDAY</div>
        {WIZARD_STEPS.map((s, i) => {
          const here = s.id === screen;
          return (
            <div
              key={s.id}
              aria-current={here ? 'step' : undefined}
              className={`flex items-center gap-3 py-2 text-sm font-mono ${here ? 'text-cyan-200' : 'text-slate-400'}`}
            >
              <span className={`w-6 h-6 grid place-items-center border text-xs ${here ? 'border-cyan-300 bg-cyan-400/15' : 'border-slate-600'}`}>{i + 1}</span>
              {s.label}
            </div>
          );
        })}
      </nav>

      <main className="flex-1 overflow-y-auto p-10 max-w-3xl">
        {screen === 'welcome' && (
          <section aria-labelledby="h-welcome">
            <h1 id="h-welcome" className="font-hud text-2xl text-cyan-200 mb-2">Set up FRIDAY</h1>
            <p className="text-slate-300 mb-8">A few questions, then she installs what you picked. Nothing leaves this PC except what the brain and the voice you choose need.</p>
            <Field label="Your name">
              <input className={inputCls} value={choices.name} onChange={(e) => update({ name: e.target.value })} autoFocus autoComplete="off" />
            </Field>
            <Field label="What should she call you?">
              <input className={inputCls} value={choices.address} onChange={(e) => update({ address: e.target.value })} autoComplete="off" />
            </Field>
          </section>
        )}

        {screen === 'brain' && (
          <section aria-labelledby="h-brain">
            <h1 id="h-brain" className="font-hud text-2xl text-cyan-200 mb-2">Brain</h1>
            <p className="text-slate-300 mb-6">Antigravity is the only brain available for now. The others are on their way.</p>
            <div role="radiogroup" aria-label="Brain" className="grid gap-2">
              {BRAIN_OPTIONS.map((b) => (
                <button
                  key={b.id}
                  type="button"
                  role="radio"
                  aria-checked={b.enabled && choices.brain === b.id}
                  aria-disabled={!b.enabled}
                  disabled={!b.enabled}
                  onClick={() => b.enabled && update({ brain: 'antigravity' })}
                  className={`flex items-center justify-between text-left border px-4 py-3 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 ${
                    b.enabled ? 'border-cyan-300 bg-cyan-400/10' : 'border-slate-700 text-slate-400 cursor-not-allowed'
                  }`}
                >
                  <span>
                    <span className={`block font-semibold ${b.enabled ? 'text-slate-100' : 'text-slate-300'}`}>{b.label}</span>
                    <span className="block text-sm text-slate-300">{b.hint}</span>
                  </span>
                  {!b.enabled && <span className="text-[11px] font-mono uppercase tracking-widest border border-amber-300/60 text-amber-200 px-2 py-0.5">Coming soon</span>}
                </button>
              ))}
            </div>
            <div className="mt-6 border border-cyan-400/30 p-4">
              <div className="flex items-center gap-3">
                <button type="button" className={ghost} onClick={startSignIn} disabled={signIn === 'waiting'}>
                  {signIn === 'ok' ? 'Sign in again' : 'Sign in with Google'}
                </button>
                <span role="status" className="text-sm text-slate-200">
                  {signIn === 'idle' && 'Opens your browser. You can also do this later.'}
                  {signIn === 'waiting' && 'Finish signing in in your browser...'}
                  {signIn === 'ok' && 'Signed in.'}
                  {signIn === 'failed' && `Not signed in. ${signInError}`}
                </span>
              </div>
            </div>
          </section>
        )}

        {screen === 'voice' && (
          <section aria-labelledby="h-voice">
            <h1 id="h-voice" className="font-hud text-2xl text-cyan-200 mb-2">Voice</h1>
            <p className="text-slate-300 mb-6">
              {status.gpu.nvidia ? `NVIDIA GPU found${status.gpu.name ? `: ${status.gpu.name}` : ''}.` : 'No NVIDIA GPU found, so the Edge voice is preselected. It needs an internet connection.'}
            </p>
            <div role="radiogroup" aria-label="Voice" className="grid gap-2">
              {status.voiceOptions.map((v) => {
                const on = choices.voice.tts === v.id;
                return (
                  <button
                    key={v.id}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => update({ voice: v.id === 'none' ? { tts: 'none' } : { tts: v.id, stt: status.gpu.nvidia ? 'whisper-gpu' : 'whisper-cpu' } })}
                    className={`text-left border px-4 py-3 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300 ${on ? 'border-cyan-300 bg-cyan-400/10' : 'border-slate-700 hover:border-cyan-400/60'}`}
                  >
                    <span className="block font-semibold text-slate-100">{v.label}</span>
                    <span className="block text-sm text-slate-300">{voiceHint(v.id, status.gpu.name)}</span>
                  </button>
                );
              })}
            </div>
            {choices.voice.tts !== 'none' && (
              <p className="mt-4 text-sm text-slate-200">
                Speech to text runs on this PC (Whisper). Download size: about {formatDownload(voiceMB)}. You can cancel the download on the Install screen.
              </p>
            )}
          </section>
        )}

        {screen === 'control' && (
          <section aria-labelledby="h-control">
            <h1 id="h-control" className="font-hud text-2xl text-cyan-200 mb-4">Running and control</h1>
            <Toggle checked={choices.background} onChange={(v) => update({ background: v })} title="Keep FRIDAY running in the background" hint="The engine starts when you sign in to Windows and keeps running when the HUD is closed." />
            <Toggle checked={choices.quickbar} onChange={(v) => update({ quickbar: v })} title="Quick bar" hint="Shake the mouse or press Ctrl+Alt+Space to ask about what is on your screen." />
            <div className="mt-6 border border-amber-300/50 p-4">
              <h2 className="font-semibold text-amber-200 mb-2">Computer control</h2>
              <p className="text-slate-200 text-sm mb-3">
                If you allow this, FRIDAY can see your screen and operate the mouse and keyboard when you ask her to. A red indicator shows while she does, and Ctrl+Alt+Backspace stops her at once. She asks before sending, paying, deleting or posting, and never types passwords.
              </p>
              <Toggle checked={choices.computerControl.consented} onChange={(v) => update({ computerControl: { consented: v } })} title="Yes, allow FRIDAY to see and control my screen" hint="Off by default. You can change this later." />
            </div>
          </section>
        )}

        {screen === 'install' && (
          <section aria-labelledby="h-install">
            <h1 id="h-install" className="font-hud text-2xl text-cyan-200 mb-4">Installing</h1>
            <ul className="grid gap-2" aria-live="polite">
              {plan.map((s) => {
                const st = view.statuses[s.id] || 'pending';
                const pct = view.percent[s.id];
                return (
                  <li key={s.id} className="border border-slate-700 px-4 py-3">
                    <div className="flex items-center gap-3">
                      {st === 'done' && <Check className="w-4 h-4 text-emerald-300" aria-label="done" />}
                      {st === 'running' && <Loader2 className="w-4 h-4 text-cyan-300 animate-spin" aria-label="running" />}
                      {st === 'failed' && <AlertTriangle className="w-4 h-4 text-red-300" aria-label="failed" />}
                      {st === 'pending' && <Circle className="w-4 h-4 text-slate-500" aria-label="waiting" />}
                      {st === 'skipped' && <MinusCircle className="w-4 h-4 text-slate-400" aria-label="skipped" />}
                      <span className="flex-1 text-slate-100">{s.label}</span>
                      {s.downloadMB ? <span className="text-xs font-mono text-slate-300">{formatDownload(s.downloadMB)}</span> : null}
                    </div>
                    {st === 'running' && (
                      <div className="mt-2">
                        <div className="h-1 bg-slate-800" role="progressbar" aria-valuenow={pct ?? 0} aria-valuemin={0} aria-valuemax={100}>
                          <div className="h-1 bg-cyan-300" style={{ width: `${pct ?? 5}%` }} />
                        </div>
                        {view.message[s.id] && <div className="text-xs text-slate-300 mt-1">{view.message[s.id]}</div>}
                      </div>
                    )}
                    {st === 'failed' && <div className="mt-2 text-sm text-red-200">{view.errors[s.id]}</div>}
                  </li>
                );
              })}
            </ul>
            <div className="mt-5 flex gap-3">
              {failed && (
                <>
                  <button type="button" className={primary} onClick={() => api.retry(failed.id)}>Retry</button>
                  {!failed.required && <button type="button" className={ghost} onClick={() => api.skip(failed.id)}>Skip</button>}
                </>
              )}
              {!failed && !view.complete && <button type="button" className={ghost} onClick={() => api.cancel()}>Cancel</button>}
              <button type="button" className={ghost} onClick={() => api.openLog()}>Open log folder</button>
            </div>
            {failed && failed.required && <p className="mt-3 text-sm text-amber-200">Setup cannot finish until this step works.</p>}
          </section>
        )}

        {screen === 'done' && (
          <section aria-labelledby="h-done">
            <h1 id="h-done" className="font-hud text-2xl text-cyan-200 mb-2">FRIDAY is ready</h1>
            <p className="text-slate-300 mb-3">
              {choices.background ? 'The engine is running in the background.' : 'The engine starts when you open the HUD.'}
              {choices.quickbar ? ' Shake the mouse or press Ctrl+Alt+Space for the quick bar.' : ''}
            </p>
            {signIn !== 'ok' && (
              <p className="text-amber-200 text-sm mb-3">
                The brain is not signed in yet.{' '}
                <button type="button" className="underline focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300" onClick={startSignIn}>
                  Sign in with Google
                </button>
                {signIn === 'waiting' && ' (waiting for your browser)'}
              </p>
            )}
            <button type="button" className={primary} onClick={onFinished}>Open FRIDAY</button>
          </section>
        )}

        {screen !== 'install' && screen !== 'done' && (
          <div className="mt-10 flex gap-3">
            {screen !== 'welcome' && <button type="button" className={ghost} onClick={() => setScreen(prevStep(screen))}>Back</button>}
            <button type="button" className={primary} disabled={!canAdvance(screen, choices)} onClick={() => setScreen(nextStep(screen))}>
              {screen === 'control' ? 'Install' : 'Continue'}
            </button>
          </div>
        )}
      </main>
    </div>
  );
};

export default SetupWizard;
