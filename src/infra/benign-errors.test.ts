import { describe, expect, it } from "vitest";

import { isBenignProcessError } from "./benign-errors.js";

const err = (code: string, message: string, syscall?: string) =>
  Object.assign(new Error(message), { code, syscall });

describe("isBenignProcessError", () => {
  it("ignores writes to a terminal that went away", () => {
    expect(isBenignProcessError(err("EIO", "write EIO", "write"))).toBe(true);
    expect(isBenignProcessError(err("EPIPE", "write EPIPE", "write"))).toBe(true);
  });
  it("ignores late file-handle cleanup", () => {
    expect(
      isBenignProcessError(
        err("EBADF", "EBADF: Closing file descriptor 43 on garbage collection failed, close"),
      ),
    ).toBe(true);
  });
  it("still treats real errors as fatal", () => {
    expect(isBenignProcessError(err("EBADF", "EBADF: bad file descriptor, read"))).toBe(false);
    expect(isBenignProcessError(err("ENOENT", "no such file"))).toBe(false);
    expect(isBenignProcessError(new TypeError("x is undefined"))).toBe(false);
    expect(isBenignProcessError(err("EIO", "read EIO", "read"))).toBe(false);
  });
});
