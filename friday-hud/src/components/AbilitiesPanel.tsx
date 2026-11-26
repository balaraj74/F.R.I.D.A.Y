import React, { useCallback, useEffect, useState } from 'react';
import { FolderSearch, FolderPlus, GitBranch, Gauge, Layers, Monitor, Plug, Search, Workflow, X } from 'lucide-react';
import { gateway } from '../services/gateway-ws';
import type { AbilitiesStatus } from '../types';

// What FRIDAY can do right now, from the real state of each part (nothing here is decorative),
// with the few controls that are Sir's alone: which folders she reads, and his automations.

type Tone = 'on' | 'off' | 'idle';
const DOT: Record<Tone, string> = { on: 'bg-emerald-400', off: 'bg-rose-400', idle: 'bg-slate-500' };

const PLUGIN_NAMES: Record<string, string> = {
  browser: 'Browser',
  google: 'Google: Calendar, Gmail, Tasks',
  desktop: 'Screen: see and use it',
  thinking: 'Step-by-step thinking',
  docs: 'Library documentation',
  serena: 'Code understanding',
  github: 'GitHub',
};

const Card: React.FC<{ title: string; icon: React.ReactNode; tone: Tone; status: string; children?: React.ReactNode }> = ({
  title,
  icon,
  tone,
  status,
  children,
}) => (
  <section className="p-4 rounded-xl border border-cyan-500/25 bg-slate-900/60 flex flex-col gap-2.5 min-w-0">
    <header className="flex items-center gap-2">
      <span className="text-cyan-300">{icon}</span>
      <h3 className="text-[11px] font-mono tracking-wider text-cyan-400/90">{title}</h3>
      <span className="ml-auto flex items-center gap-1.5 text-[11px] font-mono text-slate-400">
        <span className={`w-1.5 h-1.5 rounded-full ${DOT[tone]}`} />
        {status}
      </span>
    </header>
    {children}
  </section>
);

const Note: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <p className="text-[12px] leading-relaxed text-slate-400">{children}</p>
);

const short = (p: string) => p.replace(/^\/home\/[^/]+/, '~');
const ago = (iso: string | null) => {
  if (!iso) return 'not yet';
  const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
};

