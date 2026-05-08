import { describe, expect, it, vi } from "vitest";

import { parseArgs, runCli, type CliRuntime } from "../src/cli.js";

describe("cli", () => {
  it("parses flags", () => {
    expect(parseArgs(["--port", "9000", "--base-url", "https://example.com"])).toMatchObject({
      port: 9000,
      baseUrl: "https://example.com",
      help: false,
      version: false,
    });
    expect(parseArgs(["--help"]).help).toBe(true);
    expect(parseArgs(["--version"]).version).toBe(true);
  });

  it("rejects unknown commands", async () => {
    const error = vi.fn();
    const exit = vi.fn();
    const startProxy = vi.fn<NonNullable<CliRuntime["startProxy"]>>();

    await runCli(["wallet"], {
      log: vi.fn(),
      error,
      exit,
      startProxy,
    });

    expect(error).toHaveBeenCalledWith("Unsupported command: wallet");
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("prints help", async () => {
    const log = vi.fn();
    const exit = vi.fn();
    const startProxy = vi.fn<NonNullable<CliRuntime["startProxy"]>>();

    await runCli(["--help"], {
      log,
      error: vi.fn(),
      exit,
      startProxy,
    });

    expect(log.mock.calls[0]?.[0]).toContain("deepseek-router-mini");
    expect(exit).toHaveBeenCalledWith(0);
  });
});
