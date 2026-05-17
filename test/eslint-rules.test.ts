import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "..");

type ExecFailure = Error & {
  stdout?: string | Buffer;
  stderr?: string | Buffer;
};

function createTempSourceFile(prefix: string, source: string): string {
  const dir = mkdtempSync(path.join(repoRoot, "src", prefix));
  const filePath = path.join(dir, "fixture.ts");
  writeFileSync(filePath, source, "utf-8");
  return filePath;
}

function runEslint(filePath: string): string {
  return execFileSync("npx", ["eslint", path.relative(repoRoot, filePath)], {
    cwd: repoRoot,
    encoding: "utf-8",
    stdio: "pipe",
  });
}

function captureEslintFailure(filePath: string): string {
  try {
    runEslint(filePath);
    throw new Error("Expected ESLint to fail but it passed");
  } catch (error) {
    if (error instanceof Error && error.message === "Expected ESLint to fail but it passed") {
      throw error;
    }

    const failure = error as ExecFailure;
    return String(failure.stdout ?? failure.stderr ?? failure.message);
  }
}

describe("ESLint rules - process.env restriction", () => {
  it("should reject dot notation access (process.env.KEY)", () => {
    const filePath = createTempSourceFile(
      "__eslint-env-fixture-",
      [
        "const apiKey = process.env.API_KEY;",
        "const port = process.env['PORT'];",
        'const host = process.env["HOST"];',
        "const { NODE_ENV, DEBUG } = process.env;",
        "void apiKey;",
        "void port;",
        "void host;",
        "void NODE_ENV;",
        "void DEBUG;",
      ].join("\n"),
    );

    try {
      const output = captureEslintFailure(filePath);
      expect(output).toMatch(/no-restricted-syntax/);
      expect(output).toMatch(/不允许读取 process\.env/);
    } finally {
      rmSync(path.dirname(filePath), { recursive: true, force: true });
    }
  });

  it("should reject bracket notation access (process.env['KEY'])", () => {
    const filePath = createTempSourceFile(
      "__eslint-env-fixture-",
      [
        "const apiKey = process.env.API_KEY;",
        "const port = process.env['PORT'];",
        'const host = process.env["HOST"];',
        "const { NODE_ENV, DEBUG } = process.env;",
        "void apiKey;",
        "void port;",
        "void host;",
        "void NODE_ENV;",
        "void DEBUG;",
      ].join("\n"),
    );

    try {
      const output = captureEslintFailure(filePath);
      // 验证捕获了多个违规（点号、单引号括号、双引号括号、解构）
      const matches = (output.match(/no-restricted-syntax/g) || []).length;
      expect(matches).toBeGreaterThanOrEqual(3); // 至少捕获 3 种形式
    } finally {
      rmSync(path.dirname(filePath), { recursive: true, force: true });
    }
  });

  it("should allow process.env in cli.ts", () => {
    // cli.ts 被排除，应该不报 process.env 错误
    const result = execFileSync("npx", ["eslint", "src/cli.ts"], {
      cwd: repoRoot,
      encoding: "utf-8",
      stdio: "pipe",
    });
    expect(result).not.toMatch(/不允许读取 process\.env/);
  });

  it("should reject process.env in non-cli files", () => {
    // 非 cli.ts 的文件应该被捕获
    const filePath = createTempSourceFile(
      "__eslint-cli-fixture-",
      [
        "const args = process.argv;",
        "const env = process.env.NODE_ENV;",
        "void args;",
        "void env;",
      ].join("\n"),
    );

    try {
      const output = captureEslintFailure(filePath);
      expect(output).toMatch(/no-restricted-syntax/);
      expect(output).toMatch(/不允许读取 process\.env/);
    } finally {
      rmSync(path.dirname(filePath), { recursive: true, force: true });
    }
  });
});
