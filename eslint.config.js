import js from "@eslint/js";
import tseslint from "typescript-eslint";

const nodeGlobals = {
  Buffer: "readonly",
  console: "readonly",
  process: "readonly",
  RequestInit: "readonly",
  Response: "readonly",
  fetch: "readonly",
  setTimeout: "readonly",
};

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ["dist/**", "node_modules/**"],
  },
  {
    files: ["src/**/*.ts", "test/**/*.ts"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: nodeGlobals,
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
  {
    files: ["src/**/*.ts"],
    // 排除 cli.ts：CLI 入口需要读取 process.argv 和 process.env 来解析命令行参数
    // 其他所有 src 文件必须通过配置文件驱动，不允许直接读取环境变量
    ignores: ["src/cli.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "MemberExpression[object.name='process'][property.name='env']",
          message: "不允许读取 process.env，请使用配置文件驱动",
        },
      ],
    },
  },
);
