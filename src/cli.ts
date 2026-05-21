import { fileURLToPath } from "node:url";

import { loadConfig } from "./config-loader.js";
import { resolveProxyConfig } from "./proxy-config-resolver.js";
import { startProxy as startProxyImpl, VERSION } from "./proxy.js";
import type { ProxyHandle, ProxyOptions } from "./proxy.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CliRuntime = {
  log: (msg: string) => void;
  error: (msg: string) => void;
  exit: (code: number) => void;
  onSignal: (signal: string, handler: () => void) => void;
  startProxy: (options: ProxyOptions) => Promise<ProxyHandle>;
};

export type ParsedArgs = {
  help: boolean;
  version: boolean;
  config?: string;
  port?: number;
  baseUrl?: string;
  apiKey?: string;
  unknown: string[];
};

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

export function parseArgs(rawArgs: string[]): ParsedArgs {
  const result: ParsedArgs = { help: false, version: false, unknown: [] };

  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i]!;

    switch (arg) {
      case "--help":
      case "-h":
        result.help = true;
        break;

      case "--version":
      case "-v":
        result.version = true;
        break;

      case "--port": {
        const val = rawArgs[++i];
        if (val === undefined) {
          result.unknown.push(arg);
          break;
        }
        const port = Number.parseInt(val, 10);
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          result.unknown.push(arg, val);
        } else {
          result.port = port;
        }
        break;
      }

      case "--config": {
        const val = rawArgs[++i];
        if (val === undefined) {
          result.unknown.push(arg);
        } else {
          result.config = val;
        }
        break;
      }

      case "--api-key": {
        const val = rawArgs[++i];
        if (val === undefined) {
          result.unknown.push(arg);
        } else {
          result.apiKey = val;
        }
        break;
      }

      case "--base-url": {
        const val = rawArgs[++i];
        if (val === undefined) {
          result.unknown.push(arg);
        } else {
          result.baseUrl = val;
        }
        break;
      }

      default:
        result.unknown.push(arg);
        break;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

function helpText(): string {
  return `llm-router v${VERSION}

Usage:
  llm-router --config <path>          Start the local proxy with config
  llm-router --config <path> --port 9000  Listen on a custom port

Options:
  --help, -h                            Show help
  --version, -v                         Show version
  --config <path>                       Configuration file path (required)
  --port <number>                       Override proxy port
  --api-key <key>                       Override API key
  --base-url <url>                      Override upstream API base URL`;
}

// ---------------------------------------------------------------------------
// Default runtime
// ---------------------------------------------------------------------------

const defaultRuntime: CliRuntime = {
  log: console.log,
  error: console.error,
  exit: (code) => process.exit(code),
  onSignal: (signal, handler) => process.on(signal, handler),
  startProxy: startProxyImpl,
};

// ---------------------------------------------------------------------------
// CLI execution
// ---------------------------------------------------------------------------

export async function runCli(rawArgs: string[], runtime: Partial<CliRuntime> = {}): Promise<void> {
  const rt: CliRuntime = { ...defaultRuntime, ...runtime };
  const args = parseArgs(rawArgs);

  // --help
  if (args.help) {
    rt.log(helpText());
    rt.exit(0);
    return;
  }

  // --version
  if (args.version) {
    rt.log(`v${VERSION}`);
    rt.exit(0);
    return;
  }

  // Unknown commands
  if (args.unknown.length > 0) {
    for (const cmd of args.unknown) {
      rt.error(`Unsupported command: ${cmd}`);
    }
    rt.exit(1);
    return;
  }

  // --config is required
  if (!args.config) {
    rt.error("Missing required argument: --config <path>");
    rt.exit(1);
    return;
  }

  // Load config from file
  const rawConfig = loadConfig({ kind: "file", path: args.config });

  // Resolve proxy config with CLI overrides
  const proxyConfig = resolveProxyConfig(rawConfig.proxy, {
    port: args.port,
    upstreamUrl: args.baseUrl,
    apiKey: args.apiKey,
  });
  const runtimeConfig = {
    ...rawConfig,
    proxy: proxyConfig,
  };

  // Start proxy
  const handle = await rt.startProxy({
    config: runtimeConfig,
  });
  rt.log(`llm-router listening on http://127.0.0.1:${handle.port}`);

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    /**
     * OS signals may arrive more than once (Ctrl+C spam, SIGTERM during SIGINT).
     * Only the first one should run `close()` so proxy shutdown remains idempotent;
     * later signals stay visible but do not duplicate resource cleanup.
     */
    if (shuttingDown) return;
    shuttingDown = true;
    rt.log("\nShutting down...");
    try {
      await handle.close();
      rt.exit(0);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      rt.error(`Shutdown failed: ${message}`);
      rt.exit(1);
    }
  };

  rt.onSignal("SIGINT", () => {
    void shutdown();
  });
  rt.onSignal("SIGTERM", () => {
    void shutdown();
  });
}

// ---------------------------------------------------------------------------
// Main detection
// ---------------------------------------------------------------------------

export function isMain(): boolean {
  return process.argv[1] === fileURLToPath(import.meta.url);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

if (isMain()) {
  void runCli(process.argv.slice(2));
}
