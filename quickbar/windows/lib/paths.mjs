// Where FRIDAY keeps its files (same layout as ~/.friday on Linux; %USERPROFILE%\.friday on Windows).
import path from 'node:path';

export function fridayPaths(home) {
  const root = path.join(home, '.friday');
  const run = path.join(root, 'run');
  return {
    root,
    setup: path.join(root, 'setup.json'),
    friday: path.join(root, 'friday.json'),
    quickbar: path.join(root, 'quickbar.json'),
    voiceSettings: path.join(root, 'voice.json'),
    voiceRuntime: path.join(root, 'voice', 'runtime.json'),
    runDir: run,
    control: path.join(run, 'control.json'),
    stop: path.join(run, 'stop'),
  };
}
