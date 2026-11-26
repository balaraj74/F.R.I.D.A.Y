// FRIDAY's helper services in Docker: SearXNG (private web search) and n8n (automations).
// Started with INITIALIZE and stopped when the app closes, like everything else: --rm and no
// restart policy, so they can never come back on their own at login. Bound to 127.0.0.1 only.
// Images are pinned by digest so an update is a deliberate change here, not a surprise.

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = os.homedir();
const CONTAINERS = [
  {
    name: 'friday-searxng',
    needs: path.join(HOME, '.friday', 'searxng', 'settings.yml'),
    args: [
      '-p', '127.0.0.1:18960:8080',
      '-v', `${path.join(HOME, '.friday', 'searxng', 'settings.yml')}:/etc/searxng/settings.yml:ro`,
      'searxng/searxng@sha256:606fc8852a53f0be4ac05116950ff480f6f56b8ef7d77b366868cc76478036e5',
    ],
  },
  {
    name: 'friday-n8n',
    needs: path.join(HOME, '.friday', 'n8n'),
    args: [
      '-p', '127.0.0.1:18961:5678',
      '-v', `${path.join(HOME, '.friday', 'n8n')}:/home/node/.n8n`,
      '-e', 'GENERIC_TIMEZONE=Asia/Kolkata', '-e', 'TZ=Asia/Kolkata',
      '-e', 'N8N_DIAGNOSTICS_ENABLED=false', '-e', 'N8N_PERSONALIZATION_ENABLED=false',
      '-e', 'N8N_SECURE_COOKIE=false', '-e', 'N8N_HOST=127.0.0.1',
      'n8nio/n8n@sha256:56a3f0d56c2888b53ca7d89de4aa3de702888f33667c96a1f1d7118548f979e9',
    ],
  },
];

const docker = (args, timeout = 120000) =>
  new Promise((resolve) => execFile('docker', args, { timeout }, (err, stdout) => resolve(err ? null : stdout.trim())));

/** Start whichever helpers are set up and not already running. Never throws. */
async function startContainers() {
  if ((await docker(['info', '--format', '{{.ServerVersion}}'], 10000)) === null) return [];
  const started = [];
  for (const c of CONTAINERS) {
    if (!fs.existsSync(c.needs)) continue; // not set up on this machine
    const running = await docker(['ps', '-q', '--filter', `name=^${c.name}$`]);
    if (running) continue;
    await docker(['rm', '-f', c.name], 20000);
    if ((await docker(['run', '-d', '--rm', '--name', c.name, ...c.args], 300000)) !== null) started.push(c.name);
  }
  return started;
}

async function stopContainers() {
  await Promise.all(CONTAINERS.map((c) => docker(['stop', '-t', '5', c.name], 15000)));
}

module.exports = { startContainers, stopContainers };
