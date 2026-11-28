// Platform helpers for the HUD's process control. Linux behaviour is the default; Windows
// branches are selected with `process.platform === 'win32'`. Every OS-dependent function takes
// its platform / env / exec as optional parameters so unit tests can cover both on Linux.
const { execFile, spawn } = require('child_process');
const os = require('os');
const path = require('path');

const isWindows = process.platform === 'win32';
const isLinux = process.platform === 'linux';

/** Python inside a virtual environment: `Scripts\python.exe` on Windows, `bin/python` elsewhere. */
function venvPython(venvDir, platform = process.platform) {
  return platform === 'win32' ? path.win32.join(venvDir, 'Scripts', 'python.exe') : path.posix.join(venvDir, 'bin', 'python');
}

/** Console script inside a virtual environment (e.g. edge-tts). */
function venvBin(venvDir, name, platform = process.platform) {
  return platform === 'win32' ? path.win32.join(venvDir, 'Scripts', `${name}.exe`) : path.posix.join(venvDir, 'bin', name);
}

/** The OS temp folder (/tmp on Linux, %TEMP% on Windows). */
function friendlyTmpDir(platform = process.platform) {
  return platform === 'win32' ? os.tmpdir() : '/tmp';
}

/** FRIDAY log folder: /tmp/friday on Linux (unchanged), <tmpdir>\friday on Windows. */
function logDir(platform = process.platform) {
  return platform === 'win32' ? path.join(os.tmpdir(), 'friday') : '/tmp/friday';
}

/** `python3` on Linux/macOS, `python` (or the `py` launcher is not assumed) on Windows. */
function systemPython(platform = process.platform) {
  return platform === 'win32' ? 'python' : 'python3';
}

/** PIDs listening on `port` from `netstat -ano -p tcp` output. */
function parseNetstat(stdout, port) {
  const pids = new Set();
  for (const line of String(stdout).split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    // Proto  Local  Foreign  State  PID
    if (cols.length < 5 || cols[0].toUpperCase() !== 'TCP' || cols[3].toUpperCase() !== 'LISTENING') continue;
    if (!cols[1].endsWith(`:${port}`)) continue;
    const pid = Number(cols[4]);
    if (pid > 0) pids.add(pid);
  }
  return [...pids];
}

/** PIDs from `ss -ltnpH` output (pid=123). */
function parseSs(stdout) {
  return [...new Set([...String(stdout).matchAll(/pid=(\d+)/g)].map((m) => Number(m[1])))];
}

/** PIDs from `lsof -t` output. */
function parseLsof(stdout) {
  return [...new Set(String(stdout).split(/\s+/).map(Number).filter((n) => n > 0))];
}

/** PIDs listening on a local TCP port (netstat on Windows, `ss` then `lsof` elsewhere). */
function findPidByPort(port, { platform = process.platform, run = execFile } = {}) {
  const call = (cmd, args) =>
    new Promise((resolve) => run(cmd, args, { timeout: 3000, windowsHide: true }, (err, stdout) => resolve(err ? null : String(stdout))));
  return (async () => {
    if (platform === 'win32') {
      const out = await call('netstat', ['-ano', '-p', 'tcp']);
      return out ? parseNetstat(out, port) : [];
    }
    const ss = await call('ss', ['-ltnpH', `sport = :${port}`]);
    if (ss !== null) return parseSs(ss);
    const lsof = await call('lsof', ['-t', `-iTCP:${port}`, '-sTCP:LISTEN']);
    return lsof ? parseLsof(lsof) : [];
  })();
}

/** Spawn a detached child with no console window (Windows) and no stdio. */
function spawnHidden(cmd, args = [], opts = {}, { spawnFn = spawn } = {}) {
  const child = spawnFn(cmd, args, { stdio: 'ignore', ...opts, windowsHide: true, detached: true });
  if (typeof child?.unref === 'function') child.unref();
  return child;
}

/** Kill a process and its children: `taskkill /T /F` on Windows, SIGTERM then the process group elsewhere. */
function killTree(pid, { platform = process.platform, run = execFile, kill = process.kill.bind(process) } = {}) {
  return new Promise((resolve) => {
    if (!pid) return resolve(false);
    if (platform === 'win32') {
      run('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 8000, windowsHide: true }, (err) => resolve(!err));
      return;
    }
    try {
      kill(-pid, 'SIGTERM');
      return resolve(true);
    } catch {
      // not a group leader: fall through to the single process
    }
    try {
      kill(pid, 'SIGTERM');
      resolve(true);
    } catch {
      resolve(false);
    }
  });
}

/** Run a command line in a shell that exists on this OS (bash -l on Linux, cmd on Windows). */
function shellCommand(command, platform = process.platform) {
  return platform === 'win32'
    ? { cmd: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', command] }
    : { cmd: 'bash', args: ['-l', '-c', command] };
}

/** `npx` needs the .cmd shim on Windows. */
function npxCommand(platform = process.platform) {
  return platform === 'win32' ? 'npx.cmd' : 'npx';
}

/** Windows `tasklist`-free liveness check works the same everywhere: signal 0. */
function isPidAlive(pid, kill = process.kill.bind(process)) {
  try {
    kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

module.exports = {
  isWindows,
  isLinux,
  venvPython,
  venvBin,
  friendlyTmpDir,
  logDir,
  systemPython,
  parseNetstat,
  parseSs,
  parseLsof,
  findPidByPort,
  spawnHidden,
  killTree,
  shellCommand,
  npxCommand,
  isPidAlive,
};
