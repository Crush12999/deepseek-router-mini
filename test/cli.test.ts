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

    const help = log.mock.calls[0]?.[0] as string;
    expect(help).toContain("xiaoyi-router");
    expect(help).toMatch(/xiaoyi-router --base-url URL\s+Use a DeepSeek-compatible upstream API base URL/);
    expect(help).toMatch(/--base-url <url>\s+Upstream API base URL/);
    expect(help).toMatch(/XIAOYI_BASE_URL\s+Upstream API base URL/);
    expect(help).toMatch(/XIAOYI_ROUTER_PORT\s+Local proxy port/);
    expect(help).toMatch(/XIAOYI_ROUTER_HEADERS\s+Extra upstream headers as JSON/);
    expect(exit).toHaveBeenCalledWith(0);
  });
});
