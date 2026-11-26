import { createRequire } from "node:module";

import { describe, expect, it, vi } from "vitest";

const { createServiceWatch } = createRequire(import.meta.url)("./service-watch.cjs") as {
  createServiceWatch: (opts: {
    services: Record<string, { isUp: () => Promise<boolean>; restart: () => Promise<{ ok: boolean; error?: string }>; misses?: number }>;
    notify?: (p: unknown) => void;
    isShuttingDown?: () => boolean;
  }) => { start: (n: string) => Promise<{ ok: boolean }>; disarm: (n: string) => void; tick: () => Promise<unknown> };
};

/** A gateway whose up/down state and start time the test controls. */
function fakeService(opts: { startMs?: number; startOk?: boolean } = {}) {
  const svc = { up: false, restarts: 0 };
  return {
    svc,
    def: {
      isUp: async () => svc.up,
      restart: vi.fn(async () => {
        svc.restarts += 1;
        await new Promise((r) => setTimeout(r, opts.startMs ?? 0));
        svc.up = opts.startOk !== false;
        return opts.startOk === false ? { ok: false, error: "boom" } : { ok: true };
      }),
      misses: 3,
    },
  };
}

const ticks = async (w: { tick: () => Promise<unknown> }, n: number) => {
  for (let i = 0; i < n; i++) await w.tick();
};

describe("service watch", () => {
  it("leaves a service the start-up sequence hasn't brought up yet alone", async () => {
    const { def } = fakeService();
    const w = createServiceWatch({ services: { gateway: def } });
    await ticks(w, 20); // far longer than a slow boot
    expect(def.restart).not.toHaveBeenCalled();
  });

  it("never starts a second copy while one is still starting (the restart loop)", async () => {
    const { def, svc } = fakeService({ startMs: 60 });
    const w = createServiceWatch({ services: { gateway: def } });
    // Boot starts the gateway; the watchdog keeps ticking, and the Restart button is pressed too.
    const boot = w.start("gateway");
    const again = w.start("gateway");
    await ticks(w, 5);
    expect(await boot).toEqual({ ok: true });
    expect(await again).toEqual({ ok: true });
    expect(def.restart).toHaveBeenCalledTimes(1);
    expect(svc.up).toBe(true);
  });

  it("repairs a service that was up and then stays down for several checks in a row", async () => {
    const { def, svc } = fakeService();
    const notify = vi.fn();
    const w = createServiceWatch({ services: { gateway: def }, notify });
    svc.up = true;
    await w.tick(); // seen up
    svc.up = false;
    await ticks(w, 2);
    expect(def.restart).not.toHaveBeenCalled(); // two misses are not enough
    await w.tick();
    expect(def.restart).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls.map((c) => (c[0] as { state: string }).state)).toEqual(["down", "restored"]);
    await ticks(w, 6);
    expect(def.restart).toHaveBeenCalledTimes(1); // back up: no more restarts
  });

  it("one slow answer isn't an outage", async () => {
    const { def, svc } = fakeService();
    const w = createServiceWatch({ services: { gateway: def } });
    svc.up = true;
    await w.tick();
    svc.up = false;
    await w.tick();
    svc.up = true;
    await ticks(w, 5);
    svc.up = false;
    await ticks(w, 2);
    expect(def.restart).not.toHaveBeenCalled(); // the miss count restarted from zero
  });

  it("doesn't bring back a service Sir stopped on purpose, until he starts it again", async () => {
    const { def, svc } = fakeService();
    const w = createServiceWatch({ services: { gateway: def } });
    svc.up = true;
    await w.tick();
    w.disarm("gateway");
    svc.up = false;
    await ticks(w, 10);
    expect(def.restart).not.toHaveBeenCalled();
    await w.start("gateway"); // Start pressed
    svc.up = false;
    await ticks(w, 3);
    expect(def.restart).toHaveBeenCalledTimes(2); // watched again
  });

  it("reports a failed repair and tries again later instead of looping", async () => {
    const { def, svc } = fakeService({ startOk: false });
    const notify = vi.fn();
    const w = createServiceWatch({ services: { brain: def }, notify });
    svc.up = true;
    await w.tick();
    svc.up = false;
    await ticks(w, 3);
    expect(notify.mock.calls.at(-1)?.[0]).toMatchObject({ service: "brain", state: "failed", error: "boom" });
    expect(def.restart).toHaveBeenCalledTimes(1);
    await ticks(w, 2);
    expect(def.restart).toHaveBeenCalledTimes(1); // needs another run of misses first
    await w.tick();
    expect(def.restart).toHaveBeenCalledTimes(2);
  });

  it("does nothing while the app is shutting down", async () => {
    const { def, svc } = fakeService();
    let closing = false;
    const w = createServiceWatch({ services: { gateway: def }, isShuttingDown: () => closing });
    svc.up = true;
    await w.tick();
    svc.up = false;
    closing = true;
    await ticks(w, 10);
    expect(def.restart).not.toHaveBeenCalled();
  });
});
