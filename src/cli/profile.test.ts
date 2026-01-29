import path from "node:path";
import { describe, expect, it } from "vitest";
import { formatCliCommand } from "./command-format.js";
import { applyCliProfileEnv, parseCliProfileArgs } from "./profile.js";

describe("parseCliProfileArgs", () => {
  it("leaves gateway --dev for subcommands", () => {
    const res = parseCliProfileArgs(["node", "friday", "gateway", "--dev", "--allow-unconfigured"]);
    if (!res.ok) throw new Error(res.error);
    expect(res.profile).toBeNull();
    expect(res.argv).toEqual(["node", "friday", "gateway", "--dev", "--allow-unconfigured"]);
  });

  it("still accepts global --dev before subcommand", () => {
    const res = parseCliProfileArgs(["node", "friday", "--dev", "gateway"]);
    if (!res.ok) throw new Error(res.error);
    expect(res.profile).toBe("dev");
    expect(res.argv).toEqual(["node", "friday", "gateway"]);
  });

  it("parses --profile value and strips it", () => {
    const res = parseCliProfileArgs(["node", "friday", "--profile", "work", "status"]);
    if (!res.ok) throw new Error(res.error);
    expect(res.profile).toBe("work");
    expect(res.argv).toEqual(["node", "friday", "status"]);
  });

  it("rejects missing profile value", () => {
    const res = parseCliProfileArgs(["node", "friday", "--profile"]);
    expect(res.ok).toBe(false);
  });

  it("rejects combining --dev with --profile (dev first)", () => {
    const res = parseCliProfileArgs(["node", "friday", "--dev", "--profile", "work", "status"]);
    expect(res.ok).toBe(false);
  });

  it("rejects combining --dev with --profile (profile first)", () => {
    const res = parseCliProfileArgs(["node", "friday", "--profile", "work", "--dev", "status"]);
    expect(res.ok).toBe(false);
  });
});

describe("applyCliProfileEnv", () => {
  it("fills env defaults for dev profile", () => {
    const env: Record<string, string | undefined> = {};
    applyCliProfileEnv({
      profile: "dev",
      env,
      homedir: () => "/home/peter",
    });
    const expectedStateDir = path.join("/home/peter", ".friday-dev");
    expect(env.FRIDAY_PROFILE).toBe("dev");
    expect(env.FRIDAY_STATE_DIR).toBe(expectedStateDir);
    expect(env.FRIDAY_CONFIG_PATH).toBe(path.join(expectedStateDir, "friday.json"));
    expect(env.FRIDAY_GATEWAY_PORT).toBe("19001");
  });

  it("does not override explicit env values", () => {
    const env: Record<string, string | undefined> = {
      FRIDAY_STATE_DIR: "/custom",
      FRIDAY_GATEWAY_PORT: "19099",
    };
    applyCliProfileEnv({
      profile: "dev",
      env,
      homedir: () => "/home/peter",
    });
    expect(env.FRIDAY_STATE_DIR).toBe("/custom");
    expect(env.FRIDAY_GATEWAY_PORT).toBe("19099");
    expect(env.FRIDAY_CONFIG_PATH).toBe(path.join("/custom", "friday.json"));
  });
});

describe("formatCliCommand", () => {
  it("returns command unchanged when no profile is set", () => {
    expect(formatCliCommand("friday doctor --fix", {})).toBe("friday doctor --fix");
  });

  it("returns command unchanged when profile is default", () => {
    expect(formatCliCommand("friday doctor --fix", { FRIDAY_PROFILE: "default" })).toBe(
      "friday doctor --fix",
    );
  });

  it("returns command unchanged when profile is Default (case-insensitive)", () => {
    expect(formatCliCommand("friday doctor --fix", { FRIDAY_PROFILE: "Default" })).toBe(
      "friday doctor --fix",
    );
  });

  it("returns command unchanged when profile is invalid", () => {
    expect(formatCliCommand("friday doctor --fix", { FRIDAY_PROFILE: "bad profile" })).toBe(
      "friday doctor --fix",
    );
  });

  it("returns command unchanged when --profile is already present", () => {
    expect(formatCliCommand("friday --profile work doctor --fix", { FRIDAY_PROFILE: "work" })).toBe(
      "friday --profile work doctor --fix",
    );
  });

  it("returns command unchanged when --dev is already present", () => {
    expect(formatCliCommand("friday --dev doctor", { FRIDAY_PROFILE: "dev" })).toBe(
      "friday --dev doctor",
    );
  });

  it("inserts --profile flag when profile is set", () => {
    expect(formatCliCommand("friday doctor --fix", { FRIDAY_PROFILE: "work" })).toBe(
      "friday --profile work doctor --fix",
    );
  });

  it("trims whitespace from profile", () => {
    expect(formatCliCommand("friday doctor --fix", { FRIDAY_PROFILE: "  jbfriday  " })).toBe(
      "friday --profile jbfriday doctor --fix",
    );
  });

  it("handles command with no args after friday", () => {
    expect(formatCliCommand("friday", { FRIDAY_PROFILE: "test" })).toBe("friday --profile test");
  });

  it("handles pnpm wrapper", () => {
    expect(formatCliCommand("pnpm friday doctor", { FRIDAY_PROFILE: "work" })).toBe(
      "pnpm friday --profile work doctor",
    );
  });
});
