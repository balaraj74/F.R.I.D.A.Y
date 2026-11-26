import type { SystemStats } from '../types';

/** Shown until (or whenever) real stats can't be read: unknown, not invented. */
export const EMPTY_STATS: SystemStats = {
  cpu: null,
  ram: null,
  disk: null,
  gpu: null,
  battery: null,
  uptime: 0,
  platform: '',
  hostname: '',
  loadAvg: 0,
};



export async function fetchSystemStats(): Promise<SystemStats> {
  // If running inside Electron, invoke the IPC directly
  if (window.electronAPI?.getSystemStats) {
    try {
      return await window.electronAPI.getSystemStats();
    } catch (e) {
      console.warn('IPC stats failed, falling back to fetch', e);
    }
  }

  // Otherwise fetch from Vite dev server embedded API
  try {
    const res = await fetch('/api/system-stats');
    if (res.ok) {
      return await res.json();
    }
  } catch (err) {
    // stats unavailable
  }

  return EMPTY_STATS;
}

