import { describe, expect, it, vi } from "vitest";
import path from "node:path";

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
    expect(help).toMatch(/--config <path>\s+Configuration file path/);
    expect(help).toMatch(/--api-key <key>\s+Override API key/);
    expect(help).toMatch(/--port <number>/);
    expect(exit).toHaveBeenCalledWith(0);
  });

  describe("--config argument parsing", () => {
    it("parses --config flag", () => {
      const args = parseArgs(["--config", "/path/to/config.json"]);
      expect(args.config).toBe("/path/to/config.json");
    });

    it("parses --api-key flag", () => {
      const args = parseArgs(["--api-key", "sk-test-123"]);
      expect(args.apiKey).toBe("sk-test-123");
    });

    it("parses --port override with --config", () => {
      const args = parseArgs(["--config", "c.json", "--port", "9000"]);
      expect(args.config).toBe("c.json");
      expect(args.port).toBe(9000);
    });

    it("parses all overrides together", () => {
      const args = parseArgs([
        "--config", "c.json",
        "--port", "3000",
        "--api-key", "sk-abc",
        "--base-url", "https://example.com",
      ]);
      expect(args).toMatchObject({
        config: "c.json",
        port: 3000,
        apiKey: "sk-abc",
        baseUrl: "https://example.com",
      });
    });
  });

  describe("--config required for proxy start", () => {
    const fixtureConfig = path.resolve(
      __dirname,
      "fixtures/minimal-config.json",
    );

    it("errors when --config is missing", async () => {
      const error = vi.fn();
      const exit = vi.fn();
      const startProxy = vi.fn<NonNullable<CliRuntime["startProxy"]>>();

      await runCli([], {
        log: vi.fn(),
        error,
        exit,
        startProxy,
      });

      expect(error).toHaveBeenCalledWith(
        expect.stringContaining("--config"),
      );
      expect(exit).toHaveBeenCalledWith(1);
      expect(startProxy).not.toHaveBeenCalled();
    });

    it("loads config and starts proxy", async () => {
      const log = vi.fn();
      const exit = vi.fn();
      const startProxy = vi.fn<NonNullable<CliRuntime["startProxy"]>>().mockResolvedValue({
        port: 8402,
        baseUrl: "https://api.deepseek.com",
        close: vi.fn(),
      });

      await runCli(["--config", fixtureConfig], {
        log,
        error: vi.fn(),
        exit,
        startProxy,
        onSignal: vi.fn(),
      });

      expect(startProxy).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            proxy: expect.objectContaining({ port: 8402 }),
          }),
        }),
      );
    });

    it("--api-key overrides config file apiKey", async () => {
      const startProxy = vi.fn<NonNullable<CliRuntime["startProxy"]>>().mockResolvedValue({
        port: 8402,
        baseUrl: "https://api.deepseek.com",
        close: vi.fn(),
      });

      await runCli(["--config", fixtureConfig, "--api-key", "sk-override"], {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
        startProxy,
        onSignal: vi.fn(),
      });

      expect(startProxy).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            proxy: expect.objectContaining({ apiKey: "sk-override" }),
          }),
        }),
      );
    });

    it("--port overrides config file port", async () => {
      const startProxy = vi.fn<NonNullable<CliRuntime["startProxy"]>>().mockResolvedValue({
        port: 9999,
        baseUrl: "https://api.deepseek.com",
        close: vi.fn(),
      });

      await runCli(["--config", fixtureConfig, "--port", "9999"], {
        log: vi.fn(),
        error: vi.fn(),
        exit: vi.fn(),
        startProxy,
        onSignal: vi.fn(),
      });

      expect(startProxy).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            proxy: expect.objectContaining({ port: 9999 }),
          }),
        }),
      );
    });
  });
});
