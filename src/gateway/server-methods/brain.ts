import { quickAck, spokenVersion } from "../../agents/fast-brain.js";
import { loadConfig } from "../../config/config.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

export const brainHandlers: GatewayRequestHandlers = {
  // Instant acknowledgement from the fast brain while the main brain works on the turn.
  "brain.ack": async ({ params, respond }) => {
    const text = (params as { text?: unknown })?.text;
    if (typeof text !== "string" || !text.trim()) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "brain.ack requires text"));
      return;
    }
    const started = Date.now();
    const ack = await quickAck(loadConfig(), text);
    respond(true, { ack, ms: Date.now() - started }, undefined);
  },
  // A screen-written reply (lists, reports) turned into what she'd actually say out loud.
  "brain.spoken": async ({ params, respond }) => {
    const { text, alreadySaid } = (params ?? {}) as { text?: unknown; alreadySaid?: unknown };
    if (typeof text !== "string" || !text.trim()) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "brain.spoken requires text"),
      );
      return;
    }
    const started = Date.now();
    const spoken = await spokenVersion(
      loadConfig(),
      text,
      typeof alreadySaid === "string" ? alreadySaid : "",
    );
    respond(true, { spoken, ms: Date.now() - started }, undefined);
  },
};
