import { describe, it, expect } from "vitest";
import { resolveProxyConfig } from "../src/proxy-config-resolver.js";
import type { ProxyConfig, ProxyConfigOverrides } from "../src/proxy-config-resolver.js";

describe("resolveProxyConfig", () => {
  const baseConfig: ProxyConfig = {
    port: 3000,
    upstreamUrl: "https://api.example.com",
    apiKey: "base-key",
    headers: { "X-Base": "base-value", "X-Shared": "from-base" },
    trace: "off",
  };

  describe("基础配置（无覆盖）", () => {
    it("应原样返回 baseConfig 的所有字段", () => {
      const result = resolveProxyConfig(baseConfig);
      expect(result.port).toBe(3000);
      expect(result.upstreamUrl).toBe("https://api.example.com");
      expect(result.apiKey).toBe("base-key");
      expect(result.trace).toBe("off");
    });

    it("无覆盖时 headers 应与 baseConfig.headers 相同", () => {
      const result = resolveProxyConfig(baseConfig);
      expect(result.headers).toEqual({ "X-Base": "base-value", "X-Shared": "from-base" });
    });

    it("baseConfig 无 headers 时结果 headers 应为 undefined", () => {
      const config: ProxyConfig = { port: 8080, upstreamUrl: "https://api.example.com" };
      const result = resolveProxyConfig(config);
      expect(result.headers).toBeUndefined();
    });
  });

  describe("CLI flag 覆盖", () => {
    it("overrides.port 应覆盖 baseConfig.port", () => {
      const overrides: ProxyConfigOverrides = { port: 9000 };
      const result = resolveProxyConfig(baseConfig, overrides);
      expect(result.port).toBe(9000);
    });

    it("overrides.apiKey 应覆盖 baseConfig.apiKey", () => {
      const overrides: ProxyConfigOverrides = { apiKey: "cli-key" };
      const result = resolveProxyConfig(baseConfig, overrides);
      expect(result.apiKey).toBe("cli-key");
    });

    it("overrides.headers 应与 baseConfig.headers 合并，override 优先", () => {
      const overrides: ProxyConfigOverrides = {
        headers: { "X-Shared": "from-override", "X-New": "new-value" },
      };
      const result = resolveProxyConfig(baseConfig, overrides);
      expect(result.headers).toEqual({
        "X-Base": "base-value",
        "X-Shared": "from-override",
        "X-New": "new-value",
      });
    });
  });

  describe("插件 pluginConfig 覆盖", () => {
    it("pluginConfig.port 应覆盖 baseConfig.port", () => {
      const overrides: ProxyConfigOverrides = { port: 4000 };
      const result = resolveProxyConfig(baseConfig, overrides);
      expect(result.port).toBe(4000);
    });

    it("pluginConfig.upstreamUrl 应覆盖 baseConfig.upstreamUrl", () => {
      const overrides: ProxyConfigOverrides = { upstreamUrl: "https://plugin.example.com" };
      const result = resolveProxyConfig(baseConfig, overrides);
      expect(result.upstreamUrl).toBe("https://plugin.example.com");
    });
  });

  describe("覆盖优先级（CLI flag > 配置文件）", () => {
    it("overrides 中的 port 优先于 baseConfig.port", () => {
      const overrides: ProxyConfigOverrides = { port: 7777 };
      const result = resolveProxyConfig(baseConfig, overrides);
      expect(result.port).toBe(7777);
      // baseConfig.port 不应出现
      expect(result.port).not.toBe(baseConfig.port);
    });

    it("overrides 中的 trace 优先于 baseConfig.trace", () => {
      const overrides: ProxyConfigOverrides = { trace: "debug" };
      const result = resolveProxyConfig(baseConfig, overrides);
      expect(result.trace).toBe("debug");
    });

    it("overrides 未设置的字段应保留 baseConfig 的值", () => {
      const overrides: ProxyConfigOverrides = { port: 5000 };
      const result = resolveProxyConfig(baseConfig, overrides);
      expect(result.upstreamUrl).toBe(baseConfig.upstreamUrl);
      expect(result.apiKey).toBe(baseConfig.apiKey);
      expect(result.trace).toBe(baseConfig.trace);
    });
  });

  describe("headers 合并规则", () => {
    it("override headers 中的 key 覆盖 baseConfig headers 中相同的 key", () => {
      const overrides: ProxyConfigOverrides = { headers: { "X-Shared": "override-wins" } };
      const result = resolveProxyConfig(baseConfig, overrides);
      expect(result.headers?.["X-Shared"]).toBe("override-wins");
    });

    it("baseConfig headers 中未被覆盖的 key 应保留", () => {
      const overrides: ProxyConfigOverrides = { headers: { "X-New": "added" } };
      const result = resolveProxyConfig(baseConfig, overrides);
      expect(result.headers?.["X-Base"]).toBe("base-value");
      expect(result.headers?.["X-New"]).toBe("added");
    });

    it("baseConfig 无 headers 但 overrides 有 headers 时，结果应为 overrides.headers", () => {
      const config: ProxyConfig = { port: 8080, upstreamUrl: "https://api.example.com" };
      const overrides: ProxyConfigOverrides = { headers: { "X-Only": "override" } };
      const result = resolveProxyConfig(config, overrides);
      expect(result.headers).toEqual({ "X-Only": "override" });
    });

    it("两者均无 headers 时结果 headers 应为 undefined", () => {
      const config: ProxyConfig = { port: 8080, upstreamUrl: "https://api.example.com" };
      const result = resolveProxyConfig(config, {});
      expect(result.headers).toBeUndefined();
    });
  });
});
