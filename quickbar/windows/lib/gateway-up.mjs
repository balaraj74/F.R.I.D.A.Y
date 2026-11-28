// "Is the gateway answering? If not, ask the Service_Manager to start it and wait."
// Replaces Services.ensureGateway from quickbar/daemon/services.mjs, which starts tmux sessions.
export function createEnsureGateway({tcpUp, port, startServices, sleep, now, timeoutMs = 90_000, stepMs = 700}) {
  let pending = null;
  let asked = false;
  return function ensureGateway(status = () => {}) {
    if (!pending) {
      pending = (async () => {
        if (await tcpUp(port)) return {ok: true};
        status('Starting FRIDAY...');
        if (!asked) {
          asked = true;
          try {
            await startServices();
          } catch {
            // the wait below reports the failure
          }
        }
        const end = now() + timeoutMs;
        while (now() < end) {
          if (await tcpUp(port)) return {ok: true};
          await sleep(stepMs);
        }
        asked = false;
        return {ok: false, error: `The gateway did not start within ${Math.round(timeoutMs / 1000)} seconds.`};
      })().finally(() => {
        pending = null;
      });
    }
    return pending;
  };
}
