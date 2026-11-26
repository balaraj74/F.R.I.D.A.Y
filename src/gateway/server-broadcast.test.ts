import { describe, expect, it, vi } from "vitest";

import { HUD_APPROVAL_EVENT, HUD_NOTICE_EVENT } from "../jobs/ops/notifier.js";
import { createGatewayBroadcaster } from "./server-broadcast.js";
import type { GatewayWsClient } from "./server/ws-types.js";

type TestSocket = {
  bufferedAmount: number;
  send: (payload: string) => void;
  close: (code: number, reason: string) => void;
};

describe("gateway broadcaster", () => {
  it("filters approval and pairing events by scope", () => {
    const approvalsSocket: TestSocket = {
      bufferedAmount: 0,
      send: vi.fn(),
      close: vi.fn(),
    };
    const pairingSocket: TestSocket = {
      bufferedAmount: 0,
      send: vi.fn(),
      close: vi.fn(),
    };
    const readSocket: TestSocket = {
      bufferedAmount: 0,
      send: vi.fn(),
      close: vi.fn(),
    };

    const clients = new Set<GatewayWsClient>([
      {
        socket: approvalsSocket as unknown as GatewayWsClient["socket"],
        connect: { role: "operator", scopes: ["operator.approvals"] } as GatewayWsClient["connect"],
        connId: "c-approvals",
      },
      {
        socket: pairingSocket as unknown as GatewayWsClient["socket"],
        connect: { role: "operator", scopes: ["operator.pairing"] } as GatewayWsClient["connect"],
        connId: "c-pairing",
      },
      {
        socket: readSocket as unknown as GatewayWsClient["socket"],
        connect: { role: "operator", scopes: ["operator.read"] } as GatewayWsClient["connect"],
        connId: "c-read",
      },
    ]);

    const { broadcast } = createGatewayBroadcaster({ clients });

    broadcast("exec.approval.requested", { id: "1" });
    broadcast("device.pair.requested", { requestId: "r1" });

    expect(approvalsSocket.send).toHaveBeenCalledTimes(1);
    expect(pairingSocket.send).toHaveBeenCalledTimes(1);
    expect(readSocket.send).toHaveBeenCalledTimes(0);
  });
  it("limits Job approval events to approvals-scoped clients and Job notices to read/write clients", () => {
    const makeClient = (connId: string, role: string, scopes: string[]) => {
      const socket: TestSocket = { bufferedAmount: 0, send: vi.fn(), close: vi.fn() };
      const client = {
        socket: socket as unknown as GatewayWsClient["socket"],
        connect: { role, scopes } as GatewayWsClient["connect"],
        connId,
      } as GatewayWsClient;
      return { socket, client };
    };
    const approvals = makeClient("approvals", "operator", ["operator.approvals"]);
    const admin = makeClient("admin", "operator", ["operator.admin"]);
    const read = makeClient("read", "operator", ["operator.read"]);
    const write = makeClient("write", "operator", ["operator.write"]);
    const pairing = makeClient("pairing", "operator", ["operator.pairing"]);
    const node = makeClient("node", "node", ["operator.approvals", "operator.read"]);
    const all = [approvals, admin, read, write, pairing, node];
    const { broadcast } = createGatewayBroadcaster({ clients: new Set(all.map((c) => c.client)) });

    // The guards must cover exactly the events the Notifier's HUD channel broadcasts.
    expect(HUD_APPROVAL_EVENT).toBe("jobs.approval");
    expect(HUD_NOTICE_EVENT).toBe("jobs.notice");

    broadcast(HUD_APPROVAL_EVENT, { kind: "approval-request", jobId: "j", taskId: "t" });
    const approvalReceivers = all.filter(
      (c) => (c.socket.send as ReturnType<typeof vi.fn>).mock.calls.length > 0,
    );
    expect(approvalReceivers).toEqual([approvals, admin]);

    for (const c of all) (c.socket.send as ReturnType<typeof vi.fn>).mockClear();
    broadcast(HUD_NOTICE_EVENT, { kind: "notice", text: "hello" });
    const noticeReceivers = all.filter(
      (c) => (c.socket.send as ReturnType<typeof vi.fn>).mock.calls.length > 0,
    );
    expect(noticeReceivers).toEqual([admin, read, write]);
  });
});
