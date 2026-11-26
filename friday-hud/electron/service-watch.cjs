// Self-repair for FRIDAY's services (reasoning engine, gateway) while the app is initialised.
//
// Rules that keep it from fighting the start-up sequence or killing work in progress:
//  - One start at a time per service: boot steps, the watchdog and the Restart button all share
//    the same in-flight start, so a start never deletes the session of one that's still booting.
//  - A service is only watched once it has been seen up this session. Before that, the start-up
//    sequence owns it and reports its own failure.
//  - Several misses in a row (not one slow answer) before repairing.
//  - A service Sir stopped on purpose stays stopped until he starts it again.

function createServiceWatch({ services, intervalMs = 10000, notify = () => {}, isShuttingDown = () => false }) {
  const state = {};
  for (const [name, svc] of Object.entries(services)) {
    state[name] = { misses: 0, armed: false, flight: null, needed: svc.misses ?? 3 };
  }

  /** Start (or join the start of) a service. Everything that starts a service goes through here. */
  function start(name) {
    const s = state[name];
    s.flight ??= Promise.resolve()
      .then(() => services[name].restart())
      .then(
        (res) => {
          if (res?.ok) s.armed = true;
          return res;
        },
        (err) => ({ ok: false, error: err?.message || String(err) }),
      )
      .finally(() => {
        s.flight = null;
        s.misses = 0;
      });
    return s.flight;
  }

  async function check(name) {
    const s = state[name];
    if (s.flight || isShuttingDown()) return;
    if (await services[name].isUp()) {
      s.misses = 0;
      s.armed = true;
      return;
    }
    if (!s.armed) return; // never up this session: start-up owns it
    s.misses += 1;
    if (s.misses < s.needed) return;
    notify({ service: name, state: 'down' });
    const res = await start(name);
    notify({ service: name, state: res.ok ? 'restored' : 'failed', error: res.error, ms: res.ms });
  }

  let timer = null;
  return {
    start,
    /** Sir stopped it on purpose: don't bring it back. */
    disarm(name) {
      state[name].armed = false;
      state[name].misses = 0;
    },
    tick: () => Promise.all(Object.keys(state).map((n) => check(n).catch(() => {}))),
    startWatchdog() {
      if (timer) return;
      timer = setInterval(() => void this.tick(), intervalMs);
    },
    stopWatchdog() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    _state: state,
  };
}

module.exports = { createServiceWatch };
