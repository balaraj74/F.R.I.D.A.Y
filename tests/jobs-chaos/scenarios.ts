// Chaos scenarios. The "faults" are simulated: a fake Proxy, a simulated Gateway restart through
// the real boot/restore code, a fake network switch, and a size-limited temp directory for the
// disk. Nothing here kills a real process or touches a real service. Time is the FakeClock.
import { resetJobEngineRestoreForTests } from "../../src/jobs/engine/boot.js";
import {
  CHAOS_DEADLINE_MS,
  TempDiskArea,
  type ChaosObservation,
  type ChaosScenario,
} from "../../src/jobs/evals/chaos.js";
import { HealthMonitor } from "../../src/jobs/ops/health.js";
import { ProxyRestartCoordinator } from "../../src/jobs/ops/proxy-restart.js";
import { resumeAfterBoot } from "../../src/jobs/ops/resume.js";
import { createRig, healthClockFrom, never, rawTask } from "../../src/jobs/ops/test-helpers.js";
import type { Orchestrator } from "../../src/jobs/orchestrator/runtime-types.js";
import { ProxyUnreachableError } from "../../src/jobs/runner/step-runner.js";
import { FakeClock, flushMicrotasks } from "../../src/jobs/runner/test-helpers.js";

export type ChaosScenarioOptions = {
  /** Size of the disk-fill area. Must be at most 100 MB; tests use a few KiB. */
  diskCapBytes?: number;
  /** Where the disk-fill area is created. Defaults to the OS temp dir. */
  tmpParent?: string;
};

const plan = { tasks: [rawTask("a"), rawTask("b", ["a"])] };

/** Runs the simulated clock until the Job ends or 300s pass, then reports what it looks like. */
async function observe(
  clock: FakeClock,
  orch: Pick<Orchestrator, "awaitTerminal" | "getJob">,
  jobId: string,
  faultInjectedAtMs: number,
): Promise<ChaosObservation> {
  try {
    await clock.drive(orch.awaitTerminal(jobId), CHAOS_DEADLINE_MS + 1);
  } catch {
    // Never settled inside the window: report the state it is stuck in.
  }
  const view = orch.getJob(jobId);
  return {
    faultInjectedAtMs,
    observedAtMs: view?.updatedAtMs ?? clock.now(),
    state: view?.state ?? "unknown",
    ...(view?.failureReason !== undefined ? { failureReason: view.failureReason } : {}),
  };
}

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await flushMicrotasks();
  if (!cond()) throw new Error("condition never became true");
}

const sleepOn = (clock: FakeClock, ms: number) =>
  new Promise<void>((resolve) => clock.setTimer(resolve, ms));

/** HealthMonitor wired to fakes. Network pause/resume act on the Jobs in `jobIds`. */
function makeMonitor(
  rig: ReturnType<typeof createRig>,
  orch: Orchestrator,
  fakes: {
    proxyUp: () => boolean;
    restartProxy?: () => Promise<void>;
    networkUp?: () => boolean;
    freeDisk?: () => number;
  },
  jobIds: string[],
  onProxyEvent?: ConstructorParameters<typeof HealthMonitor>[0]["onProxyEvent"],
) {
  const notifications: string[] = [];
  const monitor = new HealthMonitor({
    db: rig.db,
    clock: healthClockFrom(rig.clock),
    probeProxy: async () => fakes.proxyUp(),
    restartProxy: fakes.restartProxy ?? (async () => undefined),
    freeDiskBytes: async () => fakes.freeDisk?.() ?? Number.MAX_SAFE_INTEGER,
    probeNetwork: async () => fakes.networkUp?.() ?? true,
    notify: (n) => void notifications.push(`${n.kind}: ${n.text}`),
    diskThresholdBytes: 1,
    ...(onProxyEvent ? { onProxyEvent } : {}),
    pauseNetworkSteps: () => {
      for (const id of jobIds) {
        try {
          orch.pauseJob(id);
        } catch {
          // Not running (already terminal or paused): nothing to pause.
        }
      }
    },
    resumeNetworkSteps: () => {
      for (const id of jobIds) {
        try {
          orch.resumeJob(id);
        } catch {
          // Not paused: nothing to resume.
        }
      }
    },
  });
  return { monitor, notifications };
}

function proxyKillScenario(): ChaosScenario {
  const state = { up: true };
  return {
    id: "kill-proxy",
    fault: "proxy",
    async run(ctx) {
      resetJobEngineRestoreForTests();
      state.up = true;
      const rig = createRig();
      const coordinator = new ProxyRestartCoordinator({
        db: rig.db,
        probeProxy: async () => state.up,
        notifier: { notify: () => undefined },
        clock: healthClockFrom(rig.clock),
        maxWaitMs: 120_000,
      });
      const proc = rig.boot({ proxyRecovery: coordinator });
      const ids: string[] = [];
      const { monitor } = makeMonitor(
        rig,
        proc.orchestrator,
        {
          proxyUp: () => state.up,
          // The supervisor brings the fake Proxy back after 4s.
          restartProxy: async () => {
            await sleepOn(rig.clock, 4_000);
            state.up = true;
          },
        },
        ids,
        coordinator.handleHealthEvent,
      );
      ctx.onCleanup("stop health monitor", () => monitor.stop());
      ctx.onCleanup("restore proxy", () => {
        state.up = true;
      });

      let faultAt = -1;
      proc.agents.turn = async (req) => {
        if (faultAt < 0) {
          faultAt = rig.clock.now();
          state.up = false; // the kill
        }
        if (!state.up) throw new ProxyUnreachableError();
        return { reply: `done ${req.stepId}` };
      };
      monitor.start();
      const { id } = await proc.orchestrator.createJob({ goal: "chaos", initialPlan: plan });
      ids.push(id);
      await until(() => faultAt >= 0);
      return observe(rig.clock, proc.orchestrator, id, faultAt);
    },
    verifyRestored: () => (state.up ? [] : ["proxy is still down"]),
  };
}

