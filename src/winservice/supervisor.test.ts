import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain ESM module without types
import { backoffMs, createSupervisor, ensureRuntime } from "./supervisor.mjs";
// @ts-expect-error plain ESM module without types
import { defineServices, makeContext, orderServices } from "./services.mjs";

type Def = {
  name: string;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  healthPort: number | null;
  dependsOn: string[];
  enabledWhen: (s: unknown) => boolean;
  available: () => boolean;
};

function fakeClock() {
  let t = 1_000_000;
  const timers: { at: number; fn: () => void; id: number }[] = [];
  let next = 1;
  return {
    now: () => t,
    setTimeout: (fn: () => void, ms: number) => {
      const id = next++;
      timers.push({ at: t + ms, fn, id });
      return id;
    },
    clearTimeout: (id: number) => {
      const i = timers.findIndex((x) => x.id === id);
      if (i >= 0) timers.splice(i, 1);
    },
    sleep: async (ms: number) => {
      t += ms;
    },
    advance(ms: number) {
      t += ms;
      for (const x of timers.filter((x) => x.at <= t).sort((a, b) => a.at - b.at)) {
        timers.splice(timers.indexOf(x), 1);
        x.fn();
      }
    },
    pending: () => timers.map((x) => x.at - t),
  };
}

function fakeSpawn() {
  const spawned: { name: string; child: EventEmitter & { pid: number } }[] = [];
  let pid = 100;
  const spawn = (command: string) => {
    const child = Object.assign(new EventEmitter(), { pid: ++pid });
    spawned.push({ name: command, child });
    return child;
  };
  return { spawn, spawned };
}

const def = (name: string, over: Partial<Def> = {}): Def => ({
  name,
  command: name,
  args: [],
  cwd: ".",
  env: {},
  healthPort: null,
  dependsOn: [],
  enabledWhen: () => true,
  available: () => true,
  ...over,
});

describe("supervisor", () => {
  it("backs off 1,2,4,8,16 s and never beyond 30 s", () => {
    expect([0, 1, 2, 3, 4, 10].map(backoffMs)).toEqual([1000, 2000, 4000, 8000, 16000, 20000]);
  });

  it("starts in dependency order and waits for each port before the next", async () => {
    const clock = fakeClock();
    const { spawn, spawned } = fakeSpawn();
    const up = new Set<number>();
    const seen: string[] = [];
    const services = [
      def("quickbar", { dependsOn: ["gateway"] }),
      def("gateway", { healthPort: 18789, dependsOn: ["proxy"] }),
      def("proxy", { healthPort: 8080 }),
    ];
    const sup = createSupervisor({
      services,
      spawn,
      clock,
      probePort: async (p: number) => {
        seen.push(`probe:${p}:${spawned.map((s) => s.name).join(",")}`);
        // each port comes up on its 3rd probe
        const n = seen.filter((s) => s.startsWith(`probe:${p}:`)).length;
        if (n >= 3) up.add(p);
        return up.has(p);
      },
    });
    await sup.start();
    expect(spawned.map((s) => s.name)).toEqual(["proxy", "gateway", "quickbar"]);
    // gateway was not spawned before proxy's port answered
    expect(seen.find((s) => s.startsWith("probe:8080:"))).toBe("probe:8080:proxy");
    expect(
      seen.filter((s) => s.startsWith("probe:18789")).every((s) => !s.endsWith("quickbar")),
    ).toBe(true);
    expect(sup.snapshot().services.gateway.state).toBe("running");
    expect(sup.snapshot().services.quickbar.state).toBe("running");
  });

  it("restarts a crashed child within 30 s with growing backoff, then gives up after 5", async () => {
    const clock = fakeClock();
    const { spawn, spawned } = fakeSpawn();
    const statuses: unknown[] = [];
    const sup = createSupervisor({
      services: [def("gateway", { healthPort: 1 })],
      spawn,
      clock,
      probePort: async () => true,
      writeStatus: (s: unknown) => statuses.push(s),
    });
    await sup.start();
    expect(spawned).toHaveLength(1);
    const delays: number[] = [];
    for (let i = 0; i < 5; i++) {
      spawned[spawned.length - 1].child.emit("exit", 1, null);
      const [d] = clock.pending();
      delays.push(d);
      expect(d).toBeLessThanOrEqual(30_000);
      expect(sup.snapshot().services.gateway.state).toBe("starting");
      clock.advance(d);
      await Promise.resolve();
      expect(spawned).toHaveLength(i + 2);
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000]);
    expect(sup.snapshot().services.gateway.restarts).toBe(5);
    // sixth crash inside the 5-minute window: stop retrying and record why
    spawned[spawned.length - 1].child.emit("exit", 1, null);
    const g = sup.snapshot().services.gateway;
    expect(g.state).toBe("failed");
    expect(g.reason).toMatch(/gave up after 5 restarts within 5 minutes/);
    expect(clock.pending()).toEqual([]);
  });

  it("forgets old failures after the 5-minute window", async () => {
    const clock = fakeClock();
    const { spawn, spawned } = fakeSpawn();
    const sup = createSupervisor({ services: [def("gateway")], spawn, clock });
    await sup.start();
    for (let i = 0; i < 8; i++) {
      spawned[spawned.length - 1].child.emit("exit", 1, null);
      clock.advance(6 * 60 * 1000); // each crash is isolated
      await Promise.resolve();
    }
    expect(sup.snapshot().services.gateway.state).not.toBe("failed");
  });

  it("marks a service not installed as failed and keeps going", async () => {
    const clock = fakeClock();
    const { spawn, spawned } = fakeSpawn();
    const sup = createSupervisor({
      services: [def("whisper", { available: () => false }), def("gateway")],
      spawn,
      clock,
    });
    await sup.start();
    expect(spawned.map((s) => s.name)).toEqual(["gateway"]);
    expect(sup.snapshot().services.whisper).toMatchObject({
      state: "failed",
      reason: "not installed",
    });
  });

  it("stop kills children dependents-first and marks them stopped", async () => {
    const clock = fakeClock();
    const { spawn, spawned } = fakeSpawn();
    const killed: number[] = [];
    const sup = createSupervisor({
      services: [def("proxy"), def("gateway", { dependsOn: ["proxy"] })],
      spawn,
      clock,
      kill: async (pid: number) => {
        killed.push(pid);
      },
    });
    await sup.start();
    await sup.stop();
    expect(killed).toEqual([spawned[1].child.pid, spawned[0].child.pid]);
    spawned[0].child.emit("exit", 0, null);
    expect(sup.snapshot().services.proxy.state).toBe("stopped");
    expect(clock.pending()).toEqual([]);
  });

  it("writes the status.json contract shape", async () => {
    const clock = fakeClock();
    const { spawn } = fakeSpawn();
    let last: any;
    const sup = createSupervisor({
      services: [def("proxy", { healthPort: 8080 })],
      spawn,
      clock,
      probePort: async () => true,
      writeStatus: (s: unknown) => {
        last = s;
      },
    });
    await sup.start();
    expect(last.services.proxy).toMatchObject({ state: "running", restarts: 0, port: 8080 });
    expect(typeof last.services.proxy.pid).toBe("number");
    expect(Number.isNaN(Date.parse(last.services.proxy.since))).toBe(false);
  });
});

