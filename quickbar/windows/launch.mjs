// Starts the Quick_Bar_Host with whichever Electron is installed: this folder's own, or the HUD's.
// The supervisor can also run `electron quickbar/windows` directly; this is for `npm start`.
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export function findElectron(searchRoots = [here, path.join(here, '..', '..', 'friday-hud')]) {
  for (const root of searchRoots) {
    try {
      // The `electron` package exports the path of its binary.
      const bin = createRequire(path.join(root, 'noop.js'))('electron');
      if (typeof bin === 'string') return bin;
    } catch {
      // try the next location
    }
  }
  return null;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const bin = findElectron();
  if (!bin) {
    console.error('Electron was not found. Run `pnpm install` in friday-hud (or `npm i electron` here).');
    process.exit(1);
  }
  const env = {...process.env};
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(bin, [here], {stdio: 'inherit', env, windowsHide: true});
  child.on('exit', (code) => process.exit(code ?? 0));
}
