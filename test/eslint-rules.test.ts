import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";

describe("ESLint rules - process.env restriction", () => {
  it("should reject dot notation access (process.env.KEY)", () => {
    try {
      execSync("npx eslint src/fixtures/test-process-env.ts", { encoding: "utf-8", stdio: "pipe" });
      throw new Error("Expected ESLint to fail but it passed");
    } catch (error: any) {
      const output = error.stdout || error.stderr || error.message;
      expect(output).toMatch(/no-restricted-syntax/);
      expect(output).toMatch(/不允许读取 process\.env/);
    }
  });

  it("should reject bracket notation access (process.env['KEY'])", () => {
    try {
      execSync("npx eslint src/fixtures/test-process-env.ts", { encoding: "utf-8", stdio: "pipe" });
      throw new Error("Expected ESLint to fail but it passed");
    } catch (error: any) {
      const output = error.stdout || error.stderr || error.message;
      // 验证捕获了多个违规（点号、单引号括号、双引号括号、解构）
      const matches = (output.match(/no-restricted-syntax/g) || []).length;
      expect(matches).toBeGreaterThanOrEqual(3); // 至少捕获 3 种形式
    }
  });

  it("should allow process.env in cli.ts", () => {
    // cli.ts 被排除，应该不报 process.env 错误
    const result = execSync("npx eslint src/cli.ts", { encoding: "utf-8", stdio: "pipe" });
    expect(result).not.toMatch(/不允许读取 process\.env/);
  });

  it("should reject process.env in non-cli files", () => {
    // 非 cli.ts 的文件应该被捕获
    try {
      execSync("npx eslint src/fixtures/test-cli-allowed.ts", { encoding: "utf-8", stdio: "pipe" });
      throw new Error("Expected ESLint to fail but it passed");
    } catch (error: any) {
      const output = error.stdout || error.stderr || error.message;
      expect(output).toMatch(/no-restricted-syntax/);
      expect(output).toMatch(/不允许读取 process\.env/);
    }
  });
});
