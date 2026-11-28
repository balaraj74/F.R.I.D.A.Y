// Control_Indicator support: watches ~/.friday/run/control.json and creates ~/.friday/run/stop.
import path from 'node:path';
import {parseControl} from './settings.mjs';

/**
 * Re-reads control.json on `check()` and reports changes of `active` only.
 * @param {{read: () => string|null, onChange: (c:{active:boolean,since:*,action:string}) => void}} o
 */
export function createControlMonitor({read, onChange}) {
  let last = false;
  return {
    get active() {
      return last;
    },
    check() {
      let raw = null;
      try {
        raw = read();
      } catch {
        raw = null;
      }
      const c = parseControl(raw);
      if (c.active !== last) {
        last = c.active;
        onChange(c);
      }
      return c;
    },
  };
}

/** Writes the stop flag the desktop tool watches for. Returns true when the file was written. */
export function createStopRequester({fs, stopFile, now = () => new Date()}) {
  return function requestStop() {
    try {
      fs.mkdirSync(path.dirname(stopFile), {recursive: true});
      fs.writeFileSync(stopFile, `${now().toISOString()}\n`);
      return true;
    } catch {
      return false;
    }
  };
}
