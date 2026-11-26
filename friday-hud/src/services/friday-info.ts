// FRIDAY's public identity for the UI: name + version, never the underlying model/provider.

import { useEffect, useState } from 'react';
import { versionBadge } from './weather';

export interface FridayInfo {
  /** e.g. "v2026.1.27 β"; empty until known (browser dev without Electron). */
  version: string;
  /** Agent workspace folder from ~/.friday/friday.json. */
  workspaceDir: string;
}

let cached: FridayInfo | null = null;
let pending: Promise<FridayInfo> | null = null;

function load(): Promise<FridayInfo> {
  pending ??= (async () => {
    try {
      const info = await window.electronAPI?.getGatewayInfo?.();
      cached = {
        version: info?.version ? versionBadge(info.version) : '',
        workspaceDir: typeof info?.workspaceDir === 'string' ? info.workspaceDir : '',
      };
    } catch {
      cached = { version: '', workspaceDir: '' };
    }
    return cached;
  })();
  return pending;
}

export function useFridayInfo(): FridayInfo {
  const [info, setInfo] = useState<FridayInfo>(cached ?? { version: '', workspaceDir: '' });
  useEffect(() => {
    let alive = true;
    void load().then((i) => alive && setInfo(i));
    return () => {
      alive = false;
    };
  }, []);
  return info;
}

/** "FRIDAY v2026.1.27 β", or just "FRIDAY" when the version isn't known. */
export const fridayLabel = (info: FridayInfo) => (info.version ? `FRIDAY ${info.version}` : 'FRIDAY');
