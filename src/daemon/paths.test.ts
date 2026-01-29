import path from "node:path";

import { describe, expect, it } from "vitest";

import { resolveGatewayStateDir } from "./paths.js";

describe("resolveGatewayStateDir", () => {
  it("uses the default state dir when no overrides are set", () => {
    const env = { HOME: "/Users/test" };
    expect(resolveGatewayStateDir(env)).toBe(path.join("/Users/test", ".friday"));
  });

  it("appends the profile suffix when set", () => {
    const env = { HOME: "/Users/test", FRIDAY_PROFILE: "rescue" };
    expect(resolveGatewayStateDir(env)).toBe(path.join("/Users/test", ".friday-rescue"));
  });

  it("treats default profiles as the base state dir", () => {
    const env = { HOME: "/Users/test", FRIDAY_PROFILE: "Default" };
    expect(resolveGatewayStateDir(env)).toBe(path.join("/Users/test", ".friday"));
  });

  it("uses FRIDAY_STATE_DIR when provided", () => {
    const env = { HOME: "/Users/test", FRIDAY_STATE_DIR: "/var/lib/friday" };
    expect(resolveGatewayStateDir(env)).toBe(path.resolve("/var/lib/friday"));
  });

  it("expands ~ in FRIDAY_STATE_DIR", () => {
    const env = { HOME: "/Users/test", FRIDAY_STATE_DIR: "~/friday-state" };
    expect(resolveGatewayStateDir(env)).toBe(path.resolve("/Users/test/friday-state"));
  });

  it("preserves Windows absolute paths without HOME", () => {
    const env = { FRIDAY_STATE_DIR: "C:\\State\\friday" };
    expect(resolveGatewayStateDir(env)).toBe("C:\\State\\friday");
  });
});
