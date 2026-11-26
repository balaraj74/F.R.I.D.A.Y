import React, { useEffect, useState } from 'react';
import { Dna } from 'lucide-react';
import { gateway } from '../services/gateway-ws';

// Real generation count; shows what's waiting for Sir. Hidden until FRIDAY is reachable.
export const EvolutionBadge: React.FC<{ currentSize?: 'compact' | 'medium' | 'full'; onOpenEvolution?: () => void }> = ({
  currentSize = 'full',
  onOpenEvolution,
}) => {
  const [info, setInfo] = useState<{ generation: number; pending: number } | null>(null);

  useEffect(() => {
    const load = async () => {
      try {
        const s = await gateway.request<{ generation: number; proposals: { status: string }[] }>('evolution.status', {});
        setInfo({ generation: s.generation, pending: s.proposals.filter((p) => p.status === 'pending').length });
      } catch {
        setInfo(null);
      }
    };
    void load();
    const t = setInterval(load, 60_000);
    const unsub = gateway.onEvolution(() => void load());
    const unsubStatus = gateway.onStatus((ok) => ok && void load());
    return () => {
      clearInterval(t);
      unsub();
      unsubStatus();
    };
  }, []);

  if (!info || currentSize === 'compact') return null;
  return (
    <button
      type="button"
      onClick={onOpenEvolution}
      className="flex items-center gap-2 px-2.5 py-1 rounded-full border border-cyan-500/30 bg-slate-900/60 text-[10px] font-mono text-cyan-200 cursor-pointer hover:border-cyan-300/60"
    >
      <Dna className="w-3 h-3" />
      GEN {info.generation}
      {info.pending > 0 && <span className="px-1.5 rounded-full bg-amber-400/20 text-amber-200">{info.pending} to review</span>}
    </button>
  );
};
