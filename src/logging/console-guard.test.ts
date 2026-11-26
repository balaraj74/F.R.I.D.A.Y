import { describe, expect, it } from "vitest";

import { createSubsystemLogger } from "./subsystem.js";

describe("console guard", () => {
  it("survives EIO/EPIPE on stdout (terminal went away) but not other errors", () => {
    createSubsystemLogger("test/console-guard").info("install guards");
    const emit = (code: string) =>
      process.stdout.emit("error", Object.assign(new Error(code), { code }));
    expect(() => emit("EIO")).not.toThrow();
    expect(() => emit("EPIPE")).not.toThrow();
    expect(() => emit("EACCES")).toThrow("EACCES");
  });
});
