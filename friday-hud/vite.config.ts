import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import os from 'node:os';
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { resolveGeneratedMedia, getMediaMime } = require('./electron/media-access.cjs');

let lastCpuIdle = 0;
let lastCpuTotal = 0;

function readCpuTimes() {
  try {
    const stat = fs.readFileSync('/proc/stat', 'utf8');
    const firstLine = stat.split('\n')[0];
    const parts = firstLine.trim().split(/\s+/).slice(1).map(Number);
    const idle = parts[3] + (parts[4] || 0);
    const total = parts.reduce((acc, v) => acc + v, 0);
    return { idle, total };
  } catch (e) {
    return { idle: 0, total: 100 };
  }
}

const initialTimes = readCpuTimes();
lastCpuIdle = initialTimes.idle;
lastCpuTotal = initialTimes.total;

function getCpuPercent() {
  const current = readCpuTimes();
  const idleDiff = current.idle - lastCpuIdle;
  const totalDiff = current.total - lastCpuTotal;
  lastCpuIdle = current.idle;
  lastCpuTotal = current.total;
  if (totalDiff <= 0) return null;
  const usage = Math.round((1 - idleDiff / totalDiff) * 100);
  return Math.max(0, Math.min(100, usage));
}

function systemStatsPlugin() {
  return {
    name: 'system-stats-api',
    configureServer(server) {
      server.middlewares.use('/api/system-stats', (req, res) => {
        const cpu = getCpuPercent();
        let ram: number | null = null;
        try {
          const mem = fs.readFileSync('/proc/meminfo', 'utf8');
          const total = Number(/MemTotal:\s+(\d+)/.exec(mem)?.[1]);
          const avail = Number(/MemAvailable:\s+(\d+)/.exec(mem)?.[1]);
          if (total) ram = Math.round(((total - avail) / total) * 100);
        } catch (err) {}

        // Unknown values stay null (shown as "—"); never invent numbers.
        let disk: number | null = null;
        try {
          const dfOut = execSync("df / -h --output=pcent | tail -n 1", { encoding: 'utf8' }).trim();
          const d = parseInt(dfOut.replace('%', ''), 10);
          disk = Number.isFinite(d) ? d : null;
        } catch (err) {}

        let gpu: number | null = null;
        try {
          const nvOut = execSync("nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader,nounits 2>/dev/null", { encoding: 'utf8' }).trim();
          const g = parseInt(nvOut, 10);
          gpu = Number.isFinite(g) ? g : null;
        } catch (err) {}

        let battery: number | null = null;
        try {
          const batPath = '/sys/class/power_supply/BAT0/capacity';
          if (fs.existsSync(batPath)) {
            const b = parseInt(fs.readFileSync(batPath, 'utf8').trim(), 10);
            battery = Number.isFinite(b) ? b : null;
          }
        } catch (err) {}

        const stats = {
          cpu,
          ram,
          disk,
          gpu,
          battery,
          uptime: Math.floor(os.uptime()),
          platform: 'Linux',
          hostname: os.hostname(),
          loadAvg: Number(os.loadavg()[0].toFixed(2))
        };

        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(stats));
      });
    }
  };
}

function handleMediaRequest(req: any, res: any) {
  try {
    const url = new URL(req.url || '', 'http://localhost');
    const filePath = url.searchParams.get('path') || '';
    const real = resolveGeneratedMedia(filePath);
    const mime = getMediaMime(real) || 'application/octet-stream';
    const stat = fs.statSync(real);
    const total = stat.size;
    const range = req.headers?.range;

    res.setHeader('Content-Type', mime);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'private, max-age=3600');

    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(String(range));
      if (match) {
        const start = match[1] ? parseInt(match[1], 10) : 0;
        const end = match[2] ? Math.min(parseInt(match[2], 10), total - 1) : total - 1;
        if (start >= total || start > end) {
          res.statusCode = 416;
          res.setHeader('Content-Range', `bytes */${total}`);
          res.end();
          return;
        }
        res.statusCode = 206;
        res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
        res.setHeader('Content-Length', String(end - start + 1));
        fs.createReadStream(real, { start, end }).pipe(res);
        return;
      }
    }

    res.statusCode = 200;
    res.setHeader('Content-Length', String(total));
    fs.createReadStream(real).pipe(res);
  } catch (err: any) {
    res.statusCode = 403;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: String(err?.message || err) }));
  }
}

function mediaApiPlugin() {
  return {
    name: 'friday-media-api',
    configureServer(server: any) {
      server.middlewares.use('/api/media', handleMediaRequest);
    },
    configurePreviewServer(server: any) {
      server.middlewares.use('/api/media', handleMediaRequest);
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [react(), systemStatsPlugin(), mediaApiPlugin()],
  server: {
    port: 18790,
    host: true,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  }
});
