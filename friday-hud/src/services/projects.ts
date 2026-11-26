// Real projects (git repos under the home folder) and which one Sir is focused on.

import { useCallback, useEffect, useState } from 'react';
import type { RepoProject } from '../types';

const ACTIVE_KEY = 'friday_active_project';
const listeners = new Set<() => void>();

export function relativeTime(ms: number | null): string {
  if (!ms) return '—';
  const mins = Math.round((Date.now() - ms) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function useProjects() {
  const [projects, setProjects] = useState<RepoProject[] | null>(null);
  const [activePath, setActivePath] = useState<string | null>(() => {
    try {
      return localStorage.getItem(ACTIVE_KEY);
    } catch {
      return null;
    }
  });

  const refresh = useCallback(async () => {
    if (!window.electronAPI?.listProjects) {
      setProjects([]);
      return;
    }
    try {
      setProjects(await window.electronAPI.listProjects());
    } catch {
      setProjects([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(refresh, 120_000);
    const sync = () => {
      try {
        setActivePath(localStorage.getItem(ACTIVE_KEY));
      } catch {}
    };
    listeners.add(sync);
    return () => {
      clearInterval(t);
      listeners.delete(sync);
    };
  }, [refresh]);

  const setActive = useCallback((path: string) => {
    try {
      localStorage.setItem(ACTIVE_KEY, path);
    } catch {}
    listeners.forEach((l) => l());
  }, []);

  // Chosen project if it still exists, else the most recently committed one.
  const active = projects?.find((p) => p.path === activePath) ?? projects?.[0] ?? null;
  return { projects, active, setActive, refresh, loading: projects === null };
}
