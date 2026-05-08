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
);