export const AbilitiesPanel: React.FC = () => {
  const [s, setS] = useState<AbilitiesStatus | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => setS(await gateway.abilitiesStatus()), []);
  useEffect(() => {
    void load();
    const t = setInterval(() => !document.hidden && void load(), 8000);
    return () => clearInterval(t);
  }, [load]);

  const addFolder = async () => {
    setError('');
    const folder = await window.electronAPI?.pickFolder?.();
    if (!folder) return;
    setBusy(true);
    try {
      await gateway.addFolder(folder);
      await load();
    } catch (e) {
      setError((e as Error).message || 'Could not add that folder.');
    } finally {
      setBusy(false);
    }
  };
  const removeFolder = async (folder: string) => {
    setError('');
    try {
      await gateway.removeFolder(folder);
      await load();
    } catch (e) {
      setError((e as Error).message || 'Could not remove that folder.');
    }
  };

  if (!s) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-slate-400 font-mono">
        {gateway.connected ? 'Reading what I can do…' : 'Start FRIDAY to see what she can do.'}
      </div>
    );
  }

  const up = s.plugins.filter((p) => p.state === 'connected').length;
  const bench = s.benchmark;
  const delta = bench.latest !== null && bench.previous !== null ? Math.round((bench.latest - bench.previous) * 10) / 10 : null;

  return (
    <div className="flex-1 h-full overflow-y-auto hud-scroll p-6">
      <h2 className="text-lg font-hud font-bold text-slate-100">ABILITIES</h2>
      <p className="text-sm text-slate-400 mt-1 mb-5">What I can do for you right now, and what's under your control.</p>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <Card
          title="YOUR FILES"
          icon={<FolderSearch className="w-4 h-4" />}
          tone={s.files.folders.length ? 'on' : 'idle'}
          status={s.files.syncing ? 'indexing…' : s.files.folders.length ? `${s.files.files} files` : 'no folders yet'}
        >
          <Note>
            I search your notes, PDFs (scanned ones too), Word and PowerPoint files and code in the folders you choose, and tell you which file
            and page an answer came from. It all stays on this computer.
          </Note>
          {s.files.folders.length > 0 && (
            <ul className="space-y-1">
              {s.files.folders.map((f) => (
                <li key={f} className="flex items-center gap-2 text-[12px] font-mono text-slate-300 min-w-0">
                  <span className="truncate">{short(f)}</span>
                  <button
                    type="button"
                    onClick={() => void removeFolder(f)}
                    title="Stop reading this folder"
                    className="ml-auto shrink-0 p-0.5 rounded text-slate-500 hover:text-rose-300 cursor-pointer"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => void addFolder()}
              disabled={busy}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-cyan-400/40 bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-200 text-xs font-mono cursor-pointer disabled:opacity-50"
            >
              <FolderPlus className="w-3.5 h-3.5" /> Add a folder
            </button>
            {s.files.chunks > 0 && (
              <span className="text-[11px] font-mono text-slate-500">
                {s.files.chunks.toLocaleString()} passages · updated {ago(s.files.lastSync)}
              </span>
            )}
          </div>
          {error && <p className="text-[12px] text-rose-300">{error}</p>}
        </Card>

        <Card title="YOUR SCREEN" icon={<Monitor className="w-4 h-4" />} tone={s.screen.approved ? 'on' : 'idle'} status={s.screen.approved ? 'allowed' : 'asks first time'}>
          <Note>
            Say “what's this error?” and I'll look at your screen, then click or type if you ask me to. I never look on my own, and I'll ask before
            anything that sends, pays or deletes. GNOME shows a control indicator while I'm using it, with a stop button.
          </Note>
        </Card>

        <Card
          title="BACKGROUND JOBS"
          icon={<Layers className="w-4 h-4" />}
          tone={s.jobs.active ? 'on' : 'idle'}
          status={s.jobs.active ? `${s.jobs.active} working` : 'none running'}
        >
          <Note>Big tasks (a report, research, slides) I plan, work through step by step, check, and message you about when done.</Note>
          {s.jobs.recent.length > 0 && (
            <ul className="space-y-1">
              {s.jobs.recent.map((j) => (
                <li key={j.id} className="flex items-center gap-2 text-[12px] text-slate-300 min-w-0">
                  <span className="truncate">{j.title}</span>
                  <span className="ml-auto shrink-0 font-mono text-[11px] text-slate-500">
                    {j.status === 'running' || j.status === 'planning' ? `${j.done}/${j.total || '?'}` : j.status}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card
          title="CODE PARTNER"
          icon={<GitBranch className="w-4 h-4" />}
          tone={s.code.length ? 'on' : 'idle'}
          status={s.code.length ? `${s.code.length} open` : 'no open tasks'}
        >
          <Note>
            I work on your projects in a separate copy on my own branch, run the tests and show you the changes. I merge only when you say so,
            and never push.
          </Note>
          {s.code.map((t) => (
            <p key={t.id} className="text-[12px] text-slate-300 truncate">
              <span className="font-mono text-cyan-300">{t.branch}</span> · {t.repo}: {t.task}
            </p>
          ))}
        </Card>

        <Card title="AUTOMATIONS" icon={<Workflow className="w-4 h-4" />} tone={s.automations.up ? 'on' : 'off'} status={s.automations.up ? 'online' : 'offline'}>
          <Note>Your own “when this happens, do that” workflows (n8n). I can run them for you; you build them in the editor.</Note>
          <div>
            <button
              type="button"
              onClick={() => void window.electronAPI?.openAutomationEditor?.()}
              disabled={!s.automations.up || !window.electronAPI?.openAutomationEditor}
              className="px-3 py-1.5 rounded-lg border border-cyan-400/40 bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-200 text-xs font-mono cursor-pointer disabled:opacity-40"
            >
              Open the editor
            </button>
          </div>
        </Card>

        <Card title="PRIVATE SEARCH" icon={<Search className="w-4 h-4" />} tone={s.search.up ? 'on' : 'off'} status={s.search.up ? 'online' : 'offline'}>
          <Note>
            Web searches go through a search engine running on this computer that combines several sources, so they're more reliable and
            more private. If it's offline I fall back to a single source.
          </Note>
        </Card>

        <Card title="BENCHMARK" icon={<Gauge className="w-4 h-4" />} tone={bench.latest !== null ? 'on' : 'idle'} status={bench.latest !== null ? `${bench.latest}/10` : 'not measured yet'}>
          <Note>
            My score on 30 fixed tasks (personality, how I sound, reasoning, tools, safety, honesty). A change to how I behave is kept only if
            this doesn't drop.
            {delta !== null && delta !== 0 && (
              <span className={delta > 0 ? ' text-emerald-300' : ' text-rose-300'}>
                {' '}
                {delta > 0 ? '▲' : '▼'} {Math.abs(delta)} since last time.
              </span>
            )}
          </Note>
        </Card>

        <Card title="PLUGINS" icon={<Plug className="w-4 h-4" />} tone={up === s.plugins.length ? 'on' : 'off'} status={`${up}/${s.plugins.length} connected`}>
          <ul className="space-y-1">
            {s.plugins.map((p) => (
              <li key={p.name} className="flex items-center gap-2 text-[12px] text-slate-300 min-w-0">
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${p.state === 'connected' ? DOT.on : p.state === 'connecting' ? DOT.idle : DOT.off}`} />
                <span className="truncate">{PLUGIN_NAMES[p.name] ?? p.name}</span>
                <span className="ml-auto shrink-0 font-mono text-[11px] text-slate-500">
                  {p.state === 'connected' ? `${p.tools} tool${p.tools === 1 ? '' : 's'}` : p.state}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </div>
  );
};