function gatewayKillScenario(): ChaosScenario {
  const gateway = { alive: true };
  return {
    id: "kill-gateway",
    fault: "gateway",
    async run(ctx) {
      resetJobEngineRestoreForTests();
      gateway.alive = true;
      const rig = createRig();
      ctx.onCleanup("restore gateway", () => {
        gateway.alive = true;
        resetJobEngineRestoreForTests();
      });

      // Process A runs the Job; step a.1.1 hangs forever when the Gateway dies.
      const a = rig.boot();
      let started = false;
      a.agents.turn = async () => {
        started = true;
        return never();
      };
      const { id } = await a.orchestrator.createJob({ goal: "chaos", initialPlan: plan });
      await until(() => started);
      const faultAt = rig.clock.now();
      gateway.alive = false; // the kill: process A is abandoned mid-step

      // Simulated restart: a new process runs the real boot/restore code over the same log.
      rig.clock.jump(5_000);
      const b = rig.boot();
      await rig.clock.drive(
        resumeAfterBoot({
          db: rig.db,
          orchestrator: b.orchestrator,
          clock: rig.clock,
          bootTimeMs: rig.clock.now(),
        }),
      );
      gateway.alive = true;
      return observe(rig.clock, b.orchestrator, id, faultAt);
    },
    verifyRestored: () => (gateway.alive ? [] : ["gateway is still down"]),
  };
}

function networkCutScenario(): ChaosScenario {
  const net = { up: true };
  return {
    id: "cut-network",
    fault: "network",
    async run(ctx) {
      resetJobEngineRestoreForTests();
      net.up = true;
      const rig = createRig();
      const proc = rig.boot();
      const ids: string[] = [];
      const { monitor } = makeMonitor(
        rig,
        proc.orchestrator,
        { proxyUp: () => true, networkUp: () => net.up },
        ids,
      );
      ctx.onCleanup("stop health monitor", () => monitor.stop());
      ctx.onCleanup("restore network", () => {
        net.up = true;
      });

      let faultAt = -1;
      let release: (() => void) | undefined;
      proc.agents.turn = async (req) => {
        if (faultAt < 0) {
          faultAt = rig.clock.now();
          net.up = false; // the cut; it comes back after 45s
          rig.clock.setTimer(() => {
            net.up = true;
            release?.();
          }, 45_000);
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return { reply: `done ${req.stepId}` };
      };
      monitor.start();
      const { id } = await proc.orchestrator.createJob({ goal: "chaos", initialPlan: plan });
      ids.push(id);
      await until(() => faultAt >= 0);
      return observe(rig.clock, proc.orchestrator, id, faultAt);
    },
    verifyRestored: () => (net.up ? [] : ["network is still cut"]),
  };
}

function diskFillScenario(opts: ChaosScenarioOptions): ChaosScenario {
  let area: TempDiskArea | undefined;
  return {
    id: "fill-disk",
    fault: "disk",
    async run(ctx) {
      resetJobEngineRestoreForTests();
      const cap = opts.diskCapBytes ?? 256 * 1024;
      const disk = await TempDiskArea.create(cap, opts.tmpParent);
      area = disk;
      // Registered first so it runs last: files are removed only after the monitor stops.
      ctx.onCleanup("remove temp location", () => disk.remove());

      const rig = createRig();
      const proc = rig.boot();
      const ids: string[] = [];
      const { monitor, notifications } = makeMonitor(
        rig,
        proc.orchestrator,
        { proxyUp: () => true, freeDisk: () => disk.freeBytes() },
        ids,
      );
      ctx.onCleanup("stop health monitor", () => monitor.stop());

      let faultAt = -1;
      let filled: Promise<void> | undefined;
      proc.agents.turn = async (req) => {
        if (faultAt < 0) {
          faultAt = rig.clock.now();
          // The fault. Real file I/O, so the scenario waits for it before moving the fake clock.
          filled = disk.fill(Math.max(1, Math.floor(cap / 8)));
          await filled;
        }
        return { reply: `done ${req.stepId}` };
      };
      monitor.start();
      const { id } = await proc.orchestrator.createJob({ goal: "chaos", initialPlan: plan });
      ids.push(id);
      await until(() => faultAt >= 0);
      await filled;
      const obs = await observe(rig.clock, proc.orchestrator, id, faultAt);

      // Running Jobs finish, but new Jobs must be blocked once the monitor sees the full disk.
      await rig.clock.advance(15_000);
      const gate = monitor.canCreateJob();
      if (gate.allowed) throw new Error("low-disk gate did not block new Jobs");
      if (!notifications.some((n) => n.startsWith("disk-low"))) {
        throw new Error("no disk-low notification was sent");
      }
      return obs;
    },
    verifyRestored: async () => ((await area?.exists()) ? ["temp location still exists"] : []),
  };
}

export function createChaosScenarios(opts: ChaosScenarioOptions = {}): ChaosScenario[] {
  return [proxyKillScenario(), gatewayKillScenario(), networkCutScenario(), diskFillScenario(opts)];
}