describe("services", () => {
  const ctx = (exists: (p: string) => boolean = () => true) =>
    makeContext({
      platform: "win32",
      home: "C:\\Users\\Friend",
      repoRoot: "C:\\friday",
      exists,
      token: "tok",
    });
  const names = (setup: unknown) =>
    orderServices(defineServices(ctx()), setup).map((d: Def) => d.name);

  it("edge voice runs no local TTS service; whisper always runs", () => {
    const n = names({
      brain: "antigravity",
      voice: { tts: "edge", stt: "whisper-cpu" },
      quickbar: { enabled: true },
    });
    expect(n).toContain("whisper");
    expect(n).not.toContain("supertonic");
    expect(names({ voice: { tts: "none", stt: "whisper-cpu" } })).not.toContain("supertonic");
  });

  it("supertonic-gpu adds the supertonic service", () => {
    expect(names({ voice: { tts: "supertonic-gpu", stt: "whisper-gpu" } })).toContain("supertonic");
  });

  it("orders proxy, gateway, then quickbar, and honours quickbar.enabled", () => {
    const n = names({ brain: "antigravity", voice: { tts: "edge" } });
    expect(n.indexOf("proxy")).toBeLessThan(n.indexOf("gateway"));
    expect(n.indexOf("gateway")).toBeLessThan(n.indexOf("quickbar"));
    expect(names({ quickbar: { enabled: false } })).not.toContain("quickbar");
  });

  it("skips the proxy for other brains and defaults sensibly with no setup.json", () => {
    expect(names({ brain: "provider" })).not.toContain("proxy");
    expect(names(null)).toEqual(
      expect.arrayContaining(["proxy", "gateway", "whisper", "quickbar"]),
    );
  });

  it("uses Windows paths and loopback ports", () => {
    const defs = defineServices(ctx());
    const gw = defs.find((d: Def) => d.name === "gateway");
    expect(gw.args[0]).toBe("C:\\friday\\dist\\index.js");
    expect(gw.healthPort).toBe(18789);
    const wh = defs.find((d: Def) => d.name === "whisper");
    expect(wh.args).toContain("127.0.0.1");
    expect(wh.env.FRIDAY_VOICE_TOKEN).toBe("tok");
  });

  it("ensureRuntime keeps a managed token and creates one otherwise", () => {
    const files = new Map<string, string>();
    const fsApi = {
      readFileSync: (f: string) => {
        if (!files.has(f)) throw new Error("ENOENT");
        return files.get(f)!;
      },
      mkdirSync: () => {},
      writeFileSync: (f: string, d: string) => {
        files.set(f, d);
      },
    };
    const c = makeContext({ platform: "linux", home: "/h" });
    const a = ensureRuntime(c, { fsApi, randomHex: () => "abc" });
    expect(a).toEqual({
      managed: true,
      token: "abc",
      ports: { whisper: 18950, kokoro: 18951, supertonic: 18952 },
    });
    expect(ensureRuntime(c, { fsApi, randomHex: () => "zzz" }).token).toBe("abc");
  });
});
