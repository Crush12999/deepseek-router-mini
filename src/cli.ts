import { fileURLToPath } from "node:url";

import { DEFAULT_PORT } from "./config.js";
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
  port?: number;
  baseUrl?: string;
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
  return `xiaoyi-router v${VERSION}

Usage:
  xiaoyi-router                        Start the local proxy
  xiaoyi-router --port 9000            Listen on a custom port
  xiaoyi-router --base-url URL         Use a DeepSeek-compatible upstream API base URL

Options:
  --help, -h                            Show help
  --version, -v                         Show version
  --port <number>                       Local port, default ${DEFAULT_PORT}
  --base-url <url>                      Upstream API base URL

Environment:
  XIAOYI_API_KEY                        Upstream API key
  XIAOYI_BASE_URL                       Upstream API base URL
  XIAOYI_ROUTER_PORT                    Local proxy port
  XIAOYI_ROUTER_HEADERS                 Extra upstream headers as JSON`;
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

  // Start proxy
  const handle = await rt.startProxy({ port: args.port, baseUrl: args.baseUrl });
  rt.log(`xiaoyi-router listening on http://127.0.0.1:${handle.port}`);

  // Graceful shutdown
  const shutdown = async () => {
    rt.log("\nShutting down...");
    await handle.close();
    rt.exit(0);
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
